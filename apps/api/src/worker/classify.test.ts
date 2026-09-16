import { OP_JETTON_INTERNAL_TRANSFER, buildCommentCell } from '@tma/shared/ton'
import { Address, beginCell } from '@ton/core'
import { describe, expect, it } from 'vitest'

import {
  aborted,
  bounced,
  excesses,
  externalOutgoing,
  jettonInternalTransfer,
  jettonNotification,
  rawAddress,
  tickTock,
  tonTransfer,
  withActionSuccess,
  withBody,
  withComputeSuccess,
  withSource,
  withValue,
} from '../../test/helpers/tx-factory'
import { classifyTransaction, isUsableComment, type ClassifyContext } from './classify'

const MERCHANT = rawAddress('aa')
const JETTON_WALLET = rawAddress('bb')
const MASTER = rawAddress('cc')
const PAYER = rawAddress('11')
const PAYER_JETTON_WALLET = rawAddress('22')
const FOREIGN_JETTON_WALLET = rawAddress('99')
const ORDER_ID = '0123456789abcdef'

const ctx: ClassifyContext = {
  merchantRaw: MERCHANT,
  merchantJettonWalletRaw: JETTON_WALLET,
  usdtMasterRaw: MASTER,
  minRecordNano: 1_000_000n,
}

