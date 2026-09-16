import { isTMA, mockTelegramEnv } from '@tma.js/sdk-react'

/**
 * Development only: outside Telegram there are no launch parameters, so the SDK would refuse
 * to start. The mock carries init data signed with the real bot token (produced by
 * `pnpm --filter @tma/api tg:sign-initdata`), which means the API still validates the
 * signature: there is no authentication bypass anywhere.
 */
if (process.env.NODE_ENV === 'development') {
  const initData = process.env.NEXT_PUBLIC_TG_MOCK_INIT_DATA
  if (initData && !isTMA()) {
    mockTelegramEnv({
      launchParams: {
        tgWebAppVersion: '8.0',
        tgWebAppPlatform: 'tdesktop',
        tgWebAppThemeParams: { bg_color: '#ffffff', text_color: '#000000' },
        tgWebAppData: initData,
      },
    })
    console.info('[dev] Telegram environment mocked')
  }
}
