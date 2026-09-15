/** Shapes shared between apps/api and apps/web. Amounts travel as digit strings. */

export interface ApiErrorBody {
  error: {
    code: string
    message: string
  }
}

export interface HealthResponse {
  ok: boolean
  db: 'up' | 'down'
  version: string
  worker: {
    lastPollAt: string | null
    ageSec: number | null
    stale: boolean
  }
}

export interface ProductDto {
  id: string
  slug: string
  title: string
  description: string
  imageUrl: string | null
  priceTonNano: string | null
  priceUsdtUnits: string | null
  sortOrder: number
}
