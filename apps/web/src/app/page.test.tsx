import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { t } from '@/lib/i18n'
import { shopConfig } from '@/lib/shop-config'

import HomePage from './page'

describe('HomePage', () => {
  it('renders the shop name and description from config/shop.json', () => {
    render(<HomePage />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(shopConfig.name)
    if (shopConfig.description) {
      expect(screen.getByText(shopConfig.description)).toBeInTheDocument()
    }
  })

  it('renders localized strings for the default locale', () => {
    render(<HomePage />)
    const heading = screen.getByRole('heading', { level: 2 })
    expect(heading).toHaveTextContent(t(shopConfig.defaultLocale, 'catalog.title'))
    expect(heading).not.toHaveTextContent('catalog.title')
  })
})
