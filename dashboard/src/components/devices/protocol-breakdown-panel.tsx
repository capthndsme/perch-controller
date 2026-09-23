import { Fragment, useState } from 'react'
import { Link } from 'react-router-dom'
import { CaretDown, CaretRight } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { useProtocolTopDevices } from '@/hooks/use-devices'
import { deviceDisplayName } from '@/lib/device-names'
import { formatBytes } from '@/lib/format-bytes'
import { formatProtocolLabel, protocolTotalBytes } from '@/lib/protocols'
import type { RefreshInterval, TimeWindow } from '@/lib/time-window'
import { macPath } from '@/lib/traffic'
import type { ProtocolBreakdown, ProtocolTopDevice } from '@/types/api'

type ProtocolBreakdownPanelProps = {
  protocols: ProtocolBreakdown[]
  isPending: boolean
  error: Error | null
  compact?: boolean
  initialLimit?: number
  topDevices?: ProtocolTopDevicesOptions
  /** Column heading for the key column (default "Protocol"). */
  keyHeading?: string
  /** Display label per key; defaults to the protocol label table. */
  labelFor?: (key: string) => string
  /** Swatch colour per key; when set a colour dot precedes the label. */
  colorFor?: (key: string) => string
}

export type ProtocolTopDevicesOptions = {
  window: TimeWindow
  collectorId?: number
  refreshInterval?: RefreshInterval
  limit?: number
}

