import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowDown, ArrowUp, Broadcast, CalendarBlank, Devices, HeartStraight } from '@phosphor-icons/react'
import { useQueryClient } from '@tanstack/react-query'
import { BandwidthChart } from '@/components/charts/bandwidth-chart'
import { TimelineMinimap } from '@/components/charts/timeline-minimap'
import { WifiClientsSparkline } from '@/components/charts/wifi-clients-sparkline'
import { ScopeToggle } from '@/components/dashboard/scope-toggle'
import { TimePicker } from '@/components/dashboard/time-picker'
import { DestinationsTable } from '@/components/destinations/destinations-table'
import { ProtocolBreakdownPanel } from '@/components/devices/protocol-breakdown-panel'
import { PageHeader } from '@/components/layout/page-header'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { TopDestinations } from '@/components/peers/top-destinations'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { KpiTile } from '@/components/ui/kpi-tile'
import { Panel } from '@/components/ui/panel'
import { ShareBar } from '@/components/ui/share-bar'
import { useDashboardScope, useDashboardTime } from '@/hooks/use-dashboard-time'
import { useProfile } from '@/hooks/use-auth'
import { useCollectorSummaries, useCollectors } from '@/hooks/use-collectors'
import { useAggregateProtocols, useAggregateTraffic, useDevices } from '@/hooks/use-devices'
import { deviceDisplayName } from '@/lib/device-labels'
import { useDestinations } from '@/hooks/use-destinations'
import { useRouter } from '@/hooks/use-router'
import { formatCompactCount } from '@/lib/gateway'
import { useTopPeers } from '@/hooks/use-peers'
import { useUsage } from '@/hooks/use-usage'
import { useWifiClients, useWifiClientsHistory, useWifiOverview } from '@/hooks/use-wifi'
import { formatBytes, formatMbps } from '@/lib/format-bytes'
import {
  contextRangeForWindow,
  DEFAULT_AGGREGATE_WINDOW,
  formatRangeLabel,
  type RefreshInterval,
  type TimeWindow,
} from '@/lib/time-window'
import { bucketsToChartPoints, macPath, withComparison } from '@/lib/traffic'
import { relativeWindow } from '@/lib/usage'
import { formatSignal, wifiHistoryResolutionForWindow, wifiSignalQualityDotClass } from '@/lib/wifi'
import type { DashboardScope, DeviceSummary } from '@/types/api'

type CompareMode = 'off' | 'prev' | 'day' | 'week'
type DestinationView = 'sites' | 'networks'
const DESTINATION_VIEWS: Array<{ id: DestinationView; label: string; title: string }> = [
  { id: 'sites', label: 'Sites', title: 'Destinations by domain (TLS SNI / HTTP host)' },
  { id: 'networks', label: 'Networks', title: 'WAN peers grouped by autonomous system' },
]
const COMPARE_OPTIONS: Array<{ id: CompareMode; label: string; title: string }> = [
  { id: 'off', label: 'Off', title: 'No comparison overlay' },
  { id: 'prev', label: 'Prev', title: 'Overlay the period immediately before this one' },
  { id: 'day', label: 'Day', title: 'Overlay the same window 24h earlier' },
  { id: 'week', label: 'Week', title: 'Overlay the same window 7 days earlier' },
]

function pickRates(device: DeviceSummary, scope: DashboardScope) {
  if (scope === 'wan' || scope === 'overlay') {
    return { mbpsIn: device.mbpsInWan, mbpsOut: device.mbpsOutWan, bytes: device.bytesInWan + device.bytesOutWan }
  }
  if (scope === 'lan') {
    return { mbpsIn: device.mbpsInLan, mbpsOut: device.mbpsOutLan, bytes: device.bytesInLan + device.bytesOutLan }
  }
  return { mbpsIn: device.mbpsIn, mbpsOut: device.mbpsOut, bytes: device.bytesIn + device.bytesOut }
}

