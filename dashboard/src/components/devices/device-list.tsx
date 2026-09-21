import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { CaretDown, CaretRight } from '@phosphor-icons/react'
import { BandwidthChart } from '@/components/charts/bandwidth-chart'
import { PeersPanel } from '@/components/devices/peers-panel'
import { ProtocolBreakdownPanel } from '@/components/devices/protocol-breakdown-panel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useDeviceOverview, useDeviceTraffic } from '@/hooks/use-devices'
import { deviceDisplayName, deviceTypeMeta } from '@/lib/device-labels'
import { formatBytes, formatMbps } from '@/lib/format-bytes'
import type { RefreshInterval, TimeWindow } from '@/lib/time-window'
import { bucketsToChartPoints, macPath } from '@/lib/traffic'
import { cn } from '@/lib/utils'
import { formatSignal, formatWifiBand, wifiSignalQualityDotClass } from '@/lib/wifi'
import {
  apiScopeForDashboard,
  type DashboardScope,
  type DeviceSummary,
  type TrafficResolution,
} from '@/types/api'

type DeviceListProps = {
  devices: DeviceSummary[]
  window: TimeWindow
  resolution: TrafficResolution
  refreshInterval: RefreshInterval
  scope: DashboardScope
}

/**
 * Picks the (mbpsIn, mbpsOut, bytesIn, bytesOut) tuple that matches the
 * dashboard scope. WAN/LAN read the per-scope splits the transformer
 * surfaces; `all` falls back to the totals so legacy buckets without
 * scope data still render with non-zero rates. `overlay` shows WAN as
 * the headline rate (the LAN context is rendered inside the expanded
 * chart, not on the row itself).
 */
function pickRates(device: DeviceSummary, scope: DashboardScope) {
  if (scope === 'wan' || scope === 'overlay') {
    return {
      mbpsIn: device.mbpsInWan,
      mbpsOut: device.mbpsOutWan,
      bytesIn: device.bytesInWan,
      bytesOut: device.bytesOutWan,
    }
  }
  if (scope === 'lan') {
    return {
      mbpsIn: device.mbpsInLan,
      mbpsOut: device.mbpsOutLan,
      bytesIn: device.bytesInLan,
      bytesOut: device.bytesOutLan,
    }
  }
  return {
    mbpsIn: device.mbpsIn,
    mbpsOut: device.mbpsOut,
    bytesIn: device.bytesIn,
    bytesOut: device.bytesOut,
  }
}

export function DeviceList({
  devices,
  window,
  resolution,
  refreshInterval,
  scope,
}: DeviceListProps) {
  const [expanded, setExpanded] = useState<string | null>(devices[0]?.mac ?? null)

  if (devices.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No devices yet. Traffic appears here once the collector poller has run
        at least once.
      </p>
    )
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="grid grid-cols-[1fr_auto_auto] gap-3 border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground md:grid-cols-[1.3fr_0.8fr_0.7fr_0.7fr_0.7fr]">
        <span>Device</span>
        <span className="hidden md:block">Collector</span>
        <span className="text-right">Down</span>
        <span className="hidden text-right md:block">Up</span>
        <span className="text-right">Total</span>
      </div>
      <div className="divide-y divide-border">
        {devices.map((device) => (
          <DeviceRow
            key={`${device.collector.id}-${device.mac}`}
            device={device}
            expanded={expanded === device.mac}
            onToggle={() => setExpanded(expanded === device.mac ? null : device.mac)}
            window={window}
            resolution={resolution}
            refreshInterval={refreshInterval}
            scope={scope}
          />
        ))}
      </div>
    </div>
  )
}

