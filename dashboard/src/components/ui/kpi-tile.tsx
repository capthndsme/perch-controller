import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type KpiTileProps = {
  label: string
  value: ReactNode
  /** Secondary line under the value (units, context). */
  sub?: ReactNode
  icon?: ReactNode
  /** Optional status dot: good / warning / critical. */
  status?: 'good' | 'warning' | 'critical'
  className?: string
}

const STATUS_DOT: Record<NonNullable<KpiTileProps['status']>, string> = {
  good: 'bg-status-good',
  warning: 'bg-status-warning',
  critical: 'bg-status-critical',
}

/**
 * Stat tile: the number *is* the chart. Proportional figures on the hero
 * value (no tabular-nums at display size), small uppercase label above.
 */
export function KpiTile({ label, value, sub, icon, status, className }: KpiTileProps) {
  return (
    <div className={cn('card-surface flex flex-col gap-1.5 p-3.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="section-label">{label}</span>
        {icon ? <span className="text-muted-foreground">{icon}</span> : null}
      </div>
      <div className="flex items-baseline gap-2">
        {status ? (
          <span aria-hidden className={cn('size-2 shrink-0 rounded-full', STATUS_DOT[status])} />
        ) : null}
        <span className="truncate text-2xl font-semibold leading-none tracking-tight">{value}</span>
      </div>
      {sub ? <div className="truncate text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  )
}
