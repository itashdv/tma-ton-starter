import { Cell } from '@ton/core'
import { describe, expect, it } from 'vitest'

import {
  fixtureAccountState,
  fixtureJettonMaster,
  fixtureTransaction,
  listFixtures,
  loadFixture,
} from '../../test/helpers/fixtures'
import { normalizeHash } from './hash'
import {
  accountStatesResponseSchema,
  jettonMastersResponseSchema,
  opcodeToNumber,
  transactionSchema,
  type ToncenterTransaction,
} from './toncenter.schemas'

/**
 * The fixtures are live testnet toncenter v3 responses. These tests pin the wire format the
 * listener is written against (string opcodes, decimal-string lt, "finalized"), so a schema
 * drift shows up here before it shows up as a stuck payment.
 */

const USDT_MASTER = '0:F418A04CF196EBC959366844A6CDF53A6FD6FFF1EADAFC892F05210BBA31593E'
const EMPTY_CELL_BOC = 'te6cckEBAQEAAgAAAEysuc0='

const OP_INTERNAL_TRANSFER = 0x178d4519
const OP_TRANSFER_NOTIFICATION = 0x7362d09c
const OP_EXCESSES = 0xd53276db
const OP_TEXT_COMMENT = 0

const REQUIRED = [
  'account-state-active',
  'jetton-master-usdt',
  'ton-text-comment',
  'jetton-internal-transfer-ref',
  'excesses',
  'empty-in-msg',
  'external-outgoing',
]
const NON_TRANSACTION = new Set(['account-state-active', 'jetton-master-usdt'])

const recorded = listFixtures()
const transactionFixtures = recorded.filter((name) => !NON_TRANSACTION.has(name))

function body(tx: ToncenterTransaction): string {
  const boc = tx.in_msg?.message_content?.body
  if (!boc) throw new Error('fixture has no in_msg body')
  return boc
}

/** Walks internal_transfer up to the forward payload and returns the comment stored there. */
function forwardComment(boc: string): { either: boolean; comment: string | null } {
  const slice = Cell.fromBase64(boc).beginParse()
  expect(slice.loadUint(32)).toBe(OP_INTERNAL_TRANSFER)
  slice.loadUintBig(64) // query_id
  slice.loadCoins() // amount
  slice.loadMaybeAddress() // from
  slice.loadMaybeAddress() // response_destination
  slice.loadCoins() // forward_ton_amount
  const either = slice.loadBit()
  const payload = either ? slice.loadRef().beginParse() : slice
  if (payload.remainingBits < 32 || payload.loadUint(32) !== OP_TEXT_COMMENT) {
    return { either, comment: null }
  }
  return { either, comment: payload.loadStringTail() }
}

