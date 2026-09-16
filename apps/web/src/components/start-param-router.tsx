'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useRef } from 'react'

import { parseStartParam } from '@/lib/start-param'
import { readStartParam } from '@/lib/telegram'

/**
 * A notification button opens the Mini App with `?startapp=order_<id>`. The parameter is
 * signed by Telegram but chosen by whoever built the link, so it may only steer navigation:
 * the order page itself checks ownership on the API.
 */
export function StartParamRouter() {
  const router = useRouter()
  const pathname = usePathname()
  const handled = useRef(false)

  useEffect(() => {
    // Only on the first render of a launch, so it never fights with the user's navigation.
    if (handled.current) return
    handled.current = true
    const target = parseStartParam(readStartParam())
    if (target.kind === 'order' && pathname === '/') {
      router.replace(`/orders/${target.id}`)
    }
  }, [pathname, router])

  return null
}