describe('main wallet: TON transfers', () => {
  it('turns a text-comment transfer into a TON candidate with sender and comment', () => {
    const result = classifyTransaction(
      tonTransfer({ account: MERCHANT, source: PAYER, value: 1_500_000_000n, comment: ORDER_ID }),
      ctx,
    )
    expect(result).toEqual({
      kind: 'candidate',
      currency: 'TON',
      jettonMaster: null,
      amount: 1_500_000_000n,
      sender: PAYER,
      comment: ORDER_ID,
      abortedNonBounceable: false,
    })
  })

  it('keeps the comment exactly as received; normalisation happens at matching time', () => {
    const result = classifyTransaction(
      tonTransfer({ account: MERCHANT, comment: `  ${ORDER_ID.toUpperCase()} ` }),
      ctx,
    )
    expect(result).toMatchObject({ kind: 'candidate', comment: `  ${ORDER_ID.toUpperCase()} ` })
    expect(isUsableComment(`  ${ORDER_ID.toUpperCase()} `)).toBe(true)
    expect(isUsableComment('thanks')).toBe(false)
    expect(isUsableComment(null)).toBe(false)
  })

  it('records a transfer without a comment above the dust threshold as a candidate without comment', () => {
    const empty = classifyTransaction(tonTransfer({ account: MERCHANT, value: 2_000_000n }), ctx)
    expect(empty).toMatchObject({ kind: 'candidate', currency: 'TON', comment: null })
    const unrelated = classifyTransaction(
      tonTransfer({ account: MERCHANT, value: 2_000_000n, comment: 'thanks' }),
      ctx,
    )
    expect(unrelated).toMatchObject({ kind: 'candidate', comment: 'thanks' })
  })

  it('skips dust without a usable comment but keeps dust that names an order', () => {
    expect(classifyTransaction(tonTransfer({ account: MERCHANT, value: 999_999n }), ctx)).toEqual({
      kind: 'skip',
      why: 'dust',
    })
    expect(
      classifyTransaction(tonTransfer({ account: MERCHANT, value: 999_999n, comment: 'hi' }), ctx),
    ).toEqual({ kind: 'skip', why: 'dust' })
    expect(
      classifyTransaction(tonTransfer({ account: MERCHANT, value: 1n, comment: ORDER_ID }), ctx),
    ).toMatchObject({ kind: 'candidate', amount: 1n, comment: ORDER_ID })
    // Exactly the threshold is recorded.
    expect(
      classifyTransaction(tonTransfer({ account: MERCHANT, value: 1_000_000n }), ctx),
    ).toMatchObject({ kind: 'candidate' })
  })

  it('skips bounced messages and bounceable transfers that aborted (funds went back)', () => {
    const base = tonTransfer({ account: MERCHANT, comment: ORDER_ID })
    expect(classifyTransaction(bounced(base), ctx)).toEqual({ kind: 'skip', why: 'bounced' })
    expect(classifyTransaction(aborted(base, { bounce: true }), ctx)).toEqual({
      kind: 'skip',
      why: 'bounced_back',
    })
    // An aborted transaction whose bounce flag is unknown might have returned the value.
    const unknownFlag = aborted(base)
    if (unknownFlag.in_msg) unknownFlag.in_msg.bounce = null
    expect(classifyTransaction(unknownFlag, ctx)).toEqual({ kind: 'skip', why: 'bounced_back' })
    if (unknownFlag.in_msg) delete unknownFlag.in_msg.bounce
    expect(classifyTransaction(unknownFlag, ctx)).toEqual({ kind: 'skip', why: 'bounced_back' })
  })

  it('credits a non-bounceable transfer that aborted (uninitialised wallet) and flags it', () => {
    const result = classifyTransaction(
      aborted(tonTransfer({ account: MERCHANT, comment: ORDER_ID, bounce: false }), {
        bounce: false,
      }),
      ctx,
    )
    expect(result).toMatchObject({
      kind: 'candidate',
      comment: ORDER_ID,
      abortedNonBounceable: true,
    })
  })

  it('skips external messages, empty in_msg rows and excesses', () => {
    expect(classifyTransaction(externalOutgoing({ account: MERCHANT }), ctx)).toEqual({
      kind: 'skip',
      why: 'external',
    })
    expect(classifyTransaction(tickTock({ account: MERCHANT }), ctx)).toEqual({
      kind: 'skip',
      why: 'no_in_msg',
    })
    expect(
      classifyTransaction(excesses({ account: MERCHANT, source: JETTON_WALLET }), ctx),
    ).toEqual({ kind: 'skip', why: 'excesses' })
    expect(
      classifyTransaction(excesses({ account: MERCHANT, source: FOREIGN_JETTON_WALLET }), ctx),
    ).toEqual({ kind: 'skip', why: 'excesses' })
  })

  it('records an unknown body above the threshold and skips it below', () => {
    const unknown = withBody(
      tonTransfer({ account: MERCHANT, value: 5_000_000n }),
      beginCell().storeUint(0x2167da4b, 32).storeStringTail('?').endCell(),
    )
    expect(classifyTransaction(unknown, ctx)).toEqual({
      kind: 'ignored',
      reason: 'unknown_layout',
      currency: 'TON',
      jettonMaster: null,
      sourceWallet: null,
      amount: 5_000_000n,
      sender: PAYER,
      comment: null,
    })
    expect(classifyTransaction(withValue(unknown, 10n), ctx)).toEqual({ kind: 'skip', why: 'dust' })
    // A body shorter than an opcode is neither a comment nor empty.
    const stub = withBody(
      tonTransfer({ account: MERCHANT, value: 5_000_000n }),
      beginCell().storeUint(1, 8).endCell(),
    )
    expect(classifyTransaction(stub, ctx)).toMatchObject({
      kind: 'ignored',
      reason: 'unknown_layout',
    })
  })

  it('skips an internal_transfer addressed to the plain wallet', () => {
    const tx = withBody(
      tonTransfer({ account: MERCHANT, value: 50_000_000n }),
      beginCell().storeUint(OP_JETTON_INTERNAL_TRANSFER, 32).storeUint(1n, 64).endCell(),
    )
    expect(classifyTransaction(tx, ctx)).toEqual({
      kind: 'skip',
      why: 'internal_transfer_on_wallet',
    })
  })
})

