'use client'

import { createContext, useContext } from 'react'

/** Raw init data of the current launch; undefined outside Telegram. */
export const InitDataContext = createContext<string | undefined>(undefined)

export function useRawInitDataValue(): string | undefined {
  return useContext(InitDataContext)
}
