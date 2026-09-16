import { Address, Cell } from '@ton/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  fakeJettonWalletFor,
  startFakeToncenter,
  type FakeToncenter,
} from '../../test/helpers/fake-toncenter'
import {
  TONCENTER_POLICIES,
  ToncenterError,
  backoffDelay,
  createToncenterClient,
} from './toncenter'
import { isFinalizedValue, opcodeToNumber, transactionSchema } from './toncenter.schemas'

const MASTER = Address.parseRaw(`0:${'33'.repeat(32)}`)
const OWNER = Address.parseRaw(`0:${'11'.repeat(32)}`)
const OTHER_OWNER = Address.parseRaw(`0:${'44'.repeat(32)}`)
const WALLET = fakeJettonWalletFor(OWNER)

let fake: FakeToncenter
const slept: number[] = []

beforeEach(async () => {
  fake = await startFakeToncenter()
  slept.length = 0
})

afterEach(async () => {
  await fake.close()
})

function client(policy: 'request' | 'worker' = 'request', apiKey = 'test-key') {
  return createToncenterClient({
    baseUrl: fake.url,
    apiKey,
    policy,
    sleep: async (ms) => {
      slept.push(ms)
    },
    random: () => 0.5,
  })
}

describe('request headers', () => {
  it('sends the API key and an explicit user agent', async () => {
    await client().getJettonWalletAddress(MASTER, OWNER)
    const request = fake.requests.at(-1)
    expect(request?.headers['x-api-key']).toBe('test-key')
    expect(request?.headers['user-agent']).toBe('tma-ton-starter/0.1')
    expect(request?.headers['content-type']).toBe('application/json')
  })

  it('omits the key header when no key is configured', async () => {
    await client('request', '').getJettonWalletAddress(MASTER, OWNER)
    expect(fake.requests.at(-1)?.headers['x-api-key']).toBeUndefined()
  })
})

describe('get_wallet_address', () => {
  it('asks the master for the OWNER wallet and decodes the returned cell', async () => {
    const address = await client().getJettonWalletAddress(MASTER, OWNER)
    expect(address.equals(WALLET)).toBe(true)
    const body = fake.requests.at(-1)?.body as {
      address: string
      method: string
      stack: { type: string; value: string }[]
    }
    expect(body.method).toBe('get_wallet_address')
    expect(body.address).toBe(MASTER.toRawString())
    expect(body.stack).toHaveLength(1)
    expect(body.stack[0]?.type).toBe('slice')
    // Decoding the argument is what catches passing the master (or anyone else) as the owner.
    const sentOwner = Cell.fromBase64(body.stack[0]?.value ?? '')
      .beginParse()
      .loadAddress()
    expect(sentOwner.equals(OWNER)).toBe(true)
    expect(sentOwner.equals(MASTER)).toBe(false)
  })

  it('returns a different wallet for a different owner', async () => {
    const first = await client().getJettonWalletAddress(MASTER, OWNER)
    const second = await client().getJettonWalletAddress(MASTER, OTHER_OWNER)
    expect(second.equals(fakeJettonWalletFor(OTHER_OWNER))).toBe(true)
    expect(first.equals(second)).toBe(false)
  })

  it('reports a non-zero exit code as a contract error', async () => {
    fake.setJettonWallet(null)
    await expect(client().getJettonWalletAddress(MASTER, OWNER)).rejects.toMatchObject({
      kind: 'contract',
    })
  })

  it('reports an unreadable stack item', async () => {
    fake.enqueue('/runGetMethod', {
      kind: 'json',
      body: { exit_code: 0, stack: [{ type: 'cell', value: 'zzz' }] },
    })
    await expect(client().getJettonWalletAddress(MASTER, OWNER)).rejects.toMatchObject({
      kind: 'schema',
    })
  })
})