describe('main wallet: jetton notifications', () => {
  it('skips the notification from the merchant jetton wallet even with a valid comment', () => {
    const own = jettonNotification({
      account: MERCHANT,
      source: JETTON_WALLET,
      sender: PAYER,
      comment: ORDER_ID,
    })
    expect(classifyTransaction(own, ctx)).toEqual({ kind: 'skip', why: 'own_jetton_notification' })
    // Also when it was not aborted (enough forward TON to run the wallet code).
    expect(
      classifyTransaction({ ...own, description: { type: 'ord', aborted: false } }, ctx),
    ).toEqual({ kind: 'skip', why: 'own_jetton_notification' })
  })

  it('records a notification from any other jetton wallet as an unsupported asset with the source wallet', () => {
    const foreign = jettonNotification({
      account: MERCHANT,
      source: FOREIGN_JETTON_WALLET,
      amount: 7_500_000n,
      sender: PAYER,
      comment: ORDER_ID,
    })
    expect(classifyTransaction(foreign, ctx)).toEqual({
      kind: 'ignored',
      reason: 'unsupported_asset',
      currency: null,
      jettonMaster: null,
      sourceWallet: FOREIGN_JETTON_WALLET,
      amount: 7_500_000n,
      sender: PAYER,
      comment: ORDER_ID,
    })
  })

  it('treats every notification as foreign when USDT is disabled', () => {
    const noUsdt: ClassifyContext = { ...ctx, merchantJettonWalletRaw: null, usdtMasterRaw: null }
    const own = jettonNotification({ account: MERCHANT, source: JETTON_WALLET, sender: PAYER })
    expect(classifyTransaction(own, noUsdt)).toMatchObject({
      kind: 'ignored',
      reason: 'unsupported_asset',
      sourceWallet: JETTON_WALLET,
    })
  })
})

