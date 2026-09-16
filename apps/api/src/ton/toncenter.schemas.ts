import { z } from 'zod'

/**
 * Schemas are written against LIVE toncenter v3 responses, not its OpenAPI document: the
 * document declares `opcode` as an integer and `finality` as an enum, while the wire format
 * uses the strings "0x7362d09c" and "finalized". Amounts and logical time are decimal strings.
 * Unknown fields are kept (loose objects) so a new indexer field cannot break the listener.
 */

const digits = z.string().regex(/^\d+$/)

/** `in_msg` is `{}` on tick-tock transactions, so every field here is optional. */
export const messageSchema = z.looseObject({
  hash: z.string().optional(),
  source: z.string().nullable().optional(),
  destination: z.string().nullable().optional(),
  value: digits.nullable().optional(),
  fwd_fee: digits.nullable().optional(),
  created_lt: digits.nullable().optional(),
  created_at: z.union([z.number(), digits]).nullable().optional(),
  opcode: z.union([z.string(), z.number()]).nullable().optional(),
  decoded_opcode: z.string().nullable().optional(),
  bounce: z.boolean().nullable().optional(),
  bounced: z.boolean().nullable().optional(),
  message_content: z
    .looseObject({
      hash: z.string().optional(),
      body: z.string().nullable().optional(),
      decoded: z.unknown().optional(),
    })
    .nullable()
    .optional(),
})

export type ToncenterMessage = z.infer<typeof messageSchema>

export const computePhaseSchema = z.looseObject({
  skipped: z.boolean().optional(),
  reason: z.string().nullable().optional(),
  success: z.boolean().nullable().optional(),
  exit_code: z.number().nullable().optional(),
})

export const transactionDescrSchema = z.looseObject({
  type: z.string().optional(),
  aborted: z.boolean().nullable().optional(),
  destroyed: z.boolean().nullable().optional(),
  compute_ph: computePhaseSchema.nullable().optional(),
  action: z
    .looseObject({
      success: z.boolean().nullable().optional(),
      result_code: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
})

export const transactionSchema = z.looseObject({
  account: z.string(),
  hash: z.string(),
  lt: digits,
  now: z.number(),
  mc_block_seqno: z.number().nullable().optional(),
  trace_id: z.string().nullable().optional(),
  description: transactionDescrSchema.nullable().optional(),
  in_msg: messageSchema.nullable().optional(),
  out_msgs: z.array(messageSchema).optional(),
  emulated: z.boolean().nullable().optional(),
  finality: z.union([z.string(), z.number()]).nullable().optional(),
})

export type ToncenterTransaction = z.infer<typeof transactionSchema>

export const transactionsResponseSchema = z.looseObject({
  transactions: z.array(transactionSchema),
})

export const runGetMethodResponseSchema = z.looseObject({
  gas_used: z.number().optional(),
  exit_code: z.number(),
  stack: z.array(z.looseObject({ type: z.string(), value: z.unknown().optional() })),
})

export const accountStateSchema = z.looseObject({
  address: z.string(),
  status: z.string().nullable().optional(),
  balance: digits.nullable().optional(),
  last_transaction_lt: digits.nullable().optional(),
  last_transaction_hash: z.string().nullable().optional(),
  code_hash: z.string().nullable().optional(),
})

export const accountStatesResponseSchema = z.looseObject({
  accounts: z.array(accountStateSchema),
})

export const jettonMasterSchema = z.looseObject({
  address: z.string(),
  total_supply: digits.nullable().optional(),
  mintable: z.boolean().nullable().optional(),
  admin_address: z.string().nullable().optional(),
  jetton_content: z
    .looseObject({ decimals: z.union([z.string(), z.number()]).optional() })
    .nullable()
    .optional(),
  code_hash: z.string().nullable().optional(),
})

export const jettonMastersResponseSchema = z.looseObject({
  jetton_masters: z.array(jettonMasterSchema),
})

/** `finality` is a string on the wire but an integer enum in the schema; accept both. */
export function isFinalizedValue(finality: string | number | null | undefined): boolean {
  return finality === 'finalized' || finality === 2
}

/** `opcode` may be "0x7362d09c" or a number; normalise to a number. */
export function opcodeToNumber(opcode: string | number | null | undefined): number | null {
  if (opcode === null || opcode === undefined) return null
  if (typeof opcode === 'number') return opcode >>> 0
  const parsed = Number.parseInt(opcode, 16)
  return Number.isNaN(parsed) ? null : parsed >>> 0
}
