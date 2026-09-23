import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowsClockwise, Broadcast, ChartLineUp, Cpu } from '@phosphor-icons/react'
import { useQueryClient } from '@tanstack/react-query'
import { PageHeader } from '@/components/layout/page-header'
import { TimePicker } from '@/components/dashboard/time-picker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Segmented } from '@/components/ui/segmented'
import { useDashboardTime } from '@/hooks/use-dashboard-time'
import { useDevices } from '@/hooks/use-devices'
import { useWifiApThroughput, useWifiClients, useWifiOverview, useWifiClientsHistory } from '@/hooks/use-wifi'
import { deviceDisplayName } from '@/lib/device-names'
import { formatBytes, formatMbps } from '@/lib/format-bytes'
import {
  RATE_DIRECTION_OPTIONS,
  RATE_MODE_OPTIONS,
  apColorMap,
  apThroughputToRateData,
  type RateChartDirection,
  type RateChartMode,
} from '@/lib/rate-series'
import { type TimeWindow } from '@/lib/time-window'
import { formatSignal, formatWifiBand, wifiSignalQualityDotClass, wifiSignalQualityLabel } from '@/lib/wifi'
import { macPath } from '@/lib/traffic'
import { ClientDistributionChart } from '@/components/charts/client-distribution-chart'
import { SeriesRateChart } from '@/components/charts/series-rate-chart'
import type { DeviceSummary } from '@/types/api'

const DEFAULT_WIFI_WINDOW: TimeWindow = { kind: 'relative', range: '24h' }

