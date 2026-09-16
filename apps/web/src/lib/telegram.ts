'use client'

import {
  LaunchParamsRetrieveError,
  init,
  initData,
  isTMA,
  miniApp,
  requestWriteAccess,
  retrieveLaunchParams,
  retrieveRawInitData,
  viewport,
} from '@tma.js/sdk-react'

/**
 * Every import of the Telegram SDK lives here. The SDK reads window.location and touches the
 * document, so nothing below may run during server rendering; callers gate on a did-mount
 * check. Keeping the imports in one module also keeps the rest of the app testable in Node.
 */

export { LaunchParamsRetrieveError }

export function isInsideTelegram(): boolean {
  try {
    return isTMA()
  } catch {
    return false
  }
}

/** Initialises the SDK and restores init data. Returns the SDK cleanup function. */
export function initTelegram(): VoidFunction {
  const cleanup = init()
  try {
    initData.restore()
  } catch (error) {
    // Outside Telegram there is nothing to restore; the app shows its "open from Telegram" state.
    if (!LaunchParamsRetrieveError.is(error)) throw error
  }
  // Cosmetic calls: on a page opened outside a Telegram webview (a copied link still carrying
  // the launch fragment) these throw, and losing the whole shop over them makes no sense.
  try {
    miniApp.ready.ifAvailable()
    viewport.expand.ifAvailable()
  } catch {
    // ignored on purpose
  }
  return cleanup
}

export interface RawInitDataResult {
  raw: string | undefined
  /** True when there are no launch parameters at all: the page was opened outside Telegram. */
  outsideTelegram: boolean
}

export function readRawInitData(): RawInitDataResult {
  try {
    return { raw: retrieveRawInitData(), outsideTelegram: false }
  } catch (error) {
    if (!LaunchParamsRetrieveError.is(error)) throw error
    return { raw: undefined, outsideTelegram: true }
  }
}

/**
 * `start_param` of the current launch (`?startapp=…` on a t.me link). Signed by Telegram, but
 * its value is chosen by whoever built the link, so it may drive navigation only.
 */
export function readStartParam(): string | undefined {
  try {
    const params = retrieveLaunchParams()
    const fromInitData = params.tgWebAppData?.start_param
    return typeof fromInitData === 'string' ? fromInitData : params.tgWebAppStartParam
  } catch {
    return undefined
  }
}

export function canRequestWriteAccess(): boolean {
  try {
    return requestWriteAccess.isAvailable()
  } catch {
    return false
  }
}

/** Asks the user to let the bot message them; returns true when access was granted. */
export async function askWriteAccess(): Promise<boolean> {
  if (!canRequestWriteAccess()) return false
  const status = await requestWriteAccess()
  return status === 'allowed'
}
