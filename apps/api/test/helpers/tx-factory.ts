import { createHash } from 'node:crypto'

import { Address, beginCell, type Cell } from '@ton/core'
import {
  OP_JETTON_EXCESSES,
  OP_JETTON_INTERNAL_TRANSFER,
  OP_JETTON_TRANSFER_NOTIFICATION,
  buildCommentCell,
} from '@tma/shared/ton'

import type { ToncenterMessage, ToncenterTransaction } from '../../src/ton/toncenter.schemas'

/**
 * Builds toncenter v3 rows in the live wire shape (string opcodes, decimal-string amounts,
 * base64 hashes, raw uppercase addresses) so that tests can express every variant the
 * recorded fixtures do not cover. Every helper returns a new object.
 */

export const DEFAULT_NOW = 1_789_451_411
export const DEFAULT_MC_SEQNO = 92_816_994

export function rawAddress(fill: string, workchain = 0): string {
  return `${workchain}:${fill
    .repeat(64 / fill.length)
    .slice(0, 64)
    .toUpperCase()}`
}

export function addressOf(raw: string): Address {
  return Address.parseRaw(raw)
}

/** Deterministic 32-byte hash as toncenter serialises it (standard base64). */
export function fakeHash(seed: string): string {
  return createHash('sha256').update(seed).digest('base64')
}

function opcodeString(body: Cell | null): string | null {
  if (!body || body.bits.length < 32) return null
  const op = body.beginParse().loadUint(32)
  return `0x${op.toString(16).padStart(8, '0')}`
}

export interface MakeTxOptions {
  account: string
  /** null = external message (no source). */
  source?: string | null
  value?: bigint
  body?: Cell | null
  lt?: bigint
  now?: number
  hash?: string
  bounce?: boolean
  bounced?: boolean
  aborted?: boolean
  computeSuccess?: boolean
  actionSuccess?: boolean | null
  exitCode?: number
  finality?: string
  emulated?: boolean
  mcBlockSeqno?: number | null
  traceId?: string | null
  outMsgs?: ToncenterMessage[]
}

export function makeTx(options: MakeTxOptions): ToncenterTransaction {
  const lt = options.lt ?? 1000n
  const body = options.body === undefined ? beginCell().endCell() : options.body
  const aborted = options.aborted ?? false
  const computeSuccess = options.computeSuccess ?? !aborted
  const actionSuccess = options.actionSuccess === undefined ? computeSuccess : options.actionSuccess
  const hash = options.hash ?? fakeHash(`${options.account}|${lt.toString()}`)
  const source = options.source === undefined ? rawAddress('11') : options.source
  return {
    account: options.account,
    hash,
    lt: lt.toString(),
    now: options.now ?? DEFAULT_NOW,
    mc_block_seqno: options.mcBlockSeqno === undefined ? DEFAULT_MC_SEQNO : options.mcBlockSeqno,
    trace_id: options.traceId === undefined ? fakeHash(`trace|${hash}`) : options.traceId,
    emulated: options.emulated ?? false,
    finality: options.finality ?? 'finalized',
    description: {
      type: 'ord',
      aborted,
      destroyed: false,
      compute_ph: {
        skipped: false,
        success: computeSuccess,
        exit_code: options.exitCode ?? (computeSuccess ? 0 : 74),
      },
      action:
        actionSuccess === null
          ? null
          : { success: actionSuccess, valid: true, no_funds: false, result_code: 0 },
    },
    in_msg: {
      hash: fakeHash(`msg|${hash}`),
      source,
      destination: options.account,
      value: (options.value ?? 0n).toString(),
      fwd_fee: '266669',
      created_lt: (lt - 1n).toString(),
      created_at: options.now ?? DEFAULT_NOW,
      opcode: opcodeString(body),
      bounce: options.bounce ?? source !== null,
      bounced: options.bounced ?? false,
      message_content: {
        hash: fakeHash(`body|${hash}`),
        body: (body ?? beginCell().endCell()).toBoc().toString('base64'),
      },
    },
    out_msgs: options.outMsgs ?? [],
  }
}

export interface TonTransferOptions {
  account: string
  source?: string
  value?: bigint
  /** undefined = empty body; a string = text comment. */
  comment?: string
  lt?: bigint
  bounce?: boolean
}

