import { z } from 'zod'

export const CURRENCIES = ['TON', 'USDT'] as const
export type Currency = (typeof CURRENCIES)[number]

export const DEFAULT_USDT_DECIMALS = 6

const localeSchema = z.string().regex(/^[a-z]{2}$/, 'locale must be a two-letter code')

export const shopConfigSchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().max(500).default(''),
    defaultLocale: localeSchema,
    locales: z.array(localeSchema).min(1),
    currencies: z.array(z.enum(CURRENCIES)).min(1),
    usdt: z
      .object({
        label: z.string().min(1).max(16),
        decimals: z.number().int().min(0).max(18),
      })
      .strict()
      .optional(),
    support: z.object({ url: z.url() }).strict().optional(),
    links: z.object({ terms: z.url().optional(), privacy: z.url().optional() }).strict().optional(),
    branding: z
      .object({
        accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'accentColor must be #RRGGBB'),
        icon: z.string().regex(/^[a-z0-9._-]+\.(png|ico)$/, 'icon must be a png/ico file name'),
      })
      .strict(),
  })
  .strict()
  .superRefine((shop, ctx) => {
    if (!shop.locales.includes(shop.defaultLocale)) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaultLocale'],
        message: 'defaultLocale must be listed in locales',
      })
    }
    if (new Set(shop.locales).size !== shop.locales.length) {
      ctx.addIssue({ code: 'custom', path: ['locales'], message: 'locales must be unique' })
    }
    if (new Set(shop.currencies).size !== shop.currencies.length) {
      ctx.addIssue({ code: 'custom', path: ['currencies'], message: 'currencies must be unique' })
    }
    if (shop.currencies.includes('USDT') && !shop.usdt) {
      ctx.addIssue({
        code: 'custom',
        path: ['usdt'],
        message: 'usdt block is required when USDT is enabled',
      })
    }
  })

export type ShopConfig = z.infer<typeof shopConfigSchema>

export function parseShopConfig(input: unknown): ShopConfig {
  return shopConfigSchema.parse(input)
}

export function shopUsdtDecimals(shop: Pick<ShopConfig, 'usdt'>): number {
  return shop.usdt?.decimals ?? DEFAULT_USDT_DECIMALS
}

export function shopUsdtLabel(shop: Pick<ShopConfig, 'usdt'>): string {
  return shop.usdt?.label ?? 'USDT'
}
