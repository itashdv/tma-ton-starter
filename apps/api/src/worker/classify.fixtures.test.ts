import { describe, expect, it } from 'vitest'

import { fixtureTransaction, listFixtures } from '../../test/helpers/fixtures'
import { rawAddress } from '../../test/helpers/tx-factory'
import { classifyTransaction, type ClassifyContext } from './classify'
import { isFinal } from './finality'

/**
 * The same rules against rows recorded from the live testnet indexer. Each fixture is
 * classified from the point of view of the account it happened on, so the context is derived
 * from the row itself. Optional fixtures are skipped when they were not recorded.
 */

const TESTNET_USDT_MASTER = '0:F418A04CF196EBC959366844A6CDF53A6FD6FFF1EADAFC892F05210BBA31593E'
const recorded = new Set(listFixtures())

function ifRecorded(name: string) {
  return recorded.has(name) ? it : it.skip
}

function sourceOf(name: string): string {
  const source = fixtureTransaction(name).in_msg?.source
  if (!source) throw new Error(`${name}: no in_msg.source`)
  return source
}

function mainWalletCtx(
  name: string,
  jettonWallet: string | null = rawAddress('bb'),
): ClassifyContext {
  return {
    merchantRaw: fixtureTransaction(name).account,
    merchantJettonWalletRaw: jettonWallet,
    usdtMasterRaw: TESTNET_USDT_MASTER,
    minRecordNano: 1_000_000n,
  }
}

function jettonWalletCtx(name: string): ClassifyContext {
  return {
    merchantRaw: rawAddress('aa'),
    merchantJettonWalletRaw: fixtureTransaction(name).account,
    usdtMasterRaw: TESTNET_USDT_MASTER,
    minRecordNano: 1_000_000n,
  }
}

describe('live fixtures are final', () => {
  it('every recorded transaction passes the finality gate', () => {
    const names = [...recorded].filter(
      (name) => !name.startsWith('account-state') && !name.startsWith('jetton-master'),
    )
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) expect(isFinal(fixtureTransaction(name)), name).toBe(true)
  })
})

describe('classify: live main-wallet rows', () => {
  ifRecorded('ton-text-comment')(
    'text comment transfer is a TON candidate with the decoded comment',
    () => {
      const tx = fixtureTransaction('ton-text-comment')
      const result = classifyTransaction(tx, mainWalletCtx('ton-text-comment'))
      expect(result).toMatchObject({
        kind: 'candidate',
        currency: 'TON',
        amount: BigInt(tx.in_msg?.value ?? '0'),
        sender: tx.in_msg?.source,
        abortedNonBounceable: false,
      })
      expect(typeof (result as { comment: unknown }).comment).toBe('string')
    },
  )

  ifRecorded('ton-empty-body')('empty body transfer is a TON candidate without a comment', () => {
    const tx = fixtureTransaction('ton-empty-body')
    expect(classifyTransaction(tx, mainWalletCtx('ton-empty-body'))).toMatchObject({
      kind: 'candidate',
      currency: 'TON',
      comment: null,
      amount: BigInt(tx.in_msg?.value ?? '0'),
    })
  })

  ifRecorded('jetton-notify-on-main-wallet')(
    'notification from the merchant jetton wallet is skipped, from any other wallet it is recorded',
    () => {
      const name = 'jetton-notify-on-main-wallet'
      const tx = fixtureTransaction(name)
      expect(classifyTransaction(tx, mainWalletCtx(name, sourceOf(name)))).toEqual({
        kind: 'skip',
        why: 'own_jetton_notification',
      })
      const foreign = classifyTransaction(tx, mainWalletCtx(name, rawAddress('bb')))
      expect(foreign).toMatchObject({
        kind: 'ignored',
        reason: 'unsupported_asset',
        currency: null,
        sourceWallet: sourceOf(name),
      })
      expect((foreign as { amount: bigint }).amount).toBeGreaterThan(0n)
    },
  )

  ifRecorded('jetton-notify-foreign-on-main-wallet')(
    'notification of a foreign jetton is recorded with its source wallet for a refund',
    () => {
      const name = 'jetton-notify-foreign-on-main-wallet'
      const result = classifyTransaction(fixtureTransaction(name), mainWalletCtx(name))
      expect(result).toMatchObject({
        kind: 'ignored',
        reason: 'unsupported_asset',
        currency: null,
        jettonMaster: null,
        sourceWallet: sourceOf(name),
      })
      expect((result as { amount: bigint }).amount).toBeGreaterThan(0n)
      expect((result as { sender: string | null }).sender).toMatch(/^0:[0-9A-F]{64}$/)
    },
  )

  ifRecorded('excesses')('excesses are skipped', () => {
    expect(classifyTransaction(fixtureTransaction('excesses'), mainWalletCtx('excesses'))).toEqual({
      kind: 'skip',
      why: 'excesses',
    })
  })

  ifRecorded('external-outgoing')('the owner own outgoing transfer is skipped', () => {
    expect(
      classifyTransaction(
        fixtureTransaction('external-outgoing'),
        mainWalletCtx('external-outgoing'),
      ),
    ).toEqual({ kind: 'skip', why: 'external' })
  })

  ifRecorded('empty-in-msg')('a tick-tock row without an inbound message is skipped', () => {
    expect(
      classifyTransaction(fixtureTransaction('empty-in-msg'), mainWalletCtx('empty-in-msg')),
    ).toEqual({ kind: 'skip', why: 'no_in_msg' })
  })
})

