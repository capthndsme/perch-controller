import { Fragment, useMemo, useState } from 'react'
import { CaretDown, CaretRight } from '@phosphor-icons/react'
import { CategoryChip } from '@/components/destinations/category-chip'
import { DestinationTimeSeries } from '@/components/destinations/destination-time-series'
import { EmptyState } from '@/components/ui/empty-state'
import { ShareBar } from '@/components/ui/share-bar'
import { destinationGroupSubtitle, destinationGroupTitle, destinationNameLabel } from '@/lib/destinations'
import { formatBytes } from '@/lib/format-bytes'
import { formatProtocolLabel } from '@/lib/protocols'
import type { TimeWindow } from '@/lib/time-window'
import type { DestinationsResponse } from '@/types/api'

type DestinationsTableProps = {
  /** `null` = the API build has no destinations endpoint yet (404). */
  data: DestinationsResponse | null | undefined
  isPending: boolean
  error: Error | null
  /** Compact hides in/out + devices and the name drill-down. */
  compact?: boolean
  limit?: number
  /** Needed for the per-name history chart when a name is expanded. */
  window?: TimeWindow
  /** Shown instead of "Sites" in the empty state. */
  emptyTitle?: string
}

/**
 * "Where is the traffic going", by site: destinations grouped by registered
 * domain, expandable to the hostnames behind each; unnamed TLS/HTTP/QUIC
 * flows are grouped by the network (ASN) of their address, and families
 * that never carry a name pool per protocol. Bytes are from the devices'
 * point of view: down = downloaded from the site, up = uploaded.
 */
export function DestinationsTable({
  data,
  isPending,
  error,
  compact = false,
  limit,
  window,
  emptyTitle = 'No destination history in this window',
}: DestinationsTableProps) {
  const [open, setOpen] = useState<string | null>(null)
  const [openName, setOpenName] = useState<string | null>(null)
  const groups = useMemo(() => {
    const all = data?.domains ?? []
    return limit ? all.slice(0, limit) : all
  }, [data, limit])

  if (isPending && data === undefined) {
    return <p className="px-4 pb-4 text-xs text-muted-foreground">Loading destinations…</p>
  }
  if (error) {
    return <p className="px-4 pb-4 text-xs text-destructive">{error.message}</p>
  }
  if (data === null) {
    return (
      <div className="px-4 pb-4">
        <EmptyState
          title="Destination accounting is not available"
          description="Names need the collector and API update that records where each device's WAN bytes went."
        />
      </div>
    )
  }
  if (groups.length === 0) {
    return (
      <div className="px-4 pb-4">
        <EmptyState
          title={emptyTitle}
          description="Destination history accumulates hourly from the collector. Widen the window or wait for the next hour to close."
        />
      </div>
    )
  }

  const columnCount = compact ? 4 : 7

  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th className="w-6" />
            <th>Site</th>
            <th className="text-right">Share</th>
            {!compact ? <th className="text-right">Down</th> : null}
            {!compact ? <th className="text-right">Up</th> : null}
            <th className="text-right">Total</th>
            {!compact ? <th className="text-right">Devices</th> : null}
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const isOpen = open === group.key
            return (
              <Fragment key={group.key}>
                <tr
                  data-clickable="true"
                  onClick={() => {
                    setOpen(isOpen ? null : group.key)
                    setOpenName(null)
                  }}
                  aria-expanded={isOpen}
                >
                  <td className="pr-0 text-muted-foreground">
                    {isOpen ? <CaretDown className="size-3.5" /> : <CaretRight className="size-3.5" />}
                  </td>
                  <td>
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{destinationGroupTitle(group)}</p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {destinationGroupSubtitle(group)}
                        </p>
                      </div>
                      <CategoryChip category={group.category} className="shrink-0" />
                    </div>
                  </td>
                  <td>
                    <ShareBar percentage={group.percentage} />
                  </td>
                  {!compact ? <td className="text-right font-mono tabular-nums">{formatBytes(group.bytesIn)}</td> : null}
                  {!compact ? <td className="text-right font-mono tabular-nums">{formatBytes(group.bytesOut)}</td> : null}
                  <td className="text-right font-mono font-medium tabular-nums">{formatBytes(group.totalBytes)}</td>
                  {!compact ? (
                    <td className="text-right font-mono tabular-nums text-muted-foreground">{group.deviceCount}</td>
                  ) : null}
                </tr>
                {isOpen
                  ? group.names.map((name) => {
                      const nameKey = `${group.key}|${name.serverName ?? ''}|${name.peerIp ?? ''}|${name.protocol}`
                      // Only named rows have a per-name history; addresses and the pool do not.
                      const canOpen = !compact && Boolean(name.serverName) && Boolean(window)
                      const nameOpen = openName === nameKey
                      return (
                        <Fragment key={nameKey}>
                          <tr
                            className="bg-muted/20"
                            data-clickable={canOpen ? 'true' : undefined}
                            onClick={
                              canOpen
                                ? (event) => {
                                    event.stopPropagation()
                                    setOpenName(nameOpen ? null : nameKey)
                                  }
                                : undefined
                            }
                            aria-expanded={canOpen ? nameOpen : undefined}
                          >
                            <td className="pr-0 text-muted-foreground">
                              {canOpen ? (
                                nameOpen ? <CaretDown className="size-3" /> : <CaretRight className="size-3" />
                              ) : null}
                            </td>
                            <td>
                              <div className="flex min-w-0 items-center gap-2">
                                <span className="truncate font-mono text-[12px]">{destinationNameLabel(name)}</span>
                                <span className="shrink-0 text-[11px] text-muted-foreground">
                                  {formatProtocolLabel(name.protocol)}
                                </span>
                                {name.category !== group.category ? (
                                  <CategoryChip category={name.category} className="shrink-0" />
                                ) : null}
                              </div>
                            </td>
                            <td>
                              <ShareBar
                                percentage={group.totalBytes > 0 ? (name.totalBytes / group.totalBytes) * 100 : 0}
                                color="var(--series-other)"
                              />
                            </td>
                            {!compact ? (
                              <td className="text-right font-mono tabular-nums">{formatBytes(name.bytesIn)}</td>
                            ) : null}
                            {!compact ? (
                              <td className="text-right font-mono tabular-nums">{formatBytes(name.bytesOut)}</td>
                            ) : null}
                            <td className="text-right font-mono tabular-nums">{formatBytes(name.totalBytes)}</td>
                            {!compact ? <td /> : null}
                          </tr>
                          {nameOpen && name.serverName && window ? (
                            <tr className="bg-muted/10">
                              <td />
                              <td colSpan={columnCount - 1} className="py-3">
                                <DestinationTimeSeries serverName={name.serverName} window={window} />
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      )
                    })
                  : null}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