export function DashboardPage() {
  const queryClient = useQueryClient()
  const {
    window,
    resolutionMode,
    resolution,
    refreshInterval,
    setWindow,
    setResolutionMode,
    setRefreshInterval,
  } = useDashboardTime(DEFAULT_AGGREGATE_WINDOW)
  const { scope, apiScope, isOverlay, setScope } = useDashboardScope()

  // Setup can finish with no collector (controller first); say so instead of
  // showing a dashboard of zeros.
  const profile = useProfile()
  const isAdmin = profile.data?.role === 'admin'
  const collectorSummaries = useCollectorSummaries()
  const noCollectors = collectorSummaries.data !== undefined && collectorSummaries.data.length === 0
  const adminCollectors = useCollectors({ enabled: isAdmin && noCollectors })
  const pendingCollectors =
    adminCollectors.data?.filter((collector) => collector.lifecycle === 'pending').length ?? 0

  const devices = useDevices({ window, refreshInterval })
  const traffic = useAggregateTraffic({ window, resolution, scope: apiScope, refreshInterval })
  const overlayTraffic = useAggregateTraffic({
    window,
    resolution,
    scope: 'lan',
    refreshInterval,
    enabled: isOverlay,
  })
  const protocols = useAggregateProtocols({ window, resolution, refreshInterval })
  const [destinationView, setDestinationView] = useState<DestinationView>('sites')
  const destinations = useTopPeers({
    window,
    scope: 'wan',
    limit: 12,
    refreshInterval,
    enabled: destinationView === 'networks',
  })
  const sites = useDestinations({ window, limit: 8, refreshInterval, enabled: destinationView === 'sites' })
  const wifi = useWifiOverview({ window, refreshInterval })
  const wifiClients = useWifiClients({ activeOnly: true, refreshInterval })
  // Only the latest sample matters here; a short window keeps the read cheap.
  const gateway = useRouter({ window: { kind: 'relative', range: '1h' }, resolution: '5m', refreshInterval })
  // Month to date + the whole previous month (62 days always spans both).
  const monthly = useUsage({
    period: 'month',
    window: relativeWindow('62d'),
    scope: apiScope,
    protocols: 1,
    refreshInterval,
  })
  const monthToDate = useMemo(() => {
    const buckets = monthly.data?.buckets ?? []
    const current = buckets[buckets.length - 1]
    const previous = buckets.length >= 2 ? buckets[buckets.length - 2] : undefined
    if (!current) return null
    const ofPrevious =
      previous && previous.totalBytes > 0 ? Math.round((current.totalBytes / previous.totalBytes) * 100) : null
    return { current, previous, ofPrevious }
  }, [monthly.data])
  const wifiHistory = useWifiClientsHistory({
    window,
    resolution: wifiHistoryResolutionForWindow(window),
    refreshInterval,
  })

  const chartData = useMemo(
    () =>
      traffic.data
        ? bucketsToChartPoints(traffic.data.buckets, isOverlay ? overlayTraffic.data?.buckets : undefined)
        : [],
    [traffic.data, overlayTraffic.data, isOverlay],
  )

  const contextRange = contextRangeForWindow(window)
  const contextTraffic = useAggregateTraffic({
    window: { kind: 'relative', range: contextRange },
    resolution: '1h',
    scope: apiScope,
    refreshInterval:
      refreshInterval === null ? null : (Math.max(refreshInterval ?? 60_000, 60_000) as RefreshInterval),
  })
  const contextData = useMemo(
    () => (contextTraffic.data ? bucketsToChartPoints(contextTraffic.data.buckets) : []),
    [contextTraffic.data],
  )

  const [compareMode, setCompareMode] = useState<CompareMode>('off')
  const compareEnabled = compareMode !== 'off' && chartData.length > 1
  const offsetMs = useMemo(() => {
    if (!compareEnabled) return 0
    if (compareMode === 'day') return 86_400_000
    if (compareMode === 'week') return 604_800_000
    return chartData[chartData.length - 1].ts - chartData[0].ts
  }, [compareMode, compareEnabled, chartData])
  const compareWindow = useMemo<TimeWindow | null>(() => {
    if (!compareEnabled || offsetMs <= 0) return null
    return {
      kind: 'absolute',
      from: new Date(chartData[0].ts - offsetMs).toISOString(),
      to: new Date(chartData[chartData.length - 1].ts - offsetMs).toISOString(),
    }
  }, [compareEnabled, offsetMs, chartData])
  const compareTraffic = useAggregateTraffic({
    window: compareWindow ?? DEFAULT_AGGREGATE_WINDOW,
    resolution,
    scope: apiScope,
    enabled: Boolean(compareWindow),
  })
  const showComparison = compareEnabled && Boolean(compareTraffic.data)
  const chartDataWithCompare = useMemo(
    () =>
      showComparison && compareTraffic.data
        ? withComparison(chartData, compareTraffic.data.buckets, offsetMs)
        : chartData,
    [showComparison, compareTraffic.data, chartData, offsetMs],
  )

  const summary = traffic.data?.summary
  const lanSummary = isOverlay ? overlayTraffic.data?.summary : undefined
  const deviceRows = useMemo(() => devices.data ?? [], [devices.data])
  const activeDevices = deviceRows.length
  const offlineCollectors = deviceRows.filter((d) => d.collector.lastStatus?.ok === false).length
  const aps = wifi.data?.accessPoints ?? []
  const offlineAps = aps.filter((ap) => ap.enabled && ap.lastStatus?.ok === false).length
  // Only while a collector reports: a sample left over from before is not today's conntrack.
  const gatewayLatest = gateway.data?.source ? gateway.data.latest : null
  const conntrackPct = gatewayLatest?.conntrackPct ?? null
  // Sources down always wins; otherwise a filling conntrack table warns at 80 %, alarms at 95 %.
  const healthStatus: 'good' | 'warning' | 'critical' =
    offlineCollectors + offlineAps > 0
      ? 'critical'
      : conntrackPct !== null && conntrackPct >= 95
        ? 'critical'
        : conntrackPct !== null && conntrackPct >= 80
          ? 'warning'
          : 'good'
  const sourcesLabel =
    offlineCollectors + offlineAps === 0
      ? 'All sources OK'
      : `${offlineCollectors + offlineAps} source${offlineCollectors + offlineAps === 1 ? '' : 's'} down`
  const healthLabel =
    gatewayLatest && gatewayLatest.conntrackEntries !== null
      ? `${sourcesLabel} · conntrack ${formatCompactCount(gatewayLatest.conntrackEntries)} / ${formatCompactCount(
          gatewayLatest.conntrackLimit,
        )}${conntrackPct !== null ? ` · ${conntrackPct}%` : ''}`
      : sourcesLabel

  const topTalkers = useMemo(() => {
    const rows = deviceRows.map((device) => ({ device, ...pickRates(device, scope) }))
    const total = rows.reduce((sum, r) => sum + r.bytes, 0)
    return { total, rows: rows.sort((a, b) => b.bytes - a.bytes).slice(0, 6) }
  }, [deviceRows, scope])

  const signalMix = wifi.data?.signalDistribution
  const wifiHistoryBuckets = wifiHistory.data?.buckets ?? []
  const wifiPeakInWindow = wifiHistoryBuckets.reduce((max, b) => Math.max(max, b.total), 0)
  const wifiClientsNow = wifiClients.data?.length ?? 0

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Dashboard"
        description="Network health at a glance."
        actions={
          <>
            <ScopeToggle value={scope} onChange={setScope} />
            <TimePicker
              window={window}
              resolutionMode={resolutionMode}
              refreshInterval={refreshInterval}
              onWindowChange={setWindow}
              onResolutionModeChange={setResolutionMode}
              onRefreshIntervalChange={setRefreshInterval}
              onRefreshNow={() => queryClient.invalidateQueries()}
            />
          </>
        }
      />

      {noCollectors ? (
        <Alert className="rounded-lg">
          <Broadcast className="size-4" />
          <AlertTitle>No collector yet</AlertTitle>
          <AlertDescription>
            <p>
              Traffic shows up here once a collector is adopted.
              {isAdmin && pendingCollectors > 0
                ? ` ${pendingCollectors === 1 ? '1 collector is' : `${pendingCollectors} collectors are`} waiting for adoption.`
                : ''}
              {!isAdmin ? ' Ask an admin to add one.' : ''}
            </p>
            {isAdmin ? (
              <Button asChild variant="outline" size="sm" className="mt-2">
                <Link to="/settings/collectors">Open Settings → Collectors</Link>
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiTile
          label="Download now"
          value={formatMbps(summary?.latestMbpsIn ?? 0)}
          sub={
            <>
              {formatBytes(summary?.bytesIn ?? 0)} in window
              {lanSummary ? ` · LAN ${formatMbps(lanSummary.latestMbpsIn)}` : ''}
            </>
          }
          icon={<ArrowDown className="size-4 text-chart-download" />}
        />
        <KpiTile
          label="Upload now"
          value={formatMbps(summary?.latestMbpsOut ?? 0)}
          sub={
            <>
              {formatBytes(summary?.bytesOut ?? 0)} in window
              {lanSummary ? ` · LAN ${formatMbps(lanSummary.latestMbpsOut)}` : ''}
            </>
          }
          icon={<ArrowUp className="size-4 text-chart-upload" />}
        />
        <KpiTile
          label="Active devices"
          value={String(activeDevices)}
          sub="with traffic in window"
          icon={<Devices className="size-4" />}
        />
        <KpiTile
          label="WiFi clients"
          value={String(wifiClientsNow)}
          sub={`${wifi.data?.ssidCount ?? 0} SSIDs · ${aps.length} APs`}
          icon={<Broadcast className="size-4" />}
        />
        <KpiTile
          label="Health"
          value={healthStatus === 'good' ? 'OK' : healthStatus === 'warning' ? 'Watch' : 'Degraded'}
          sub={healthLabel}
          status={healthStatus}
          icon={<HeartStraight className="size-4" />}
        />
        <Link to="/usage" className="block min-w-0 rounded-lg outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <KpiTile
            label="Month to date"
            value={formatBytes(monthToDate?.current.totalBytes ?? 0)}
            sub={
              monthToDate ? (
                <>
                  <span className="text-chart-download">↓</span> {formatBytes(monthToDate.current.bytesIn)}{' '}
                  <span className="text-chart-upload">↑</span> {formatBytes(monthToDate.current.bytesOut)}
                  {monthToDate.ofPrevious !== null ? ` · ${monthToDate.ofPrevious}% of last month` : ''}
                </>
              ) : (
                'from the hourly rollups'
              )
            }
            icon={<CalendarBlank className="size-4" />}
            className="h-full transition-colors hover:border-brand/60"
          />
        </Link>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel
          title="Bandwidth"
          description="Mbps over the selected window. Drag to zoom."
          updating={traffic.isPlaceholderData}
          actions={
            <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
              <span className="px-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">Compare</span>
              {COMPARE_OPTIONS.map((opt) => (
                <Button
                  key={opt.id}
                  type="button"
                  size="sm"
                  variant={compareMode === opt.id ? 'secondary' : 'ghost'}
                  className="h-6 px-2 text-xs"
                  onClick={() => setCompareMode(opt.id)}
                  title={opt.title}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          }
        >
          {traffic.isPending ? (
            <p className="text-xs text-muted-foreground">Loading bandwidth…</p>
          ) : traffic.error ? (
            <p className="text-xs text-destructive">{traffic.error.message}</p>
          ) : chartData.length > 0 ? (
            <>
              <BandwidthChart
                data={chartDataWithCompare}
                showOverlay={isOverlay}
                showComparison={showComparison}
                className="h-[300px] w-full"
                onZoom={setWindow}
                onResetZoom={() => setWindow(DEFAULT_AGGREGATE_WINDOW)}
                canResetZoom={window.kind === 'absolute'}
              />
              {contextData.length > 1 ? (
                <div className="mt-2 space-y-1 border-t border-border/60 pt-2">
                  <p className="section-label">Overview · last {formatRangeLabel(contextRange)} · drag to zoom</p>
                  <TimelineMinimap data={contextData} window={window} onSelect={setWindow} className="h-14 w-full" />
                </div>
              ) : null}
            </>
          ) : (
            <EmptyState
              title="No traffic buckets yet"
              description="The chart appears once the collector poller has written its first buckets."
            />
          )}
        </Panel>

        <Panel title="Top talkers" description="Bytes in the window, by device." updating={devices.isPlaceholderData} flush>
          {devices.isPending ? (
            <p className="px-4 pb-4 text-xs text-muted-foreground">Loading devices…</p>
          ) : topTalkers.rows.length === 0 ? (
            <div className="px-4 pb-4">
              <EmptyState title="No devices in window" />
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Device</th>
                  <th className="text-right">Now</th>
                  <th className="text-right">Share</th>
                </tr>
              </thead>
              <tbody>
                {topTalkers.rows.map(({ device, mbpsIn, mbpsOut, bytes }) => (
                  <tr key={`${device.collector.id}-${device.mac}`}>
                    <td>
                      <Link to={`/devices/${macPath(device.mac)}`} className="block min-w-0 hover:text-brand">
                        <span className="block truncate font-medium">
                          {deviceDisplayName(device)}
                        </span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">
                          {device.primaryIp ?? device.mac}
                          {device.wifi.connected ? ` · ${device.wifi.ap}` : ''}
                        </span>
                      </Link>
                    </td>
                    <td className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                      <span className="text-foreground">
                        <span className="text-chart-download">↓</span> {formatMbps(mbpsIn, 1)}
                      </span>
                      <br />
                      <span className="text-chart-upload">↑</span> {formatMbps(mbpsOut, 1)}
                    </td>
                    <td>
                      <ShareBar percentage={topTalkers.total > 0 ? (bytes / topTalkers.total) * 100 : 0} />
                      <p className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                        {formatBytes(bytes)}
                      </p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="border-t border-border/70 px-4 py-2 text-right">
            <Link to="/devices" className="text-xs text-brand hover:underline">
              All devices →
            </Link>
          </div>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <Panel
          title="Top destinations"
          description={
            destinationView === 'sites'
              ? 'Where WAN bytes went, by site, from the hourly destination history.'
              : 'WAN peers grouped by network, from the hourly peer history.'
          }
          updating={destinationView === 'sites' ? sites.isPlaceholderData : destinations.isPlaceholderData}
          flush
          className="xl:col-span-1"
          actions={
            <div className="flex rounded-md border border-border p-0.5" role="radiogroup" aria-label="Destination view">
              {DESTINATION_VIEWS.map((opt) => (
                <Button
                  key={opt.id}
                  type="button"
                  size="sm"
                  role="radio"
                  aria-checked={destinationView === opt.id}
                  variant={destinationView === opt.id ? 'secondary' : 'ghost'}
                  className="h-6 px-2 text-xs"
                  title={opt.title}
                  onClick={() => setDestinationView(opt.id)}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          }
        >
          {destinationView === 'sites' ? (
            <DestinationsTable data={sites.data} isPending={sites.isPending} error={sites.error} compact limit={8} />
          ) : (
            <TopDestinations
              data={destinations.data}
              scope="wan"
              isPending={destinations.isPending}
              error={destinations.error}
              compact
            />
          )}
          <div className="border-t border-border/70 px-4 py-2 text-right">
            <Link to="/traffic" className="text-xs text-brand hover:underline">
              Where traffic goes →
            </Link>
          </div>
        </Panel>

        <Panel title="Protocol mix" description="Bytes by detected protocol." updating={protocols.isPlaceholderData}>
          <ProtocolBreakdownPanel
            protocols={protocols.data?.protocols ?? []}
            isPending={protocols.isPending}
            error={protocols.error}
            compact
            initialLimit={6}
          />
        </Panel>

        <Panel
          title="WiFi"
          description="Connected clients over the window, SSIDs and signal right now."
          updating={wifi.isPlaceholderData || wifiHistory.isPlaceholderData}
          flush
        >
          {wifi.isPending ? (
            <p className="px-4 pb-4 text-xs text-muted-foreground">Loading WiFi…</p>
          ) : wifi.error ? (
            <p className="px-4 pb-4 text-xs text-destructive">{wifi.error.message}</p>
          ) : (
            <>
              <div className="border-b border-border/70 px-4 pb-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="section-label">Connected clients</span>
                  <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    now <span className="text-foreground">{wifiClientsNow}</span>
                    {wifiPeakInWindow > 0 ? (
                      <>
                        {' · peak '}
                        <span className="text-foreground">{wifiPeakInWindow}</span>
                      </>
                    ) : null}
                  </span>
                </div>
                {wifiHistoryBuckets.length > 1 ? (
                  <WifiClientsSparkline data={wifiHistoryBuckets} className="mt-1 h-16 w-full" />
                ) : (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {wifiHistory.isPending ? 'Loading history…' : 'No client history in this window yet.'}
                  </p>
                )}
              </div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>SSID</th>
                    <th className="text-right">Clients</th>
                    <th className="text-right">Signal</th>
                  </tr>
                </thead>
                <tbody>
                  {(wifi.data?.ssids ?? []).map((ssid) => (
                    <tr key={ssid.ssid}>
                      <td>
                        <Link to={`/wifi/ssids/${encodeURIComponent(ssid.ssid)}`} className="font-medium hover:text-brand">
                          {ssid.ssid}
                        </Link>
                        <p className="truncate text-[11px] text-muted-foreground">{ssid.accessPoints.join(', ')}</p>
                      </td>
                      <td className="text-right font-mono tabular-nums">{ssid.clientCount}</td>
                      <td className="text-right font-mono tabular-nums">
                        <span
                          aria-hidden
                          className={`mr-1.5 inline-block size-2 rounded-full ${wifiSignalQualityDotClass(ssid.signalQuality)}`}
                        />
                        {formatSignal(ssid.averageSignalDbm)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {signalMix ? (
                <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border/70 px-4 py-2 text-[11px] text-muted-foreground">
                  <span>
                    <span className="mr-1 inline-block size-2 rounded-full bg-status-good" aria-hidden />
                    Strong {signalMix.excellent + signalMix.veryGood}
                  </span>
                  <span>
                    <span className="mr-1 inline-block size-2 rounded-full bg-status-warning" aria-hidden />
                    Fair {signalMix.good + signalMix.fair}
                  </span>
                  <span>
                    <span className="mr-1 inline-block size-2 rounded-full bg-status-critical" aria-hidden />
                    Weak {signalMix.weak + signalMix.veryWeak}
                  </span>
                  <Link to="/wifi" className="ml-auto text-brand hover:underline">
                    WiFi →
                  </Link>
                </div>
              ) : null}
            </>
          )}
        </Panel>
      </div>
    </div>
  )
}