describe('classify: live jetton-wallet rows', () => {
  ifRecorded('jetton-internal-transfer-ref')(
    'internal_transfer with a referenced comment is a USDT candidate',
    () => {
      const name = 'jetton-internal-transfer-ref'
      const result = classifyTransaction(fixtureTransaction(name), jettonWalletCtx(name))
      expect(result).toMatchObject({
        kind: 'candidate',
        currency: 'USDT',
        jettonMaster: TESTNET_USDT_MASTER,
        abortedNonBounceable: false,
      })
      const candidate = result as { amount: bigint; comment: string | null; sender: string | null }
      expect(candidate.amount).toBeGreaterThan(0n)
      expect(candidate.comment).toBe('3279895699')
      expect(candidate.sender).toMatch(/^0:[0-9A-F]{64}$/)
    },
  )

  ifRecorded('jetton-internal-transfer-inline')(
    'internal_transfer with an inline comment is a USDT candidate',
    () => {
      const name = 'jetton-internal-transfer-inline'
      const result = classifyTransaction(fixtureTransaction(name), jettonWalletCtx(name))
      expect(result).toMatchObject({ kind: 'candidate', currency: 'USDT' })
      expect(typeof (result as { comment: unknown }).comment).toBe('string')
    },
  )

  ifRecorded('jetton-internal-transfer-aborted')('an aborted internal_transfer is skipped', () => {
    const name = 'jetton-internal-transfer-aborted'
    expect(classifyTransaction(fixtureTransaction(name), jettonWalletCtx(name))).toEqual({
      kind: 'skip',
      why: 'failed',
    })
  })

  ifRecorded('jetton-internal-transfer-from-master')('a mint from the master is ignored', () => {
    const name = 'jetton-internal-transfer-from-master'
    expect(sourceOf(name)).toBe(TESTNET_USDT_MASTER)
    expect(classifyTransaction(fixtureTransaction(name), jettonWalletCtx(name))).toMatchObject({
      kind: 'ignored',
      reason: 'from_master',
      currency: 'USDT',
      jettonMaster: TESTNET_USDT_MASTER,
      sourceWallet: TESTNET_USDT_MASTER,
    })
  })

  ifRecorded('jetton-internal-transfer-ref')(
    'the same row on the main wallet is not a credit event',
    () => {
      const name = 'jetton-internal-transfer-ref'
      const tx = fixtureTransaction(name)
      expect(classifyTransaction(tx, mainWalletCtx(name))).toEqual({
        kind: 'skip',
        why: 'internal_transfer_on_wallet',
      })
    },
  )
})
