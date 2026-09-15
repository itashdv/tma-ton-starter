import { parseShopConfig, type ShopConfig } from '@tma/shared'

import shopJson from '../../../../config/shop.json'

/** config/shop.json, validated at build time. The only per-client surface besides .env. */
export const shopConfig: ShopConfig = parseShopConfig(shopJson)