/** Plain TON transfer to the merchant wallet (text comment or empty body). */
export function tonTransfer(options: TonTransferOptions): ToncenterTransaction {
  const source = options.source ?? rawAddress('11')
  return makeTx({
    account: options.account,
    source,
    value: options.value ?? 1_500_000_000n,
    body: options.comment === undefined ? beginCell().endCell() : buildCommentCell(options.comment),
    lt: options.lt,
    // Wallet-to-wallet transfers built by TonConnect are non-bounceable.
    bounce: options.bounce ?? false,
  })
}

export interface JettonInternalTransferOptions {
  account: string
  /** Jetton wallet of the payer (or the master for a mint). */
  source?: string
  amount?: bigint
  /** Owner that sent the jettons; null = addr_none. */
  from?: string | null
  comment?: string | null
  /** Store the comment inline (Either left) instead of as a reference. */
  inline?: boolean
  forwardTonAmount?: bigint
  value?: bigint
  lt?: bigint
  queryId?: bigint
}

export function jettonInternalTransferBody(options: JettonInternalTransferOptions): Cell {
  const from = options.from === undefined ? rawAddress('11') : options.from
  const builder = beginCell()
    .storeUint(OP_JETTON_INTERNAL_TRANSFER, 32)
    .storeUint(options.queryId ?? 7n, 64)
    .storeCoins(options.amount ?? 5_000_000n)
    .storeAddress(from ? addressOf(from) : null)
    .storeAddress(from ? addressOf(from) : null)
    .storeCoins(options.forwardTonAmount ?? 1n)
  const comment = options.comment === undefined ? null : options.comment
  if (comment === null) return builder.storeBit(0).endCell()
  if (options.inline) {
    return builder.storeBit(0).storeUint(0, 32).storeStringTail(comment).endCell()
  }
  return builder.storeBit(1).storeRef(buildCommentCell(comment)).endCell()
}

/** internal_transfer as received by the merchant jetton wallet. */
export function jettonInternalTransfer(
  options: JettonInternalTransferOptions,
): ToncenterTransaction {
  return makeTx({
    account: options.account,
    source: options.source ?? rawAddress('22'),
    value: options.value ?? 30_000_000n,
    body: jettonInternalTransferBody(options),
    lt: options.lt,
    bounce: true,
  })
}

export interface JettonNotificationOptions {
  account: string
  /** Jetton wallet that forwarded the notification. */
  source?: string
  amount?: bigint
  /** Owner that sent the jettons. */
  sender?: string | null
  comment?: string | null
  value?: bigint
  lt?: bigint
  aborted?: boolean
}

export function jettonNotificationBody(options: JettonNotificationOptions): Cell {
  const sender = options.sender === undefined ? rawAddress('11') : options.sender
  const builder = beginCell()
    .storeUint(OP_JETTON_TRANSFER_NOTIFICATION, 32)
    .storeUint(7n, 64)
    .storeCoins(options.amount ?? 5_000_000n)
    .storeAddress(sender ? addressOf(sender) : null)
  const comment = options.comment === undefined ? null : options.comment
  if (comment === null) return builder.storeBit(0).endCell()
  return builder.storeBit(1).storeRef(buildCommentCell(comment)).endCell()
}

/** transfer_notification as received by the merchant main wallet (1 nanoTON, usually aborted). */
export function jettonNotification(options: JettonNotificationOptions): ToncenterTransaction {
  return makeTx({
    account: options.account,
    source: options.source ?? rawAddress('99'),
    value: options.value ?? 1n,
    body: jettonNotificationBody(options),
    lt: options.lt,
    bounce: false,
    aborted: options.aborted ?? true,
    exitCode: options.aborted === false ? 0 : -14,
  })
}

/** excesses (0xd53276db): leftover gas returned by a jetton wallet. */
export function excesses(options: {
  account: string
  source?: string
  value?: bigint
  lt?: bigint
}) {
  return makeTx({
    account: options.account,
    source: options.source ?? rawAddress('99'),
    value: options.value ?? 12_345_678n,
    body: beginCell().storeUint(OP_JETTON_EXCESSES, 32).storeUint(7n, 64).endCell(),
    lt: options.lt,
    bounce: false,
  })
}

/** The owner's own outgoing transfer: external-in message without a source. */
export function externalOutgoing(options: { account: string; lt?: bigint }): ToncenterTransaction {
  return makeTx({
    account: options.account,
    source: null,
    value: 0n,
    body: beginCell().storeUint(0x7369676e, 32).endCell(),
    lt: options.lt,
    bounce: false,
    outMsgs: [
      {
        hash: fakeHash(`out|${options.account}|${(options.lt ?? 1000n).toString()}`),
        source: options.account,
        destination: rawAddress('44'),
        value: '100000000',
        opcode: '0x00000000',
        bounce: false,
        bounced: false,
      },
    ],
  })
}

