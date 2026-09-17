'use client'

import type { AdminProductDto, AdminProductInput, AdminProductPatch } from '@tma/shared'
import { AmountError, formatUnits, parseTon, parseUsdt } from '@tma/shared'
import { useId, useState, type FormEvent, type ReactNode } from 'react'

import { useLocale } from '@/app/me-context'
import { adminErrorMessage } from '@/lib/admin-errors'
import { ApiError } from '@/lib/api'
import { TON_DECIMALS, usdtDecimals, usdtLabel } from '@/lib/format'
import { t } from '@/lib/i18n'

export interface ProductFormProps {
  /** Present when editing: the slug becomes read-only and the fields start from these values. */
  initial?: AdminProductDto
  onSubmit: (input: AdminProductInput | AdminProductPatch) => Promise<void>
  submitLabel: string
}

interface Values {
  slug: string
  title: string
  description: string
  imageUrl: string
  priceTon: string
  priceUsdt: string
  deliveryPayload: string
  deliverInChat: boolean
  isActive: boolean
  sortOrder: string
}

type Errors = Partial<Record<keyof Values | 'form', string>>

type PriceResult = { units: string | null } | { errorKey: string }

const INPUT = 'rounded-lg border bg-background px-3 py-2 text-sm disabled:opacity-60'

function initialValues(initial: AdminProductDto | undefined): Values {
  return {
    slug: initial?.slug ?? '',
    title: initial?.title ?? '',
    description: initial?.description ?? '',
    imageUrl: initial?.imageUrl ?? '',
    // Stored units come back as the decimal the administrator typed: string arithmetic only.
    priceTon: initial?.priceTonNano ? formatUnits(BigInt(initial.priceTonNano), TON_DECIMALS) : '',
    priceUsdt: initial?.priceUsdtUnits
      ? formatUnits(BigInt(initial.priceUsdtUnits), usdtDecimals())
      : '',
    deliveryPayload: initial?.deliveryPayload ?? '',
    deliverInChat: initial?.deliverInChat ?? false,
    isActive: initial?.isActive ?? true,
    sortOrder: String(initial?.sortOrder ?? 0),
  }
}