describe('retry policies', () => {
  it('retries 429 and succeeds on the second attempt', async () => {
    fake.enqueue('/runGetMethod', { kind: 'status', status: 429, body: 'Ratelimit exceed' })
    const address = await client('worker').getJettonWalletAddress(MASTER, OWNER)
    expect(address.equals(WALLET)).toBe(true)
    expect(slept).toHaveLength(1)
    expect(slept[0]).toBeGreaterThan(0)
  })

  it('gives up after the worker policy attempts', async () => {
    for (let i = 0; i < 5; i += 1) fake.enqueue('/runGetMethod', { kind: 'status', status: 429 })
    const error = await client('worker')
      .getJettonWalletAddress(MASTER, OWNER)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ToncenterError)
    expect((error as ToncenterError).kind).toBe('http')
    expect((error as ToncenterError).status).toBe(429)
    expect(slept).toHaveLength(4)
    expect(slept.at(-1)).toBeGreaterThan(slept[0] ?? 0)
  })

  it('grows the backoff exponentially and caps it at the policy maximum', () => {
    const worker = TONCENTER_POLICIES.worker
    expect(backoffDelay(worker, 1, 1)).toBe(worker.baseDelayMs)
    expect(backoffDelay(worker, 2, 1)).toBe(worker.baseDelayMs * 2)
    expect(backoffDelay(worker, 3, 1)).toBe(worker.baseDelayMs * 4)
    // Without the cap this would be ~34 minutes.
    expect(backoffDelay(worker, 12, 1)).toBe(worker.maxDelayMs)
    // Jitter never drops below half of the delay and never exceeds it.
    expect(backoffDelay(worker, 12, 0)).toBe(worker.maxDelayMs / 2)
    expect(backoffDelay(TONCENTER_POLICIES.request, 9, 1)).toBe(
      TONCENTER_POLICIES.request.maxDelayMs,
    )
  })

  it('uses only two attempts and short pauses for a request', async () => {
    fake.enqueue('/transactions', { kind: 'status', status: 500 })
    fake.enqueue('/transactions', { kind: 'status', status: 500 })
    await expect(client().getTransactions({ account: '0:AA', limit: 10 })).rejects.toMatchObject({
      kind: 'http',
      status: 500,
    })
    expect(slept).toHaveLength(1)
    expect(slept[0]).toBeLessThanOrEqual(200)
  })

  it('does not retry a client error', async () => {
    fake.enqueue('/transactions', { kind: 'status', status: 422, body: 'limit is not allowed' })
    await expect(
      client('worker').getTransactions({ account: '0:AA', limit: 10 }),
    ).rejects.toMatchObject({
      status: 422,
    })
    expect(slept).toHaveLength(0)
  })

  it('treats a blocked request differently from an API 403 and never retries it', async () => {
    fake.enqueue('/transactions', { kind: 'status', status: 403, body: 'error code: 1010' })
    await expect(
      client('worker').getTransactions({ account: '0:AA', limit: 10 }),
    ).rejects.toMatchObject({
      kind: 'blocked',
    })
    expect(slept).toHaveLength(0)

    fake.enqueue('/transactions', {
      kind: 'status',
      status: 403,
      body: '{"error":"wrong network"}',
    })
    await expect(
      client('worker').getTransactions({ account: '0:AA', limit: 10 }),
    ).rejects.toMatchObject({
      kind: 'http',
      status: 403,
    })
  })

  it('aborts a hanging request and reports a timeout', async () => {
    fake.enqueue('/transactions', { kind: 'hang' })
    fake.enqueue('/transactions', { kind: 'hang' })
    // The timeout is injectable, so this asserts the behaviour without waiting seconds.
    const fast = createToncenterClient({
      baseUrl: fake.url,
      policy: 'request',
      timeoutMs: 50,
      sleep: async () => {},
      random: () => 0.5,
    })
    const error = await fast
      .getTransactions({ account: '0:AA', limit: 10 })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ToncenterError)
    expect((error as ToncenterError).kind).toBe('timeout')
    // Both attempts of the request policy were spent before giving up.
    expect((error as ToncenterError).attempts).toBe(TONCENTER_POLICIES.request.attempts)
  })
})

describe('query building', () => {
  it('passes the paging window as toncenter expects', async () => {
    fake.setTransactions([])
    await client().getTransactions({
      account: '0:AA',
      startLt: 10n ** 18n,
      limit: 100,
      offset: 100,
    })
    const query = fake.requests.at(-1)?.query
    expect(query?.get('account')).toBe('0:AA')
    expect(query?.get('start_lt')).toBe('1000000000000000000')
    expect(query?.get('limit')).toBe('100')
    expect(query?.get('offset')).toBe('100')
    expect(query?.get('sort')).toBe('asc')
  })
})

describe('response schemas', () => {
  it('accept the live wire shapes', () => {
    const row = transactionSchema.parse({
      account: '0:AA',
      hash: 'PvU+DXisBC/Ig3qLRuLdlEtnRLTxqZUGCCiGIpBMIPQ=',
      lt: '57501899000003',
      now: 1789451411,
      mc_block_seqno: 92816994,
      emulated: false,
      finality: 'finalized',
      description: { type: 'ord', aborted: false, compute_ph: { success: true, exit_code: 0 } },
      in_msg: {
        source: '0:BB',
        destination: '0:AA',
        value: '1500000000',
        opcode: '0x00000000',
        decoded_opcode: 'text_comment',
        bounce: false,
        bounced: false,
        message_content: { body: 'te6cc', decoded: { type: 'text_comment', comment: 'abc' } },
      },
      new_indexer_field: 'ignored',
    })
    expect(row.lt).toBe('57501899000003')
    expect(isFinalizedValue(row.finality)).toBe(true)
    expect(opcodeToNumber(row.in_msg?.opcode)).toBe(0)

    // tick-tock transactions carry an empty in_msg
    expect(() =>
      transactionSchema.parse({ account: '0:AA', hash: 'h', lt: '1', now: 1, in_msg: {} }),
    ).not.toThrow()
  })

  it('normalise finality and opcode in both wire forms', () => {
    expect(isFinalizedValue('finalized')).toBe(true)
    expect(isFinalizedValue(2)).toBe(true)
    expect(isFinalizedValue('confirmed')).toBe(false)
    expect(isFinalizedValue(null)).toBe(false)
    expect(opcodeToNumber('0x7362d09c')).toBe(0x7362d09c)
    expect(opcodeToNumber(0)).toBe(0)
    expect(opcodeToNumber(null)).toBeNull()
    expect(opcodeToNumber('nope')).toBeNull()
  })

  it('rejects a response whose shape changed', async () => {
    fake.enqueue('/transactions', { kind: 'json', body: { transactions: [{ account: 1 }] } })
    await expect(client().getTransactions({ account: '0:AA', limit: 10 })).rejects.toMatchObject({
      kind: 'schema',
    })
  })
})

describe('other endpoints', () => {
  it('reads an account state and a jetton master', async () => {
    const state = await client().getAccountState(`0:${'11'.repeat(32)}`)
    expect(state?.status).toBe('active')
    expect(state?.last_transaction_lt).toBe('100')
    const master = await client().getJettonMaster(`0:${'33'.repeat(32)}`)
    expect(master?.jetton_content?.decimals).toBe('6')
  })

  it('returns null when the account is unknown', async () => {
    fake.setAccountState(null)
    expect(await client().getAccountState('0:AA')).toBeNull()
  })
})