export function WifiPage() {
  const [groupBy, setGroupBy] = useState<'band' | 'ap'>('band')
  const [apMode, setApMode] = useState<RateChartMode>('lines')
  const [apDirection, setApDirection] = useState<RateChartDirection>('both')
  const queryClient = useQueryClient()
  // Window / resolution live in the URL (shareable + reload-persistent).
  const {
    window,
    resolutionMode,
    resolution,
    refreshInterval,
    setWindow,
    setResolutionMode,
    setRefreshInterval,
  } = useDashboardTime(DEFAULT_WIFI_WINDOW)

  const overview = useWifiOverview({ window, refreshInterval })
  const clients = useWifiClients({ refreshInterval, activeOnly: true })
  const devices = useDevices({ window, refreshInterval })
  const history = useWifiClientsHistory({ window, resolution, refreshInterval })
  const apThroughput = useWifiApThroughput({ window, resolution, refreshInterval })
  // One colour per AP across both charts (throughput and client counts).
  const apColors = useMemo(
    () =>
      apColorMap([
        ...(apThroughput.data?.aps ?? []).map((ap) => ap.friendlyName ?? ap.name),
        ...(history.data?.allAps ?? []),
      ]),
    [apThroughput.data, history.data]
  )
  const apRate = useMemo(
    () =>
      apThroughput.data
        ? apThroughputToRateData(apThroughput.data, apColors)
        : { series: [], points: [] },
    [apThroughput.data, apColors]
  )

  const mergedActiveClients = useMemo(() => {
    const byMac = new Map<string, DeviceSummary[]>()
    for (const device of devices.data ?? []) {
      const key = device.mac.toLowerCase()
      const current = byMac.get(key) ?? []
      current.push(device)
      byMac.set(key, current)
    }

    return (clients.data ?? [])
      .map((client) => {
        const matches = byMac.get(client.mac.toLowerCase()) ?? []
        const matchedDevice =
          matches.find((device) => device.wifi.connected && device.wifi.apId === client.apId) ?? matches[0]
        return {
          client,
          matchedDevice,
          displayName: deviceDisplayName({
            ...client,
            customName: client.customName ?? matchedDevice?.customName,
            hostname: matchedDevice?.hostname ?? client.hostname,
          }),
        }
      })
      .sort((left, right) => (right.client.signalDbm ?? -999) - (left.client.signalDbm ?? -999))
  }, [clients.data, devices.data])

  const signalSummary = useMemo(() => {
    const dist = overview.data?.signalDistribution
    if (!dist) return '—'
    return [
      `Excellent ${dist.excellent}`,
      `Good ${dist.good + dist.veryGood}`,
      `Weak ${dist.weak + dist.veryWeak}`,
    ].join(' · ')
  }, [overview.data])

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="WiFi"
        description="Clients, SSIDs, RF and access-point health from the OpenWrt APs."
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

      <div className="grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
        <StatCard
          label="Connected clients"
          value={String(overview.data?.totalClients ?? 0)}
          sub="connected now"
          icon={<Broadcast className="size-4" />}
        />
        <Card className="rounded-xl py-3 shadow-sm border border-border">
          <CardHeader className="flex-row items-center justify-between gap-3 px-3 pb-2">
            <CardTitle className="text-xs text-muted-foreground">Peak clients</CardTitle>
            <span className="text-muted-foreground">
              <ChartLineUp className="size-4" />
            </span>
          </CardHeader>
          <CardContent className="px-3 pt-0 pb-1">
            <div className="grid grid-cols-3 gap-1 text-center">
              <div>
                <p className="text-lg font-semibold tabular-nums text-foreground">
                  {overview.data?.peakClientsToday ?? '—'}
                </p>
                <p className="text-[9px] text-muted-foreground uppercase tracking-wider font-medium">Today</p>
              </div>
              <div className="border-x border-border">
                <p className="text-lg font-semibold tabular-nums text-foreground">
                  {overview.data?.peakClients7d ?? '—'}
                </p>
                <p className="text-[9px] text-muted-foreground uppercase tracking-wider font-medium">7d</p>
              </div>
              <div>
                <p className="text-lg font-semibold tabular-nums text-foreground">
                  {overview.data?.peakClientsAllTime ?? '—'}
                </p>
                <p className="text-[9px] text-muted-foreground uppercase tracking-wider font-medium">All</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <StatCard
          label="SSIDs"
          value={String(overview.data?.ssidCount ?? 0)}
          sub="currently observed"
          icon={<Broadcast className="size-4" />}
        />
        <StatCard
          label="Access points"
          value={String(overview.data?.accessPointCount ?? 0)}
          sub="registered and seen"
          icon={<Cpu className="size-4" />}
        />
        <StatCard
          label="Signal mix"
          value={signalSummary}
          sub="quality tiers"
          icon={<ArrowsClockwise className="size-4" />}
        />
      </div>

      <section className="space-y-3 rounded-lg border border-border bg-card p-4 shadow-sm animate-fade-in duration-300">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-sm font-medium">Client distribution</h2>
            <p className="text-xs text-muted-foreground">
              Concurrent connected client count history grouped by WiFi band or access point. Drag across the chart to zoom.
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-border p-0.5 bg-muted/20">
            <Button
              variant={groupBy === 'band' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 px-2.5 text-xs font-medium"
              onClick={() => setGroupBy('band')}
            >
              By Band
            </Button>
            <Button
              variant={groupBy === 'ap' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 px-2.5 text-xs font-medium"
              onClick={() => setGroupBy('ap')}
            >
              By AP
            </Button>
          </div>
        </div>

        {history.isPending ? (
          <div className="flex h-[320px] items-center justify-center text-sm text-muted-foreground">
            Loading client history…
          </div>
        ) : history.error ? (
          <p className="text-sm text-destructive">{history.error.message}</p>
        ) : (
          <ClientDistributionChart
            data={history.data?.buckets ?? []}
            groupBy={groupBy}
            allBands={history.data?.allBands ?? []}
            allAps={history.data?.allAps ?? []}
            range={history.data}
            stepSeconds={history.data?.resolutionSeconds}
            apColor={(name) => apColors.get(name) ?? 'var(--series-other)'}
            className="h-[320px] w-full"
            onZoom={setWindow}
            onResetZoom={() => setWindow(DEFAULT_WIFI_WINDOW)}
            canResetZoom={window.kind === 'absolute'}
          />
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-sm font-medium">Throughput per access point</h2>
            <p className="text-xs text-muted-foreground">
              Client download and upload rate per AP from the radio interface counters
              {apThroughput.data ? ` · ${apThroughput.data.resolution} buckets` : ''}. Drag across the
              chart to zoom.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              size="xs"
              ariaLabel="Chart mode"
              value={apMode}
              onChange={setApMode}
              options={RATE_MODE_OPTIONS}
            />
            <Segmented
              size="xs"
              ariaLabel="Direction"
              value={apDirection}
              onChange={setApDirection}
              options={RATE_DIRECTION_OPTIONS}
            />
          </div>
        </div>

        {apThroughput.isPending ? (
          <div className="flex h-[320px] items-center justify-center text-sm text-muted-foreground">
            Loading AP throughput…
          </div>
        ) : apThroughput.error ? (
          <p className="text-sm text-destructive">{apThroughput.error.message}</p>
        ) : (
          <SeriesRateChart
            series={apRate.series}
            data={apRate.points}
            range={apThroughput.data}
            mode={apMode}
            direction={apDirection}
            className="h-[320px] w-full"
            onZoom={setWindow}
            onResetZoom={() => setWindow(DEFAULT_WIFI_WINDOW)}
            canResetZoom={window.kind === 'absolute'}
            emptyMessage="No AP throughput recorded for this range."
          />
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-sm font-medium">SSIDs</h2>
            <p className="text-xs text-muted-foreground">
              Grouped by network name across all APs in the selected range.
            </p>
          </div>
        </div>
        {overview.isPending ? (
          <p className="text-sm text-muted-foreground">Loading SSID stats…</p>
        ) : overview.error ? (
          <p className="text-sm text-destructive">{overview.error.message}</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <div className="grid grid-cols-[1.2fr_0.7fr_0.8fr_0.8fr_0.9fr] gap-3 border-b bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <span>SSID</span>
              <span className="text-right">Clients</span>
              <span className="text-right">Avg signal</span>
              <span className="text-right">Download</span>
              <span className="text-right">Upload</span>
            </div>
            <div className="divide-y divide-border">
              {(overview.data?.ssids ?? []).map((ssid) => (
                <div
                  key={ssid.ssid}
                  className="grid grid-cols-[1.2fr_0.7fr_0.8fr_0.8fr_0.9fr] items-center gap-3 px-3 py-2 text-xs"
                >
                  <span className="min-w-0">
                    <Link
                      to={`/wifi/ssids/${encodeURIComponent(ssid.ssid)}`}
                      className="truncate font-medium hover:underline"
                    >
                      {ssid.ssid}
                    </Link>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {ssid.accessPoints.join(', ') || 'No AP mapping'}
                    </span>
                  </span>
                  <span className="text-right tabular-nums">{ssid.clientCount}</span>
                  <span className="flex items-center justify-end gap-1.5 tabular-nums">
                    <span className={`inline-block size-2 rounded-full ${wifiSignalQualityDotClass(ssid.signalQuality)}`} />
                    <span>{formatSignal(ssid.averageSignalDbm)}</span>
                  </span>
                  {/* AP-side counters: transmitted = client download, received = client upload. */}
                  <span className="text-right tabular-nums">{formatBytes(ssid.bytesOut)}</span>
                  <span className="text-right tabular-nums">{formatBytes(ssid.bytesIn)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">Active clients</h2>
          <p className="text-xs text-muted-foreground">
            Latest client-side RF state merged with dashboard device identity and throughput.
          </p>
        </div>
        {clients.isPending ? (
          <p className="text-sm text-muted-foreground">Loading clients…</p>
        ) : clients.error ? (
          <p className="text-sm text-destructive">{clients.error.message}</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <div className="grid grid-cols-[1fr_1fr_0.9fr_0.7fr_0.9fr_0.7fr_0.7fr] gap-3 border-b bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <span>Client</span>
              <span>SSID / AP</span>
              <span className="text-right">Signal</span>
              <span className="text-right">Band</span>
              <span className="text-right">PHY TX/RX</span>
              <span className="text-right">Down</span>
              <span className="text-right">Up</span>
            </div>
            <div className="divide-y divide-border">
              {mergedActiveClients.slice(0, 30).map((row) => (
                <div
                  key={row.client.mac}
                  className="grid grid-cols-[1fr_1fr_0.9fr_0.7fr_0.9fr_0.7fr_0.7fr] items-center gap-3 px-3 py-2 text-xs"
                >
                  <span className="min-w-0">
                    <Link
                      to={`/wifi/clients/${encodeURIComponent(row.client.mac)}`}
                      className={`truncate hover:underline ${
                        row.displayName === row.client.mac ? 'font-mono' : 'font-medium'
                      }`}
                    >
                      {row.displayName}
                    </Link>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {row.displayName !== row.client.mac ? (
                        <span className="font-mono">{row.client.mac} · </span>
                      ) : null}
                      <Link to={`/devices/${macPath(row.client.mac)}`} className="hover:underline">
                        Open device detail
                      </Link>
                    </span>
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{row.client.ssid ?? 'Unknown SSID'}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{row.client.ap}</span>
                  </span>
                  <span className="flex items-center justify-end gap-1.5 tabular-nums">
                    <span
                      className={`inline-block size-2 rounded-full ${wifiSignalQualityDotClass(row.client.signalQuality)}`}
                    />
                    <span>{formatSignal(row.client.signalDbm)}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {wifiSignalQualityLabel(row.client.signalQuality)}
                    </span>
                  </span>
                  <span className="text-right tabular-nums">{formatWifiBand(row.client.band)}</span>
                  <span className="text-right tabular-nums">
                    {(row.client.txRateKbps ?? 0) / 1000} / {(row.client.rxRateKbps ?? 0) / 1000} Mbps
                  </span>
                  <span className="text-right tabular-nums">
                    {row.matchedDevice ? formatMbps(row.matchedDevice.mbpsIn) : 'n/a'}
                  </span>
                  <span className="text-right tabular-nums">
                    {row.matchedDevice ? formatMbps(row.matchedDevice.mbpsOut) : 'n/a'}
                  </span>
                </div>
              ))}
            </div>
            {devices.error ? (
              <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
                Device throughput merge unavailable: {devices.error.message}
              </p>
            ) : null}
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">Access points</h2>
          <p className="text-xs text-muted-foreground">
            Latest system health + connected clients per AP.
          </p>
        </div>
        {overview.isPending ? (
          <p className="text-sm text-muted-foreground">Loading AP health…</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {(overview.data?.accessPoints ?? []).map((ap) => (
              <Card key={ap.id} className="rounded-lg py-3">
                <CardHeader className="px-3 pb-2">
                  <CardTitle className="text-sm">
                    {ap.friendlyName ?? ap.name}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 px-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={ap.lastStatus?.ok === false ? 'destructive' : 'outline'}>
                      {ap.lastStatus?.ok === false ? 'offline' : 'online'}
                    </Badge>
                    <Badge variant="outline">{ap.clientCount} clients</Badge>
                    {ap.model ? <Badge variant="outline">{ap.model}</Badge> : null}
                  </div>
                  <p className="text-muted-foreground">
                    Load {ap.system?.load1?.toFixed(2) ?? 'n/a'} · Mem{' '}
                    {ap.system?.memUsagePct !== null && ap.system?.memUsagePct !== undefined
                      ? `${Math.round(ap.system.memUsagePct * 100)}%`
                      : 'n/a'}{' '}
                    · Conntrack{' '}
                    {ap.system?.conntrackUsagePct !== null && ap.system?.conntrackUsagePct !== undefined
                      ? `${ap.system.conntrackUsagePct.toFixed(1)}%`
                      : 'n/a'}
                  </p>
                  <Button asChild variant="ghost" size="sm" className="px-0">
                    <Link to={`/wifi/aps/${ap.id}`}>View health history</Link>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function StatCard({
  label,
  value,
  sub,
  icon,
}: {
  label: string
  value: string
  sub: string
  icon: React.ReactNode
}) {
  return (
    <Card className="rounded-xl py-3">
      <CardHeader className="flex-row items-center justify-between gap-3 px-3">
        <CardTitle className="text-xs text-muted-foreground">{label}</CardTitle>
        <span className="text-muted-foreground">{icon}</span>
      </CardHeader>
      <CardContent className="space-y-1 px-3">
        <p className="text-xl font-medium tabular-nums">{value}</p>
        <p className="text-xs text-muted-foreground">{sub}</p>
      </CardContent>
    </Card>
  )
}
