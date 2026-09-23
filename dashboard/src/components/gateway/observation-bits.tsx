import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { formatLastSeen } from '@/lib/collectors'
import { formatDateTime } from '@/lib/gateway-observation'
import { macPath } from '@/lib/traffic'
import { cn } from '@/lib/utils'
import type { GatewayDeviceRef } from '@/types/api'

/** "Reported 3 min ago" with a "stale" badge when the last report is over 30 min old. */
export function ObservedLine({ observedAt, stale, className }: { observedAt: string | null; stale?: boolean; className?: string }) {
  if (!observedAt) return <span className={cn('text-muted-foreground', className)}>Not reported yet</span>
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1.5', className)} title={formatDateTime(observedAt)}>
      <span>Reported {formatLastSeen(observedAt)}</span>
      {stale ? (
        <Badge variant="outline" className="rounded border-status-warning/50 text-[10px] text-status-warning">
          stale
        </Badge>
      ) : null}
    </span>
  )
}

/** A part the Gateway agent has never reported: an older collector, or a feature it does not read. */
export function NotReported({ what, className }: { what: string; className?: string }) {
  return (
    <EmptyState
      className={className}
      title={`No ${what} from this Gateway agent`}
      description="It has not reported this part of the router's state. A perch-collector release with the gateway observation channel reports it; older ones send traffic and gateway stats only."
    />
  )
}

/**
 * The host a row is about: Perch's name for it linking to its device page, or
 * the router's name when Perch has no traffic for it ("no traffic data", e.g.
 * a guest VLAN the collector does not capture). The MAC underneath.
 */
export function HostCell({
  mac,
  device,
  routerName,
}: {
  mac: string | null
  device: GatewayDeviceRef | null
  routerName: string | null
}) {
  const name = device?.name ?? routerName
  return (
    <div className="min-w-0">
      {device ? (
        <Link
          to={`/devices/${macPath(device.mac)}`}
          className="block max-w-[16rem] truncate font-medium text-foreground underline-offset-2 hover:underline"
        >
          {name ?? 'Unnamed device'}
        </Link>
      ) : (
        <span className="block max-w-[16rem] truncate font-medium">{name ?? <span className="text-muted-foreground">Unnamed</span>}</span>
      )}
      <span className="block font-mono text-[11px] text-muted-foreground">
        {mac ?? '—'}
        {!device && mac ? <span className="font-sans"> · no traffic data</span> : null}
      </span>
    </div>
  )
}

/** "running" / "not running" style chip: a dot, a label, and the state. */
export function StateChip({
  label,
  value,
  trueText = 'yes',
  falseText = 'no',
  tone = 'good',
}: {
  label: string
  value: boolean | null | undefined
  trueText?: string
  falseText?: string
  /** What `false` means: a warning (`good` = true is the healthy state) or nothing special. */
  tone?: 'good' | 'neutral'
}) {
  const dot =
    value === true
      ? tone === 'good'
        ? 'bg-status-good'
        : 'bg-muted-foreground/60'
      : value === false
        ? tone === 'good'
          ? 'bg-status-warning'
          : 'bg-muted-foreground/40'
        : 'bg-muted-foreground/30'
  return (
    <Badge variant="outline" className="gap-1.5 rounded text-[11px] font-normal">
      <span aria-hidden className={cn('inline-block size-1.5 rounded-full', dot)} />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value === true ? trueText : value === false ? falseText : 'unknown'}</span>
    </Badge>
  )
}

/** Horizontal scroll for wide tables on narrow screens. */
export function TableScroll({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto">{children}</div>
}

/** A label/value row in the dense key-value lists of the gateway panels. */
export function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-[12.5px]">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right break-words">{children}</span>
    </div>
  )
}

/** "Show all 412" under a table cut to its first rows. */
export function ShowMore({ shown, total, onShowAll }: { shown: number; total: number; onShowAll: () => void }) {
  if (shown >= total) return null
  return (
    <div className="border-t border-border/70 px-4 py-2 text-right">
      <button type="button" className="text-xs text-brand hover:underline" onClick={onShowAll}>
        Show all {total}
      </button>
    </div>
  )
}
