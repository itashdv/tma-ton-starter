import type { ReactNode } from 'react'

export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'danger'

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-secondary text-muted-foreground',
  ok: 'bg-secondary text-primary',
  warn: 'bg-secondary text-foreground',
  danger: 'bg-destructive/10 text-destructive',
}

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className={`rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap ${TONES[tone]}`}>
      {children}
    </span>
  )
}
