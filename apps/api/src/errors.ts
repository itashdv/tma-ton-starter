import type { ApiErrorBody } from '@tma/shared'

/** Errors that map straight to an HTTP response `{ error: { code, message } }`. */
export class ApiError extends Error {
  readonly statusCode: number
  readonly code: string

  constructor(statusCode: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.statusCode = statusCode
    this.code = code
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message } }
  }
}

export const notFound = (message = 'not found') => new ApiError(404, 'not_found', message)