/** Decimal text → smallest units as a digit string; an empty field means "no price here". */
function toUnits(value: string, parse: (text: string) => bigint): PriceResult {
  const text = value.trim()
  if (text === '') return { units: null }
  try {
    const units = parse(text)
    return units > 0n ? { units: units.toString() } : { errorKey: 'admin.pricePositive' }
  } catch (error) {
    if (error instanceof AmountError) return { errorKey: 'admin.priceInvalid' }
    throw error
  }
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string
  label: string
  error?: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function ProductForm({ initial, onSubmit, submitLabel }: ProductFormProps) {
  const locale = useLocale()
  const prefix = useId()
  const [values, setValues] = useState<Values>(() => initialValues(initial))
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)
  const editing = initial !== undefined

  const fieldId = (name: keyof Values) => `${prefix}-${name}`
  const set = <K extends keyof Values>(name: K, value: Values[K]) =>
    setValues((previous) => ({ ...previous, [name]: value }))

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const next: Errors = {}
    const slug = values.slug.trim()
    const title = values.title.trim()
    if (!editing && slug === '') next.slug = t(locale, 'admin.required')
    if (title === '') next.title = t(locale, 'admin.required')

    const ton = toUnits(values.priceTon, parseTon)
    if ('errorKey' in ton) next.priceTon = t(locale, ton.errorKey)
    const usdt = toUnits(values.priceUsdt, (text) => parseUsdt(text, usdtDecimals()))
    if ('errorKey' in usdt) next.priceUsdt = t(locale, usdt.errorKey)
    // A product nobody can pay for is refused here, before the round trip to the API.
    if ('units' in ton && 'units' in usdt && ton.units === null && usdt.units === null) {
      next.form = t(locale, 'admin.priceRequired')
    }

    const sortText = values.sortOrder.trim() || '0'
    const sortOrder = /^-?\d+$/.test(sortText) ? Number.parseInt(sortText, 10) : Number.NaN
    if (!Number.isSafeInteger(sortOrder)) next.sortOrder = t(locale, 'admin.sortOrderInvalid')

    if (Object.keys(next).length > 0) {
      setErrors(next)
      return
    }

    const fields = {
      title,
      description: values.description.trim(),
      imageUrl: values.imageUrl.trim() || null,
      priceTonNano: 'units' in ton ? ton.units : null,
      priceUsdtUnits: 'units' in usdt ? usdt.units : null,
      deliveryPayload: values.deliveryPayload.trim() === '' ? null : values.deliveryPayload,
      deliverInChat: values.deliverInChat,
      isActive: values.isActive,
      sortOrder,
    }
    // The slug is the seed key and part of every link, so it is chosen once, at creation.
    const input: AdminProductInput | AdminProductPatch = editing ? fields : { slug, ...fields }

    setBusy(true)
    setErrors({})
    try {
      await onSubmit(input)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'slug_taken') {
        setErrors({ slug: t(locale, 'admin.slugTaken') })
      } else if (error instanceof ApiError && error.code === 'validation_error') {
        // The API names the offending field in its message, which beats a generic hint.
        setErrors({ form: `${t(locale, 'admin.validationError')}: ${error.message}` })
      } else {
        setErrors({ form: adminErrorMessage(error, locale, 'admin.saveFailed') })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-3">
      <Field id={fieldId('slug')} label={t(locale, 'admin.field.slug')} error={errors.slug}>
        <input
          id={fieldId('slug')}
          className={`${INPUT} font-mono`}
          value={values.slug}
          disabled={editing}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => set('slug', event.target.value)}
        />
      </Field>
      <Field id={fieldId('title')} label={t(locale, 'admin.field.title')} error={errors.title}>
        <input
          id={fieldId('title')}
          className={INPUT}
          value={values.title}
          onChange={(event) => set('title', event.target.value)}
        />
      </Field>
      <Field id={fieldId('description')} label={t(locale, 'admin.field.description')}>
        <textarea
          id={fieldId('description')}
          className={INPUT}
          rows={3}
          value={values.description}
          onChange={(event) => set('description', event.target.value)}
        />
      </Field>
      <Field id={fieldId('imageUrl')} label={t(locale, 'admin.field.imageUrl')}>
        <input
          id={fieldId('imageUrl')}
          className={INPUT}
          inputMode="url"
          value={values.imageUrl}
          onChange={(event) => set('imageUrl', event.target.value)}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field
          id={fieldId('priceTon')}
          label={t(locale, 'admin.field.priceTon')}
          error={errors.priceTon}
        >
          <input
            id={fieldId('priceTon')}
            className={INPUT}
            inputMode="decimal"
            value={values.priceTon}
            onChange={(event) => set('priceTon', event.target.value)}
          />
        </Field>
        <Field
          id={fieldId('priceUsdt')}
          label={t(locale, 'admin.field.priceUsdt', { label: usdtLabel() })}
          error={errors.priceUsdt}
        >
          <input
            id={fieldId('priceUsdt')}
            className={INPUT}
            inputMode="decimal"
            value={values.priceUsdt}
            onChange={(event) => set('priceUsdt', event.target.value)}
          />
        </Field>
      </div>
      <Field id={fieldId('deliveryPayload')} label={t(locale, 'admin.field.deliveryPayload')}>
        <textarea
          id={fieldId('deliveryPayload')}
          className={`${INPUT} font-mono`}
          rows={3}
          value={values.deliveryPayload}
          onChange={(event) => set('deliveryPayload', event.target.value)}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={values.deliverInChat}
          onChange={(event) => set('deliverInChat', event.target.checked)}
        />
        {t(locale, 'admin.field.deliverInChat')}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={values.isActive}
          onChange={(event) => set('isActive', event.target.checked)}
        />
        {t(locale, 'admin.field.isActive')}
      </label>
      <Field
        id={fieldId('sortOrder')}
        label={t(locale, 'admin.field.sortOrder')}
        error={errors.sortOrder}
      >
        <input
          id={fieldId('sortOrder')}
          className={`${INPUT} w-28`}
          type="number"
          step={1}
          inputMode="numeric"
          value={values.sortOrder}
          onChange={(event) => set('sortOrder', event.target.value)}
        />
      </Field>
      {errors.form ? (
        <p role="alert" className="text-sm text-destructive">
          {errors.form}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
      >
        {busy ? t(locale, 'admin.saving') : submitLabel}
      </button>
    </form>
  )
}
