import { useState } from 'react'
import { Link } from 'react-router-dom'
import { NotReported, ObservedLine, StateChip, TableScroll } from '@/components/gateway/observation-bits'
import { EmptyState } from '@/components/ui/empty-state'
import { Panel } from '@/components/ui/panel'
import { formatLastSeen } from '@/lib/collectors'
import { formatDateTime, formatRelative } from '@/lib/gateway-observation'
import { macPath } from '@/lib/traffic'
import { cn } from '@/lib/utils'
import type { GatewayDeviceRef, GatewayUpnpResponse, UpnpMapping } from '@/types/api'

const EVENTS_SHOWN = 12

type GatewayUpnpPanelProps = {
  data: GatewayUpnpResponse | undefined
  isPending: boolean
  error: Error | null
  reported: boolean
}

function DeviceName({ device, ip }: { device: GatewayDeviceRef | null; ip: string }) {
  if (!device) return <span className="text-muted-foreground">{ip}</span>
  return (
    <Link to={`/devices/${macPath(device.mac)}`} className="font-medium underline-offset-2 hover:underline">
      {device.name ?? device.mac}
    </Link>
  )
}

/** A mapping's lifetime: "permanent" or "in 40 min". */
function expiry(mapping: Pick<UpnpMapping, 'expiresAt'>): string {
  return mapping.expiresAt ? formatRelative(mapping.expiresAt) : 'permanent'
}

/**
 * Ports devices opened on the router with UPnP (miniupnpd), and the recent
 * opened / closed history. Read-only: Perch does not add or remove mappings.
 */
export function GatewayUpnpPanel({ data, isPending, error, reported }: GatewayUpnpPanelProps) {
  const [showAllEvents, setShowAllEvents] = useState(false)
  const events = data?.events ?? []
  const shownEvents = showAllEvents ? events : events.slice(0, EVENTS_SHOWN)

  return (
    <Panel
      title="UPnP port mappings"
      description={
        data ? (
          <ObservedLine observedAt={data.observedAt} stale={data.observedAt !== null && data.stale} />
        ) : (
          'Ports devices opened on the router.'
        )
      }
      actions={
        data && data.installed ? (
          <div className="flex flex-wrap gap-1">
            <StateChip label="enabled" value={data.enabled} tone="neutral" />
            <StateChip label="running" value={data.running} tone="neutral" />
          </div>
        ) : null
      }
      flush
    >
      {isPending ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">Loading UPnP…</p>
      ) : error ? (
        <p className="px-4 pb-4 text-xs text-destructive">{error.message}</p>
      ) : !reported || !data ? (
        <div className="px-4 pb-4">
          <NotReported what="UPnP state" />
        </div>
      ) : data.installed === false ? (
        <div className="px-4 pb-4">
          <EmptyState
            title="UPnP is not installed on the router"
            description="No miniupnpd package, so no device can open ports on its own. Port forwards set up by hand are not listed here."
          />
        </div>
      ) : (
        <div className="space-y-3">
          {data.mappings.length === 0 ? (
            <div className="px-4">
              <EmptyState
                title="No open mappings"
                description={
                  data.running === false
                    ? 'miniupnpd is not running, so nothing can open ports right now.'
                    : 'No device holds a UPnP port mapping right now.'
                }
              />
            </div>
          ) : (
            <TableScroll>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>External</th>
                    <th>Forwards to</th>
                    <th>Device</th>
                    <th>Description</th>
                    <th>Expires</th>
                    <th>Open since</th>
                  </tr>
                </thead>
                <tbody>
                  {data.mappings.map((m) => (
                    <tr key={`${m.proto}-${m.externalPort}`}>
                      <td className="whitespace-nowrap font-mono text-[12px]">
                        {m.proto} {m.externalPort}
                      </td>
                      <td className="whitespace-nowrap font-mono text-[12px]">
                        {m.internalIp}:{m.internalPort}
                      </td>
                      <td className="whitespace-nowrap">
                        <DeviceName device={m.device} ip={m.internalIp} />
                      </td>
                      <td className="max-w-[14rem] truncate" title={m.description ?? undefined}>
                        {m.description ?? '—'}
                      </td>
                      <td className="whitespace-nowrap" title={formatDateTime(m.expiresAt)}>
                        {expiry(m)}
                      </td>
                      <td className="whitespace-nowrap text-muted-foreground" title={formatDateTime(m.firstSeenAt)}>
                        {formatLastSeen(m.firstSeenAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}

          <div className="border-t border-border/70 px-4 pt-3 pb-4">
            <p className="section-label mb-2">Recent events</p>
            {events.length === 0 ? (
              <p className="text-xs text-muted-foreground">No mapping opened or closed yet.</p>
            ) : (
              <ul className="space-y-1.5 text-[12.5px]">
                {shownEvents.map((event) => (
                  <li key={event.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <span className="min-w-0">
                      <span
                        className={cn(
                          'mr-1.5 inline-block w-14 font-medium',
                          event.event === 'opened' ? 'text-status-good' : 'text-muted-foreground',
                        )}
                      >
                        {event.event}
                      </span>
                      <span className="font-mono text-[12px]">
                        {event.proto} {event.externalPort} → {event.internalIp}:{event.internalPort}
                      </span>{' '}
                      {event.device ? (
                        <>
                          · <DeviceName device={event.device} ip={event.internalIp} />
                        </>
                      ) : null}
                      {event.description ? <span className="text-muted-foreground"> · {event.description}</span> : null}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground" title={formatDateTime(event.at)}>
                      {formatLastSeen(event.at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {events.length > EVENTS_SHOWN ? (
              <button
                type="button"
                className="mt-2 text-xs text-brand hover:underline"
                onClick={() => setShowAllEvents((v) => !v)}
              >
                {showAllEvents ? 'Show fewer' : `Show all ${events.length}`}
              </button>
            ) : null}
          </div>
        </div>
      )}
    </Panel>
  )
}