export function ProtocolBreakdownPanel({
  protocols,
  isPending,
  error,
  compact = false,
  initialLimit = 8,
  topDevices,
  keyHeading = 'Protocol',
  labelFor = formatProtocolLabel,
  colorFor,
}: ProtocolBreakdownPanelProps) {
  const [showAll, setShowAll] = useState(false)
  const [expandedProtocol, setExpandedProtocol] = useState<string | null>(null)
  const canDrillDown = Boolean(topDevices) && !compact

  if (isPending) {
    return <p className="text-sm text-muted-foreground">Loading protocols…</p>
  }

  if (error) {
    return <p className="text-sm text-destructive">{error.message}</p>
  }

  if (protocols.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No protocol breakdown yet. Traffic appears here once the collector classifies packets.
      </p>
    )
  }

  const visibleCount = showAll ? protocols.length : Math.min(initialLimit, protocols.length)
  const hidden = protocols.length - visibleCount
  const visibleProtocols = protocols.slice(0, visibleCount)
  const columnCount = compact ? 3 : 5

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-xs">
          <thead className="border-b bg-muted/30 text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">{keyHeading}</th>
              {!compact ? <th className="px-4 py-2 font-medium text-right">Share</th> : null}
              <th className="px-4 py-2 font-medium text-right">Download</th>
              {!compact ? <th className="px-4 py-2 font-medium text-right">Upload</th> : null}
              <th className="px-4 py-2 font-medium text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {visibleProtocols.map((entry) => {
              const total = protocolTotalBytes(entry)
              const isExpanded = expandedProtocol === entry.protocol
              return (
                <Fragment key={entry.protocol}>
                  <tr className="border-b last:border-0">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {canDrillDown ? (
                          <button
                            type="button"
                            className="rounded-sm text-muted-foreground transition-colors hover:text-foreground"
                            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${labelFor(
                              entry.protocol,
                            )} top devices`}
                            onClick={() =>
                              setExpandedProtocol(isExpanded ? null : entry.protocol)
                            }
                          >
                            {isExpanded ? (
                              <CaretDown className="size-3.5" />
                            ) : (
                              <CaretRight className="size-3.5" />
                            )}
                          </button>
                        ) : null}
                        <div className="space-y-1">
                          <p className="flex items-center gap-1.5 font-medium">
                            {colorFor ? (
                              <span
                                aria-hidden
                                className="inline-block size-2 shrink-0 rounded-full"
                                style={{ backgroundColor: colorFor(entry.protocol) }}
                              />
                            ) : null}
                            {labelFor(entry.protocol)}
                          </p>
                          <p className="font-mono text-[10px] text-muted-foreground">
                            {entry.protocol}
                          </p>
                        </div>
                      </div>
                    </td>
                    {!compact ? (
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-primary/70"
                              style={{ width: `${Math.min(entry.percentage, 100)}%` }}
                            />
                          </div>
                          <span className="w-10 text-right tabular-nums">{entry.percentage}%</span>
                        </div>
                      </td>
                    ) : null}
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatBytes(entry.bytesIn)}
                    </td>
                    {!compact ? (
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatBytes(entry.bytesOut)}
                      </td>
                    ) : null}
                    <td className="px-4 py-3 text-right font-medium tabular-nums">
                      {formatBytes(total)}
                    </td>
                  </tr>
                  {isExpanded && topDevices ? (
                    <tr className="border-b bg-muted/10">
                      <td colSpan={columnCount} className="px-4 py-3">
                        <ProtocolTopDevicesDetail
                          protocol={entry.protocol}
                          options={topDevices}
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      {protocols.length > initialLimit ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground"
          onClick={() => setShowAll((current) => !current)}
        >
          {showAll ? 'Show less' : `Show ${hidden} more`}
        </Button>
      ) : null}
    </div>
  )
}

function ProtocolTopDevicesDetail({
  protocol,
  options,
}: {
  protocol: string
  options: ProtocolTopDevicesOptions
}) {
  const topDevices = useProtocolTopDevices(protocol, {
    window: options.window,
    collectorId: options.collectorId,
    refreshInterval: options.refreshInterval,
    limit: options.limit ?? 5,
  })

  if (topDevices.isPending) {
    return <p className="text-sm text-muted-foreground">Loading top devices…</p>
  }

  if (topDevices.error) {
    return <p className="text-sm text-destructive">{topDevices.error.message}</p>
  }

  const rows = topDevices.data?.devices ?? []
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No devices for this protocol in this window.</p>
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Top devices
      </p>
      <div className="overflow-x-auto rounded-md border border-border/70">
        <table className="w-full text-left text-xs">
          <thead className="border-b bg-background/60 text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Device</th>
              <th className="px-3 py-2 font-medium text-right">Share</th>
              <th className="px-3 py-2 font-medium text-right">Download</th>
              <th className="px-3 py-2 font-medium text-right">Upload</th>
              <th className="px-3 py-2 font-medium text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/70">
            {rows.map((device) => (
              <ProtocolTopDeviceRow key={`${device.collectorId}-${device.mac}`} device={device} />
            ))}
            {topDevices.data?.other ? (
              <tr className="text-muted-foreground">
                <td className="px-3 py-2">
                  <div className="space-y-0.5">
                    <p className="font-medium text-foreground/80">
                      Other devices
                    </p>
                    <p>{topDevices.data.other.deviceCount} more</p>
                  </div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {topDevices.data.other.percentage}%
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatBytes(topDevices.data.other.bytesIn)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatBytes(topDevices.data.other.bytesOut)}
                </td>
                <td className="px-3 py-2 text-right font-medium tabular-nums">
                  {formatBytes(topDevices.data.other.totalBytes)}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ProtocolTopDeviceRow({ device }: { device: ProtocolTopDevice }) {
  const displayName = deviceDisplayName(device)

  return (
    <tr>
      <td className="px-3 py-2">
        <div className="space-y-0.5">
          <Link
            to={`/devices/${macPath(device.mac)}`}
            className="font-medium transition-colors hover:text-primary"
          >
            {displayName}
          </Link>
          <p className="font-mono text-[10px] text-muted-foreground">{device.mac}</p>
        </div>
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{device.percentage}%</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatBytes(device.bytesIn)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatBytes(device.bytesOut)}</td>
      <td className="px-3 py-2 text-right font-medium tabular-nums">
        {formatBytes(device.totalBytes)}
      </td>
    </tr>
  )
}