function DeviceRow({
  device,
  expanded,
  onToggle,
  window,
  resolution,
  refreshInterval,
  scope,
}: {
  device: DeviceSummary
  expanded: boolean
  onToggle: () => void
  window: TimeWindow
  resolution: TrafficResolution
  refreshInterval: RefreshInterval
  scope: DashboardScope
}) {
  const rates = pickRates(device, scope)
  const total = rates.bytesIn + rates.bytesOut
  const apiScope = apiScopeForDashboard(scope)
  const isOverlay = scope === 'overlay'
  const overview = useDeviceOverview(expanded ? device.mac : undefined, {
    window,
    resolution,
    scope: apiScope,
    refreshInterval,
  })
  const overlayTraffic = useDeviceTraffic(expanded ? device.mac : undefined, {
    window,
    resolution,
    scope: 'lan',
    refreshInterval,
    enabled: expanded && isOverlay,
  })
  const chartData = useMemo(
    () =>
      overview.data
        ? bucketsToChartPoints(
            overview.data.traffic.buckets,
            isOverlay ? overlayTraffic.data?.buckets : undefined,
          )
        : [],
    [overview.data, overlayTraffic.data, isOverlay],
  )

  const displayName = deviceDisplayName(device)
  const typeMeta = deviceTypeMeta(device.deviceType)

  return (
    <div className={cn(expanded && 'bg-muted/10')}>
      <button
        type="button"
        onClick={onToggle}
        className="grid w-full grid-cols-[1fr_auto_auto] items-center gap-3 px-4 py-3 text-left text-xs transition-colors hover:bg-muted/30 md:grid-cols-[1.3fr_0.8fr_0.7fr_0.7fr_0.7fr]"
      >
        <span className="flex min-w-0 items-center gap-2">
          {expanded ? <CaretDown className="size-3.5" /> : <CaretRight className="size-3.5" />}
          <span className="min-w-0">
            <span className="flex min-w-0 items-center gap-2">
              {typeMeta ? (
                <typeMeta.Icon className="size-3.5 shrink-0 text-muted-foreground" weight="duotone" />
              ) : null}
              <span className="truncate font-medium">{displayName}</span>
              <Badge variant="outline" className="rounded-md px-1.5 py-0 text-[10px]">
                {device.wifi.connected ? 'WiFi' : 'LAN/unknown'}
              </Badge>
            </span>
            <span className="block truncate font-mono text-muted-foreground">{device.mac}</span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
              <span
                className={`inline-block size-1.5 rounded-full ${
                  device.wifi.connected
                    ? wifiSignalQualityDotClass(device.wifi.signalQuality)
                    : 'bg-muted-foreground/50'
                }`}
              />
              <span className="truncate">
                {device.wifi.connected
                  ? `WiFi · ${device.wifi.ap} · ${device.wifi.ssid ?? 'Unknown SSID'} · ${formatWifiBand(device.wifi.band)} · ${formatSignal(device.wifi.signalDbm)}`
                  : 'LAN / unknown'}
              </span>
            </span>
          </span>
        </span>
        <span className="hidden items-center gap-2 md:flex">
          <span>{device.collector.name}</span>
          {device.collector.lastStatus?.ok === false ? (
            <Badge variant="destructive" className="rounded-md">
              offline
            </Badge>
          ) : null}
        </span>
        <span className="text-right font-medium tabular-nums">
          {formatMbps(rates.mbpsIn)}
        </span>
        <span className="hidden text-right tabular-nums md:block">
          {formatMbps(rates.mbpsOut)}
        </span>
        <span className="text-right tabular-nums">{formatBytes(total)}</span>
      </button>

      {expanded ? (
        <div className="grid gap-4 border-t bg-background/60 p-4 md:grid-cols-2 xl:grid-cols-[1.2fr_1fr_0.8fr_0.8fr]">
          <section className="min-w-0 space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Rate</h3>
              <Button asChild variant="outline" size="sm">
                <Link to={`/devices/${macPath(device.mac)}`}>Detail</Link>
              </Button>
            </div>
            {overview.isPending ? (
              <p className="text-sm text-muted-foreground">Loading rate…</p>
            ) : chartData.length > 0 ? (
              <BandwidthChart
                data={chartData}
                showOverlay={isOverlay}
                className="h-[180px] w-full"
              />
            ) : (
              <p className="text-sm text-muted-foreground">No buckets in this window.</p>
            )}
          </section>

          <section className="min-w-0 space-y-2">
            <h3 className="text-sm font-medium">Flows</h3>
            <PeersPanel
              peers={overview.data?.peers.wan ?? []}
              scope="wan"
              isPending={overview.isPending}
              error={overview.error}
              compact
              initialLimit={5}
            />
          </section>

          <section className="min-w-0 space-y-2">
            <h3 className="text-sm font-medium">Protocols</h3>
            <ProtocolBreakdownPanel
              protocols={overview.data?.protocols ?? []}
              isPending={overview.isPending}
              error={overview.error}
              compact
              initialLimit={5}
            />
          </section>

          <section className="min-w-0 space-y-2">
            <h3 className="text-sm font-medium">Top ASNs</h3>
            <div className="space-y-2">
              {(overview.data?.topAsns ?? []).slice(0, 5).map((asn) => (
                <div key={`${asn.asn ?? 'unknown'}-${asn.org}`} className="rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{asn.org}</p>
                      <p className="text-xs text-muted-foreground">
                        {asn.asn ? `AS${asn.asn}` : 'Unknown ASN'}
                      </p>
                    </div>
                    <Badge variant="outline" className="rounded-md">
                      {formatBytes(asn.totalBytes)}
                    </Badge>
                  </div>
                  <p className="mt-2 truncate font-mono text-xs text-muted-foreground">
                    {asn.peers.map((peer) => peer.ip).join(', ')}
                  </p>
                </div>
              ))}
              {!overview.isPending && (overview.data?.topAsns.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground">No WAN ASN data yet.</p>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}
