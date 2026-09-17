import { ApiError } from './api'
import { errorMessage, isSessionExpired } from './errors'
import { t } from './i18n'

/**
 * Error codes of the admin routes mapped to instructions the administrator can act on. An
 * unknown code falls back to the caller's generic text; an expired session keeps the "reopen
 * the app" message from errorMessage(), because retrying cannot fix it.
 */
const MESSAGE_KEYS: Record<string, string> = {
  forbidden: 'admin.noAccess',
  not_found: 'admin.notFound',
  validation_error: 'admin.validationError',
  price_required: 'admin.priceRequired',
  slug_taken: 'admin.slugTaken',
  order_not_cancellable: 'admin.order.notCancellable',
  order_not_paid: 'admin.order.notPaid',
  underpaid: 'admin.attach.underpaid',
  currency_mismatch: 'admin.attach.currencyMismatch',
  payment_not_attachable: 'admin.attach.notAttachable',
  order_already_paid: 'admin.attach.orderPaid',
  order_cancelled: 'admin.attach.orderCancelled',
}

export function adminErrorMessage(error: unknown, locale: string, fallbackKey: string): string {
  if (error instanceof ApiError && !isSessionExpired(error)) {
    const key = MESSAGE_KEYS[error.code]
    if (key) return t(locale, key)
  }
  return errorMessage(error, locale, { fallbackKey })
}
