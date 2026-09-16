import { createHmac } from 'node:crypto'

/**
 * Signs init data the way Telegram does. Used by tests and by the development script that
 * produces a mock launch parameter; never on a request path.
 */
export function signInitData(
  fields: Record<string, string | number | boolean | object>,
  botToken: string,
): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(fields)) {
    params.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
  }
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest()
  params.set('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'))
  return params.toString()
}

export interface MockUserOptions {
  id?: number
  firstName?: string
  username?: string
  languageCode?: string
  allowsWriteToPm?: boolean
  authDate?: number
  /** Telegram sends it on every modern launch; it is covered by the hash. */
  signature?: string
}

/** Init data for a fake user, shaped like a real launch (including the signature pair). */
export function signMockInitData(botToken: string, options: MockUserOptions = {}): string {
  return signInitData(
    {
      auth_date: options.authDate ?? Math.floor(Date.now() / 1000),
      chat_instance: '-1234567890123456789',
      chat_type: 'sender',
      query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
      signature: options.signature ?? 'mock_signature',
      user: {
        id: options.id ?? 279058397,
        first_name: options.firstName ?? 'Dev',
        username: options.username ?? 'dev_user',
        language_code: options.languageCode ?? 'ru',
        allows_write_to_pm: options.allowsWriteToPm ?? true,
      },
    },
    botToken,
  )
}
