import type {
  AdminAttachInput,
  AdminAttachResponse,
  AdminHealthDto,
  AdminNotificationDto,
  AdminOrderDetailsDto,
  AdminOrderDto,
  AdminOrdersPageDto,
  AdminPaymentsPageDto,
  AdminProductDto,
  AdminProductInput,
  AdminProductPatch,
  OrderStatusDto,
  PaymentStatusDto,
} from '@tma/shared'

import type { ApiClient } from './api'

/**
 * Thin typed wrappers over the `/admin/*` routes. The client adds the init data; who is an
 * administrator is decided by the API against TELEGRAM_ADMIN_IDS, so nothing here checks it.
 */

export interface AdminOrdersQuery {
  status?: OrderStatusDto | ''
  cursor?: string | null
  limit?: number
}

export interface AdminPaymentsQuery {
  status?: PaymentStatusDto | ''
  cursor?: string | null
  limit?: number
}

/** `?a=1&b=2` from the given entries; empty, null and undefined values are left out. */
function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const encoded = search.toString()
  return encoded ? `?${encoded}` : ''
}

function segment(id: string): string {
  return encodeURIComponent(id)
}

export function listProducts(api: ApiClient): Promise<{ products: AdminProductDto[] }> {
  return api.get<{ products: AdminProductDto[] }>('/admin/products')
}

export function createProduct(
  api: ApiClient,
  input: AdminProductInput,
): Promise<{ product: AdminProductDto }> {
  return api.post<{ product: AdminProductDto }>('/admin/products', input)
}

export function updateProduct(
  api: ApiClient,
  id: string,
  patch: AdminProductPatch,
): Promise<{ product: AdminProductDto }> {
  return api.patch<{ product: AdminProductDto }>(`/admin/products/${segment(id)}`, patch)
}

export function listOrders(
  api: ApiClient,
  params: AdminOrdersQuery = {},
): Promise<AdminOrdersPageDto> {
  const search = query({ status: params.status, cursor: params.cursor, limit: params.limit })
  return api.get<AdminOrdersPageDto>(`/admin/orders${search}`)
}

export function getOrder(api: ApiClient, id: string): Promise<AdminOrderDetailsDto> {
  return api.get<AdminOrderDetailsDto>(`/admin/orders/${segment(id)}`)
}

export function cancelOrder(
  api: ApiClient,
  id: string,
  note?: string,
): Promise<{ order: AdminOrderDto }> {
  const body = note === undefined ? {} : { note }
  return api.post<{ order: AdminOrderDto }>(`/admin/orders/${segment(id)}/cancel`, body)
}

export function resendNotification(
  api: ApiClient,
  id: string,
): Promise<{ notification: AdminNotificationDto }> {
  return api.post<{ notification: AdminNotificationDto }>(
    `/admin/orders/${segment(id)}/resend-notification`,
    {},
  )
}

export function listPayments(
  api: ApiClient,
  params: AdminPaymentsQuery = {},
): Promise<AdminPaymentsPageDto> {
  const search = query({ status: params.status, cursor: params.cursor, limit: params.limit })
  return api.get<AdminPaymentsPageDto>(`/admin/payments${search}`)
}

export function attachPayment(
  api: ApiClient,
  id: string,
  input: AdminAttachInput,
): Promise<AdminAttachResponse> {
  return api.post<AdminAttachResponse>(`/admin/payments/${segment(id)}/attach`, input)
}

export function getAdminHealth(api: ApiClient): Promise<AdminHealthDto> {
  return api.get<AdminHealthDto>('/admin/health')
}
