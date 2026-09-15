import type { Metadata, Viewport } from 'next'
import type { CSSProperties, ReactNode } from 'react'

import { shopConfig } from '@/lib/shop-config'

import './globals.css'

export const metadata: Metadata = {
  title: shopConfig.name,
  description: shopConfig.description,
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: shopConfig.branding.accentColor,
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang={shopConfig.defaultLocale}
      // Brand colour from config/shop.json drives the primary palette (see globals.css).
      style={{ '--brand': shopConfig.branding.accentColor } as CSSProperties}
    >
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  )
}
