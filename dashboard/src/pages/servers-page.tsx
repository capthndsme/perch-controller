import { Fragment, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { CaretDown, CaretRight, HardDrives } from '@phosphor-icons/react'
import { useQueryClient } from '@tanstack/react-query'
import { ServiceTrafficChart } from '@/components/charts/service-traffic-chart'
import {
  resolutionNoun,
  SERVICE_5M_RETENTION_DAYS,
  serviceBucketsToPoints,
  serviceResolutionFor,
} from '@/lib/services'
import { TimePicker } from '@/components/dashboard/time-picker'
import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { KpiTile } from '@/components/ui/kpi-tile'
import { Panel } from '@/components/ui/panel'
import { ShareBar } from '@/components/ui/share-bar'
import { useDashboardTime } from '@/hooks/use-dashboard-time'
import { useServiceTraffic, useServices } from '@/hooks/use-services'
import { deviceDisplayName } from '@/lib/device-names'
import { formatBytes } from '@/lib/format-bytes'
import { formatProtocolLabel } from '@/lib/protocols'
import type { TimeWindow } from '@/lib/time-window'
import { macPath } from '@/lib/traffic'
import type { ServiceSummary } from '@/types/api'

const DEFAULT_SERVERS_WINDOW: TimeWindow = { kind: 'relative', range: '7d' }

function ServiceTimeSeries({ serverName, window }: { serverName: string; window: TimeWindow }) {
  const requested = serviceResolutionFor(window)
  const traffic = useServiceTraffic(serverName, { window, resolution: requested })
  const points = useMemo(
    () => serviceBucketsToPoints(traffic.data?.buckets ?? [], traffic.data?.resolutionSeconds),
    [traffic.data],
  )

  if (traffic.isPending) return <p className="text-xs text-muted-foreground">Loading history…</p>
  if (traffic.error) return <p className="text-xs text-destructive">{traffic.error.message}</p>
  if (!traffic.data || points.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No per-{resolutionNoun(requested)} history for this name yet.</p>
    )
  }
  // The API answers hourly for a short window older than the 5-minute tier.
  const served = traffic.data.resolution
  const downgraded = requested === '5m' && served !== '5m'
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="section-label">Served / received per {resolutionNoun(served)}</p>
        <p className="text-[11px] text-muted-foreground">
          Detail: {resolutionNoun(served)}
          {downgraded ? ` · 5-minute detail is kept for ${SERVICE_5M_RETENTION_DAYS} days` : ''}
          {served === '5m' ? ' · the dashed lines are the average rate of each slot' : ''}
        </p>
      </div>
      <ServiceTrafficChart data={points} rateOverlay="on" className="h-[236px] w-full" />
    </div>
  )
}

/**
 * "How many GB have my servers pushed": server-side bytes grouped by TLS
 * SNI / HTTP host, plus the per-server roll-up.
 */