describe('recorded fixtures', () => {
  it('include every fixture the listener tests depend on', () => {
    for (const name of REQUIRED) expect(recorded, `missing fixture ${name}`).toContain(name)
  })

  it.each(recorded)('%s is a testnet recording without credentials', (name) => {
    const envelope = loadFixture(name)
    expect(envelope.network).toBe('testnet')
    expect(Number.isNaN(Date.parse(envelope.recordedAt))).toBe(false)
    expect(envelope.source).toMatch(/^https:\/\/testnet\.toncenter\.com\/api\/v3\//)
    expect(envelope.source).not.toMatch(/api[_-]?key/i)
    expect(typeof envelope.note).toBe('string')
  })
})

describe('transaction fixtures', () => {
  it.each(transactionFixtures)('%s matches the live wire format', (name) => {
    const envelope = loadFixture(name)
    expect(envelope.source).toMatch(/\/transactions\?hash=[0-9a-f]{64}$/)
    const tx = transactionSchema.parse(
      (envelope.response as { transactions: unknown[] }).transactions[0],
    )
    expect(tx).toEqual(fixtureTransaction(name))
    expect(tx.finality).toBe('finalized')
    expect(tx.emulated).toBe(false)
    expect(typeof tx.mc_block_seqno).toBe('number')
    expect(tx.lt).toMatch(/^\d+$/)
    expect(normalizeHash(tx.hash)).toMatch(/^[0-9a-f]{64}$/)
    // The recording was looked up by this very hash, in hex.
    expect(envelope.source.endsWith(normalizeHash(tx.hash))).toBe(true)
    expect(tx.account).toMatch(/^-?\d+:[0-9A-F]{64}$/)
    expect(typeof tx.now).toBe('number')
    if (tx.in_msg?.opcode != null) expect(tx.in_msg.opcode).toMatch(/^0x[0-9a-f]{8}$/)
  })
})

/** Shape each fixture was recorded to exemplify; optional ones only run when recorded. */
const EXPECTATIONS: Record<string, (tx: ToncenterTransaction) => void> = {
  'jetton-internal-transfer-ref': (tx) => {
    expect(opcodeToNumber(tx.in_msg?.opcode)).toBe(OP_INTERNAL_TRANSFER)
    expect(tx.in_msg?.decoded_opcode).toBe('jetton_internal_transfer')
    expect(tx.description?.aborted).toBe(false)
    expect(tx.description?.compute_ph?.exit_code).toBe(0)
    expect(tx.in_msg?.source).not.toBe(USDT_MASTER)
    const payload = forwardComment(body(tx))
    expect(payload.either).toBe(true)
    expect(payload.comment).toBe('3279895699')
    // A successful internal_transfer notifies the owner and returns the excess.
    const outOpcodes = (tx.out_msgs ?? []).map((m) => opcodeToNumber(m.opcode))
    expect(outOpcodes).toContain(OP_TRANSFER_NOTIFICATION)
    expect(outOpcodes).toContain(OP_EXCESSES)
  },
  'jetton-internal-transfer-inline': (tx) => {
    expect(opcodeToNumber(tx.in_msg?.opcode)).toBe(OP_INTERNAL_TRANSFER)
    expect(tx.description?.aborted).toBe(false)
    const payload = forwardComment(body(tx))
    expect(payload.either).toBe(false)
    expect(payload.comment).not.toBeNull()
  },
  'jetton-internal-transfer-aborted': (tx) => {
    expect(opcodeToNumber(tx.in_msg?.opcode)).toBe(OP_INTERNAL_TRANSFER)
    expect(tx.description?.aborted).toBe(true)
  },
  'jetton-internal-transfer-from-master': (tx) => {
    expect(opcodeToNumber(tx.in_msg?.opcode)).toBe(OP_INTERNAL_TRANSFER)
    expect(tx.in_msg?.source).toBe(USDT_MASTER)
    expect(tx.description?.aborted).toBe(false)
    expect(forwardComment(body(tx))).toEqual({ either: false, comment: null })
  },
  'jetton-notify-on-main-wallet': (tx) => {
    expect(opcodeToNumber(tx.in_msg?.opcode)).toBe(OP_TRANSFER_NOTIFICATION)
    expect(tx.in_msg?.decoded_opcode).toBe('jetton_notify')
    expect(tx.in_msg?.source).toMatch(/^0:[0-9A-F]{64}$/)
    // Forwarded with 1 nanoTON, so the owner wallet's compute phase is skipped: `aborted`
    // on the owner side says nothing about the jetton transfer itself.
    expect(tx.in_msg?.value).toBe('1')
    expect(tx.description?.aborted).toBe(true)
    expect(tx.description?.compute_ph?.skipped).toBe(true)
  },
  'jetton-notify-foreign-on-main-wallet': (tx) => {
    expect(opcodeToNumber(tx.in_msg?.opcode)).toBe(OP_TRANSFER_NOTIFICATION)
    expect(tx.in_msg?.source).toMatch(/^0:[0-9A-F]{64}$/)
    expect(tx.description?.aborted).toBe(false)
  },
  excesses: (tx) => {
    expect(opcodeToNumber(tx.in_msg?.opcode)).toBe(OP_EXCESSES)
    expect(tx.in_msg?.decoded_opcode).toBe('excess')
    expect(tx.description?.aborted).toBe(false)
    expect(BigInt(tx.in_msg?.value ?? '0')).toBeGreaterThan(0n)
  },
  'ton-text-comment': (tx) => {
    expect(tx.in_msg?.opcode).toBe('0x00000000')
    expect(opcodeToNumber(tx.in_msg?.opcode)).toBe(OP_TEXT_COMMENT)
    expect(tx.in_msg?.decoded_opcode).toBe('text_comment')
    expect(tx.in_msg?.source).toMatch(/^0:[0-9A-F]{64}$/)
    expect(tx.description?.aborted).toBe(false)
    expect(BigInt(tx.in_msg?.value ?? '0')).toBeGreaterThan(0n)
    const slice = Cell.fromBase64(body(tx)).beginParse()
    expect(slice.loadUint(32)).toBe(OP_TEXT_COMMENT)
    expect(slice.loadStringTail()).toBe('https://t.me/testgiver_ton_bot')
  },
  'ton-empty-body': (tx) => {
    expect(tx.in_msg?.opcode ?? null).toBeNull()
    expect(opcodeToNumber(tx.in_msg?.opcode)).toBeNull()
    expect(tx.in_msg?.source).toMatch(/^0:[0-9A-F]{64}$/)
    expect(BigInt(tx.in_msg?.value ?? '0')).toBeGreaterThan(0n)
    expect(tx.in_msg?.message_content?.body).toBe(EMPTY_CELL_BOC)
    expect(Cell.fromBase64(EMPTY_CELL_BOC).bits.length).toBe(0)
    expect(tx.description?.aborted).toBe(false)
  },
  'external-outgoing': (tx) => {
    expect(tx.in_msg?.source).toBeNull()
    expect(tx.in_msg?.value ?? null).toBeNull()
    expect(tx.out_msgs?.length).toBeGreaterThan(0)
    for (const out of tx.out_msgs ?? []) expect(out.source).toBe(tx.account)
    expect(tx.description?.aborted).toBe(false)
  },
  'empty-in-msg': (tx) => {
    expect(tx.description?.type).toBe('tick_tock')
    expect(tx.in_msg ?? {}).toEqual({})
    expect(opcodeToNumber(tx.in_msg?.opcode)).toBeNull()
    expect(tx.account).toMatch(/^-1:/)
  },
}

describe('fixture-specific shapes', () => {
  it('cover every recorded transaction fixture', () => {
    for (const name of transactionFixtures) expect(Object.keys(EXPECTATIONS)).toContain(name)
  })

  it.each(Object.keys(EXPECTATIONS).filter((name) => recorded.includes(name)))('%s', (name) => {
    EXPECTATIONS[name]?.(fixtureTransaction(name))
  })
})

describe('account and jetton master fixtures', () => {
  it('account-state-active is an active account with digit-string lt', () => {
    const response = accountStatesResponseSchema.parse(loadFixture('account-state-active').response)
    expect(response.accounts).toHaveLength(1)
    const account = fixtureAccountState()
    expect(account.address).toBe(USDT_MASTER)
    expect(account.status).toBe('active')
    expect(account.last_transaction_lt).toMatch(/^\d+$/)
    expect(account.balance).toMatch(/^\d+$/)
    expect(account.last_transaction_hash).toBeTruthy()
    expect(normalizeHash(account.last_transaction_hash ?? '')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('jetton-master-usdt describes the 6-decimal master', () => {
    const response = jettonMastersResponseSchema.parse(loadFixture('jetton-master-usdt').response)
    expect(response.jetton_masters).toHaveLength(1)
    const master = fixtureJettonMaster()
    expect(master.address).toBe(USDT_MASTER)
    expect(Number(master.jetton_content?.decimals)).toBe(6)
    expect(master.total_supply).toMatch(/^\d+$/)
  })
})
