import type { ReactNode } from 'react'

/** One label/value line of a card; values may break anywhere so hashes never overflow. */
export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="text-right break-all">{children}</dd>
    </div>
  )
}
