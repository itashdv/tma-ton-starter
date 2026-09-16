import { ApiError, SessionExpiredError } from './api'
import { t } from './i18n'

/**
 * Init data is valid only for the lifetime of a launch, so an expired session is a normal
 * outcome with its own instruction ("reopen the app") rather than a generic failure the user
 * would retry forever.
 */
export function isSessionExpired(error: unknown): boolean {
  return error instanceof SessionExpiredError
}

export interface ErrorMessageOptions {
  /** Shown for anything that is not a session problem. */
  fallbackKey: string
}

export function errorMessage(error: unknown, locale: string, options: ErrorMessageOptions): string {
  if (isSessionExpired(error)) return t(locale, 'error.sessionExpired')
  if (error instanceof ApiError && error.code === 'order_limit') {
    return t(locale, 'checkout.orderLimit')
  }
  return t(locale, options.fallbackKey)
}
