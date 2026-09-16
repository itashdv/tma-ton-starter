'use client'

import { useMemo } from 'react'

import { useRawInitDataValue } from '@/app/init-data-context'

import { createApiClient, type ApiClient } from './api'

/** API client bound to the init data of this launch. */
export function useApi(): ApiClient {
  const raw = useRawInitDataValue()
  return useMemo(() => createApiClient({ getInitData: () => raw }), [raw])
}
