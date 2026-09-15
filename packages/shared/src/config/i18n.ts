import { z } from 'zod'

export const i18nDictSchema = z.record(
  z.string().regex(/^[a-zA-Z0-9_.-]+$/, 'i18n keys are dotted identifiers'),
  z.string(),
)

export type I18nDict = z.infer<typeof i18nDictSchema>

export function parseI18nDict(input: unknown): I18nDict {
  return i18nDictSchema.parse(input)
}

/** Every locale must define exactly the same set of keys; throws listing the differences. */
export function assertLocalesConsistent(dicts: Record<string, I18nDict>): void {
  const locales = Object.keys(dicts)
  if (locales.length === 0) return
  const union = new Set<string>()
  for (const locale of locales) {
    for (const key of Object.keys(dicts[locale] ?? {})) union.add(key)
  }
  const problems: string[] = []
  for (const locale of locales) {
    const keys = new Set(Object.keys(dicts[locale] ?? {}))
    const missing = [...union].filter((key) => !keys.has(key))
    if (missing.length > 0) {
      problems.push(`${locale}: missing ${missing.join(', ')}`)
    }
  }
  if (problems.length > 0) {
    throw new Error(`i18n dictionaries are inconsistent: ${problems.join('; ')}`)
  }
}

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

/** Looks up `key` and substitutes `{{name}}` placeholders; unknown keys return the key itself. */
export function translate(
  dict: I18nDict,
  key: string,
  vars: Record<string, string | number> = {},
): string {
  const template = dict[key]
  if (template === undefined) return key
  return template.replace(PLACEHOLDER_RE, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  )
}
