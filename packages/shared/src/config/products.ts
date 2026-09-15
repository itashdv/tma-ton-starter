import { z } from 'zod'

import { AmountError, TON_DECIMALS, parseUnits } from '../amounts'

const slugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, 'slug must be lowercase [a-z0-9-], 1..64')

const priceStringSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'price must be a decimal string like "1.5"')

export const productConfigItemSchema = z
  .object({
    slug: slugSchema,
    title: z.string().min(1).max(120),
    description: z.string().max(2000).default(''),
    imageUrl: z.url().optional(),
    priceTon: priceStringSchema.optional(),
    priceUsdt: priceStringSchema.optional(),
    deliveryPayload: z.string().max(4000).optional(),
    deliverInChat: z.boolean().default(false),
    isActive: z.boolean().default(true),
    sortOrder: z.number().int().default(0),
  })
  .strict()

export type ProductConfigItem = z.infer<typeof productConfigItemSchema>

/** A product ready to be inserted into the database: prices already in smallest units. */
export interface ProductSeed {
  slug: string
  title: string
  description: string
  imageUrl: string | null
  priceTonNano: bigint | null
  priceUsdtUnits: bigint | null
  deliveryPayload: string | null
  deliverInChat: boolean
  isActive: boolean
  sortOrder: number
}

export interface ParseProductsOptions {
  usdtDecimals: number
}

function parsePrice(
  value: string | undefined,
  decimals: number,
  ctx: z.RefinementCtx,
  path: (string | number)[],
): bigint | null {
  if (value === undefined) return null
  try {
    const units = parseUnits(value, decimals)
    if (units <= 0n) {
      ctx.addIssue({ code: 'custom', path, message: 'price must be greater than zero' })
      return null
    }
    return units
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      path,
      message: error instanceof AmountError ? error.message : String(error),
    })
    return null
  }
}

export function productsConfigSchema(options: ParseProductsOptions) {
  return z
    .array(productConfigItemSchema)
    .superRefine((items, ctx) => {
      const seen = new Map<string, number>()
      items.forEach((item, index) => {
        const previous = seen.get(item.slug)
        if (previous !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'slug'],
            message: `duplicate slug "${item.slug}" (first seen at index ${previous})`,
          })
        } else {
          seen.set(item.slug, index)
        }
        if (item.priceTon === undefined && item.priceUsdt === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [index],
            message: `product "${item.slug}" needs priceTon or priceUsdt`,
          })
        }
      })
    })
    .transform((items, ctx): ProductSeed[] =>
      items.map((item, index) => ({
        slug: item.slug,
        title: item.title,
        description: item.description,
        imageUrl: item.imageUrl ?? null,
        priceTonNano: parsePrice(item.priceTon, TON_DECIMALS, ctx, [index, 'priceTon']),
        priceUsdtUnits: parsePrice(item.priceUsdt, options.usdtDecimals, ctx, [index, 'priceUsdt']),
        deliveryPayload: item.deliveryPayload ?? null,
        deliverInChat: item.deliverInChat,
        isActive: item.isActive,
        sortOrder: item.sortOrder,
      })),
    )
}

export function parseProductsConfig(input: unknown, options: ParseProductsOptions): ProductSeed[] {
  return productsConfigSchema(options).parse(input)
}
