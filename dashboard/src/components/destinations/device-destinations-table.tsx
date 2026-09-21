import { Fragment, useState } from 'react'
import { CaretDown, CaretRight } from '@phosphor-icons/react'
import { CategoryChip } from '@/components/destinations/category-chip'
import { DestinationTimeSeries } from '@/components/destinations/destination-time-series'
import { EmptyState } from '@/components/ui/empty-state'
import { ShareBar } from '@/components/ui/share-bar'
import { destinationNameLabel } from '@/lib/destinations'
import { formatBytes } from '@/lib/format-bytes'
import { formatProtocolLabel } from '@/lib/protocols'
import type { TimeWindow } from '@/lib/time-window'
import type { DeviceDestinationsResponse } from '@/types/api'

type DeviceDestinationsTableProps = {
  /** `null` = 404: no destination history for this MAC (or an older API). */
  data: DeviceDestinationsResponse | null | undefined
  isPending: boolean
  error: Error | null
  window: TimeWindow
  limit?: number
}

/**
 * One device's WAN destinations by name. Click a named row for its
 * downloaded / uploaded history.
 */
export function DeviceDestinationsTable({ data, isPending, error, window, limit }: DeviceDestinationsTableProps) {
  const [open, setOpen] = useState<string | null>(null)

  if (isPending && data === undefined) {
    return <p className="px-4 pb-4 text-xs text-muted-foreground">Loading destinations…</p>
  }
  if (error) {
    return <p className="px-4 pb-4 text-xs text-destructive">{error.message}</p>
  }
  const rows = limit ? (data?.destinations ?? []).slice(0, limit) : data?.destinations ?? []
  if (!data || rows.length === 0) {
    return (
      <div className="px-4 pb-4">
        <EmptyState
          title="No named destinations in this window"
          description={
            data === null
              ? 'This device has no destination history yet. It accumulates hourly from the collector once the device talks to the internet.'
              : 'Destination history accumulates hourly from the collector. Widen the window or wait for the next hour to close.'
          }
        />
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th className="w-6" />
            <th>Destination</th>
            <th className="text-right">Down</th>
            <th className="text-right">Up</th>
            <th className="text-right">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((entry) => {
            const key = `${entry.serverName ?? ''}|${entry.peerIp ?? ''}|${entry.protocol}`
            // Only named rows have a per-name history; addresses and the pool do not.
            const canOpen = Boolean(entry.serverName)
            const network = entry.peerIp
              ? (entry.org ?? (entry.asn ? `AS${entry.asn}` : 'unknown network')) +
                (entry.org && entry.asn ? ` · AS${entry.asn}` : '')
              : null
            const isOpen = open === key
            return (
              <Fragment key={key}>
                <tr
                  data-clickable={canOpen ? 'true' : undefined}
                  onClick={canOpen ? () => setOpen(isOpen ? null : key) : undefined}
                  aria-expanded={canOpen ? isOpen : undefined}
                >
                  <td className="pr-0 text-muted-foreground">
                    {canOpen ? (isOpen ? <CaretDown className="size-3.5" /> : <CaretRight className="size-3.5" />) : null}
                  </td>
                  <td>
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-mono text-[12px] font-medium">{destinationNameLabel(entry)}</p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {formatProtocolLabel(entry.protocol)}
                          {entry.domain && entry.domain !== entry.serverName ? ` · ${entry.domain}` : ''}
                          {network ? ` · ${network}` : ''}
                        </p>
                      </div>
                      <CategoryChip category={entry.category} className="shrink-0" />
                    </div>
                  </td>
                  <td className="text-right font-mono tabular-nums">{formatBytes(entry.bytesIn)}</td>
                  <td className="text-right font-mono tabular-nums">{formatBytes(entry.bytesOut)}</td>
                  <td>
                    <ShareBar percentage={entry.percentage} />
                  </td>
                </tr>
                {isOpen && entry.serverName ? (
                  <tr className="bg-muted/20">
                    <td />
                    <td colSpan={4} className="py-3">
                      <DestinationTimeSeries serverName={entry.serverName} window={window} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