describe('jetton wallet: internal transfers', () => {
  it('turns a successful internal_transfer into a USDT candidate', () => {
    const tx = jettonInternalTransfer({
      account: JETTON_WALLET,
      source: PAYER_JETTON_WALLET,
      amount: 5_000_000n,
      from: PAYER,
      comment: ORDER_ID,
    })
    expect(classifyTransaction(tx, ctx)).toEqual({
      kind: 'candidate',
      currency: 'USDT',
      jettonMaster: MASTER,
      amount: 5_000_000n,
      sender: PAYER,
      comment: ORDER_ID,
      abortedNonBounceable: false,
    })
  })

  it('reads an inline comment and a missing comment', () => {
    expect(
      classifyTransaction(
        jettonInternalTransfer({ account: JETTON_WALLET, comment: ORDER_ID, inline: true }),
        ctx,
      ),
    ).toMatchObject({ kind: 'candidate', comment: ORDER_ID })
    expect(
      classifyTransaction(jettonInternalTransfer({ account: JETTON_WALLET, comment: null }), ctx),
    ).toMatchObject({ kind: 'candidate', comment: null })
  })

  it('skips transfers that did not succeed: aborted, failed compute, failed action, bounced', () => {
    const ok = jettonInternalTransfer({ account: JETTON_WALLET, comment: ORDER_ID })
    expect(classifyTransaction(aborted(ok, { exitCode: 74 }), ctx)).toEqual({
      kind: 'skip',
      why: 'failed',
    })
    expect(classifyTransaction(withComputeSuccess(ok, false), ctx)).toEqual({
      kind: 'skip',
      why: 'failed',
    })
    expect(classifyTransaction(withActionSuccess(ok, false), ctx)).toEqual({
      kind: 'skip',
      why: 'failed',
    })
    expect(classifyTransaction(bounced(ok), ctx)).toEqual({ kind: 'skip', why: 'bounced' })
    // Missing phase information fails closed.
    expect(classifyTransaction({ ...ok, description: { type: 'ord' } }, ctx)).toEqual({
      kind: 'skip',
      why: 'failed',
    })
    expect(classifyTransaction({ ...ok, description: null }, ctx)).toEqual({
      kind: 'skip',
      why: 'failed',
    })
    // A missing action phase object alone is tolerated when aborted=false and compute succeeded.
    expect(classifyTransaction(withActionSuccess(ok, null), ctx)).toMatchObject({
      kind: 'candidate',
    })
  })

  it('records a mint from the master as ignored/from_master', () => {
    const mint = jettonInternalTransfer({
      account: JETTON_WALLET,
      source: MASTER,
      amount: 1_000_000_000n,
      from: null,
      comment: null,
    })
    expect(classifyTransaction(mint, ctx)).toEqual({
      kind: 'ignored',
      reason: 'from_master',
      currency: 'USDT',
      jettonMaster: MASTER,
      sourceWallet: MASTER,
      amount: 1_000_000_000n,
      sender: null,
      comment: null,
    })
  })

  it('records an internal_transfer whose body cannot be parsed as unknown_layout', () => {
    const truncated = withBody(
      jettonInternalTransfer({ account: JETTON_WALLET }),
      beginCell().storeUint(OP_JETTON_INTERNAL_TRANSFER, 32).storeUint(1n, 64).endCell(),
    )
    expect(classifyTransaction(truncated, ctx)).toEqual({
      kind: 'ignored',
      reason: 'unknown_layout',
      currency: 'USDT',
      jettonMaster: MASTER,
      sourceWallet: PAYER_JETTON_WALLET,
      amount: 0n,
      sender: null,
      comment: null,
    })
  })

  it('skips everything else on the jetton wallet: outgoing transfers, comments, excesses, externals', () => {
    const outgoing = withBody(
      jettonInternalTransfer({ account: JETTON_WALLET, source: MERCHANT }),
      beginCell().storeUint(0x0f8a7ea5, 32).storeUint(1n, 64).endCell(),
    )
    expect(classifyTransaction(outgoing, ctx)).toEqual({
      kind: 'skip',
      why: 'not_incoming_jettons',
    })
    expect(
      classifyTransaction(
        withBody(jettonInternalTransfer({ account: JETTON_WALLET }), buildCommentCell(ORDER_ID)),
        ctx,
      ),
    ).toEqual({ kind: 'skip', why: 'not_incoming_jettons' })
    expect(classifyTransaction(externalOutgoing({ account: JETTON_WALLET }), ctx)).toEqual({
      kind: 'skip',
      why: 'external',
    })
    expect(classifyTransaction(tickTock({ account: JETTON_WALLET }), ctx)).toEqual({
      kind: 'skip',
      why: 'no_in_msg',
    })
  })
})

describe('account routing', () => {
  it('ignores rows of accounts that are not scanned', () => {
    expect(
      classifyTransaction(tonTransfer({ account: rawAddress('dd'), comment: ORDER_ID }), ctx),
    ).toEqual({
      kind: 'skip',
      why: 'unknown_account',
    })
    expect(
      classifyTransaction(tonTransfer({ account: JETTON_WALLET, comment: ORDER_ID }), {
        ...ctx,
        merchantJettonWalletRaw: null,
      }),
    ).toEqual({ kind: 'skip', why: 'unknown_account' })
  })

  it('compares accounts and sources by value, whatever the case or form', () => {
    const lower = {
      ...tonTransfer({ account: MERCHANT, comment: ORDER_ID }),
      account: MERCHANT.toLowerCase(),
    }
    expect(classifyTransaction(lower, ctx)).toMatchObject({ kind: 'candidate' })
    const friendlySource = withSource(
      jettonNotification({ account: MERCHANT, source: JETTON_WALLET }),
      Address.parseRaw(JETTON_WALLET).toString({ testOnly: true, bounceable: true }),
    )
    expect(classifyTransaction(friendlySource, ctx)).toEqual({
      kind: 'skip',
      why: 'own_jetton_notification',
    })
    // An unparseable source is treated as absent rather than trusted.
    expect(classifyTransaction(withSource(friendlySource, 'garbage'), ctx)).toEqual({
      kind: 'skip',
      why: 'external',
    })
  })
})