/** Tick-tock system transaction: `in_msg` is an empty object. */
export function tickTock(options: { account: string; lt?: bigint }): ToncenterTransaction {
  const tx = makeTx({ account: options.account, source: null, lt: options.lt })
  return {
    ...tx,
    description: { type: 'tick_tock', aborted: false, compute_ph: { success: true } },
    in_msg: {},
  }
}

function clone(tx: ToncenterTransaction): ToncenterTransaction {
  return structuredClone(tx)
}

function inMsg(tx: ToncenterTransaction) {
  if (!tx.in_msg) throw new Error('transaction has no in_msg')
  return tx.in_msg
}

export function bounced(tx: ToncenterTransaction): ToncenterTransaction {
  const out = clone(tx)
  inMsg(out).bounced = true
  return out
}

export function aborted(
  tx: ToncenterTransaction,
  options: { bounce?: boolean; exitCode?: number } = {},
): ToncenterTransaction {
  const out = clone(tx)
  if (options.bounce !== undefined) inMsg(out).bounce = options.bounce
  out.description = {
    ...(out.description ?? {}),
    aborted: true,
    compute_ph: { skipped: false, success: false, exit_code: options.exitCode ?? 74 },
    action: null,
  }
  return out
}

export function withComputeSuccess(
  tx: ToncenterTransaction,
  success: boolean,
): ToncenterTransaction {
  const out = clone(tx)
  out.description = {
    ...(out.description ?? {}),
    compute_ph: { ...(out.description?.compute_ph ?? {}), success },
  }
  return out
}

export function withActionSuccess(
  tx: ToncenterTransaction,
  success: boolean | null,
): ToncenterTransaction {
  const out = clone(tx)
  out.description = {
    ...(out.description ?? {}),
    action: success === null ? null : { ...(out.description?.action ?? {}), success },
  }
  return out
}

export function withValue(tx: ToncenterTransaction, value: bigint): ToncenterTransaction {
  const out = clone(tx)
  inMsg(out).value = value.toString()
  return out
}

export function withBody(tx: ToncenterTransaction, body: Cell): ToncenterTransaction {
  const out = clone(tx)
  const msg = inMsg(out)
  msg.opcode = opcodeString(body)
  msg.message_content = { ...(msg.message_content ?? {}), body: body.toBoc().toString('base64') }
  return out
}

export function withComment(tx: ToncenterTransaction, comment: string): ToncenterTransaction {
  return withBody(tx, buildCommentCell(comment))
}

export function withSource(tx: ToncenterTransaction, source: string | null): ToncenterTransaction {
  const out = clone(tx)
  inMsg(out).source = source
  return out
}

export function nonFinal(
  tx: ToncenterTransaction,
  finality: 'pending' | 'confirmed' = 'confirmed',
): ToncenterTransaction {
  return { ...clone(tx), finality, mc_block_seqno: null }
}

export function emulated(tx: ToncenterTransaction): ToncenterTransaction {
  return { ...clone(tx), emulated: true }
}

/** Changes lt and re-derives the hash so that rows stay distinct. */
export function withLt(tx: ToncenterTransaction, lt: bigint): ToncenterTransaction {
  return { ...clone(tx), lt: lt.toString(), hash: fakeHash(`${tx.account}|${lt.toString()}`) }
}

export function withHash(tx: ToncenterTransaction, hash: string): ToncenterTransaction {
  return { ...clone(tx), hash }
}

export function withNow(tx: ToncenterTransaction, now: number): ToncenterTransaction {
  return { ...clone(tx), now }
}

export function withAccount(tx: ToncenterTransaction, account: string): ToncenterTransaction {
  const out = clone(tx)
  out.account = account
  if (out.in_msg && Object.keys(out.in_msg).length > 0) out.in_msg.destination = account
  out.hash = fakeHash(`${account}|${out.lt}`)
  return out
}

export function withMcSeqno(tx: ToncenterTransaction, seqno: number | null): ToncenterTransaction {
  return { ...clone(tx), mc_block_seqno: seqno }
}

/** Assigns consecutive lt values (and fresh hashes) so a list forms a plausible account chain. */
export function chain(
  rows: ToncenterTransaction[],
  startLt = 1000n,
  step = 1n,
): ToncenterTransaction[] {
  return rows.map((row, index) => withLt(row, startLt + BigInt(index) * step))
}