export function ServersPage() {
  const queryClient = useQueryClient()
  const {
    window,
    resolutionMode,
    refreshInterval,
    setWindow,
    setResolutionMode,
    setRefreshInterval,
  } = useDashboardTime(DEFAULT_SERVERS_WINDOW)
  const services = useServices({ window, limit: 100, refreshInterval })
  const [open, setOpen] = useState<string | null>(null)

  const data = services.data
  const unavailable = services.isSuccess && data === null
  const topService = data?.services[0]
  const topServer = data?.servers[0]

  const header = (
    <PageHeader
      title="Servers"
      description="How many GB the servers on this network have pushed, by server name (TLS SNI / HTTP host)."
      actions={
        <TimePicker
          window={window}
          resolutionMode={resolutionMode}
          refreshInterval={refreshInterval}
          onWindowChange={setWindow}
          onResolutionModeChange={setResolutionMode}
          onRefreshIntervalChange={setRefreshInterval}
          onRefreshNow={() => queryClient.invalidateQueries()}
        />
      }
    />
  )

  if (unavailable) {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <EmptyState
          icon={<HardDrives className="size-6" />}
          title="Waiting for the collector update"
          description="Server-name accounting needs the collector and API builds that record TLS SNI per server. Nothing to show yet."
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {header}

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiTile label="Served" value={formatBytes(data?.totalBytesServed ?? 0)} sub="pushed to clients in window" />
        <KpiTile label="Received" value={formatBytes(data?.totalBytesReceived ?? 0)} sub="uploads from clients" />
        <KpiTile
          label="Top server name"
          value={<span className="text-lg">{topService?.serverName ?? '—'}</span>}
          sub={topService ? `${formatBytes(topService.bytesServed)} served` : 'no server traffic yet'}
        />
        <KpiTile
          label="Busiest server"
          value={<span className="text-lg">{topServer ? deviceDisplayName(topServer) : '—'}</span>}
          sub={topServer ? `${formatBytes(topServer.bytesServed)} · ${topServer.serviceCount} names` : ''}
        />
      </div>

      <Panel
        title="By server name"
        description="Expand a name for its served / received history."
        updating={services.isPlaceholderData}
        flush
      >
        {services.isPending ? (
          <p className="px-4 pb-4 text-xs text-muted-foreground">Loading services…</p>
        ) : services.error ? (
          <p className="px-4 pb-4 text-xs text-destructive">{services.error.message}</p>
        ) : !data || data.services.length === 0 ? (
          <div className="px-4 pb-4">
            <EmptyState
              title="No server traffic in this window"
              description="Names appear once a device on this network has served TLS or HTTP traffic that the collector could label."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="w-6" />
                  <th>Server name</th>
                  <th>Protocol</th>
                  <th className="text-right">Served</th>
                  <th className="text-right">Received</th>
                  <th className="text-right">Share</th>
                  <th>Served by</th>
                </tr>
              </thead>
              <tbody>
                {data.services.map((service: ServiceSummary) => {
                  const key = `${service.serverName}|${service.protocol}`
                  const isOpen = open === key
                  return (
                    <Fragment key={key}>
                      <tr data-clickable="true" onClick={() => setOpen(isOpen ? null : key)} aria-expanded={isOpen}>
                        <td className="pr-0 text-muted-foreground">
                          {isOpen ? <CaretDown className="size-3.5" /> : <CaretRight className="size-3.5" />}
                        </td>
                        <td className="font-mono text-[12px] font-medium">{service.serverName}</td>
                        <td className="text-[12px]">{formatProtocolLabel(service.protocol)}</td>
                        <td className="text-right font-mono font-medium tabular-nums">{formatBytes(service.bytesServed)}</td>
                        <td className="text-right font-mono tabular-nums">{formatBytes(service.bytesReceived)}</td>
                        <td>
                          <ShareBar percentage={service.percentage} color="var(--chart-served)" />
                        </td>
                        <td className="text-[12px]">
                          {service.servers.slice(0, 3).map((server, index) => (
                            <span key={server.mac}>
                              {index > 0 ? ', ' : ''}
                              <Link
                                to={`/devices/${macPath(server.mac)}`}
                                className="hover:text-brand"
                                onClick={(event) => event.stopPropagation()}
                              >
                                {deviceDisplayName(server)}
                              </Link>
                            </span>
                          ))}
                          {service.servers.length > 3 ? (
                            <span className="text-muted-foreground"> +{service.servers.length - 3}</span>
                          ) : null}
                        </td>
                      </tr>
                      {isOpen ? (
                        <tr className="bg-muted/20">
                          <td />
                          <td colSpan={6} className="py-3">
                            <ServiceTimeSeries serverName={service.serverName} window={window} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="By server" description="Devices that acted as servers in the window." updating={services.isPlaceholderData} flush>
        {!data || data.servers.length === 0 ? (
          <div className="px-4 pb-4">
            <EmptyState title="No servers in this window" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Server</th>
                  <th className="text-right">Names</th>
                  <th className="text-right">Served</th>
                  <th className="text-right">Received</th>
                  <th className="text-right">Share</th>
                </tr>
              </thead>
              <tbody>
                {data.servers.map((server) => {
                  const pct = data.totalBytesServed > 0 ? (server.bytesServed / data.totalBytesServed) * 100 : 0
                  return (
                    <tr key={server.mac}>
                      <td>
                        <Link to={`/devices/${macPath(server.mac)}`} className="block hover:text-brand">
                          <span className="block truncate font-medium">
                            {deviceDisplayName(server)}
                          </span>
                          <span className="block truncate font-mono text-[11px] text-muted-foreground">
                            {server.primaryIp ?? '—'} · {server.mac}
                          </span>
                        </Link>
                      </td>
                      <td className="text-right font-mono tabular-nums">{server.serviceCount}</td>
                      <td className="text-right font-mono font-medium tabular-nums">{formatBytes(server.bytesServed)}</td>
                      <td className="text-right font-mono tabular-nums">{formatBytes(server.bytesReceived)}</td>
                      <td>
                        <ShareBar percentage={pct} color="var(--chart-served)" />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  )
}
