import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowDown, ArrowUp, MagnifyingGlass } from '@phosphor-icons/react'
import { useQueryClient } from '@tanstack/react-query'
import { ScopeToggle } from '@/components/dashboard/scope-toggle'
import { TimePicker } from '@/components/dashboard/time-picker'
import { PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import { SeriesRateChart } from '@/components/charts/series-rate-chart'
import { ShareBar } from '@/components/ui/share-bar'
import { useDashboardScope, useDashboardTime } from '@/hooks/use-dashboard-time'
import { useDeviceLabels } from '@/hooks/use-device-labels'
import { useDevices, useTopTraffic } from '@/hooks/use-devices'
import { uplinkLine } from '@/lib/attachment'
import { formatLastSeen } from '@/lib/collectors'
import {
  DEVICE_TYPE_OPTIONS,
  deviceDisplayName,
  deviceSearchText,
  deviceTypeMeta,
} from '@/lib/device-labels'
import { formatBytes, formatMbps } from '@/lib/format-bytes'
import { useStableSeriesOrder, useStableSeriesSlots } from '@/lib/series-colors'
import { connectionLabel } from '@/lib/presence'
import {
  RATE_DIRECTION_OPTIONS,
  RATE_MODE_OPTIONS,
  seriesSlotColor,
  topTrafficSeriesKey,
  topTrafficToRateData,
  type RateChartDirection,
  type RateChartMode,
} from '@/lib/rate-series'
import { DEFAULT_DEVICE_WINDOW } from '@/lib/time-window'
import { macPath } from '@/lib/traffic'
import { cn } from '@/lib/utils'
import { formatSignal, formatWifiBand, wifiSignalQualityDotClass } from '@/lib/wifi'
import type { DashboardScope, DeviceSummary, DeviceType, TopTrafficRank } from '@/types/api'

type SortKey = 'name' | 'down' | 'up' | 'total'
type Connection = 'all' | 'wifi' | 'wired'
type TopLimit = '5' | '10'

const TOP_LIMIT_OPTIONS = [
  { id: '5', label: 'Top 5' },
  { id: '10', label: 'Top 10' },
] as const satisfies ReadonlyArray<{ id: TopLimit; label: string }>

/** Rank by the direction on screen: a "Down" chart should show the top downloaders. */
function rankFor(direction: RateChartDirection): TopTrafficRank {
  if (direction === 'down') return 'download'
  if (direction === 'up') return 'upload'
  return 'total'
}

function pickRates(device: DeviceSummary, scope: DashboardScope) {
  if (scope === 'wan' || scope === 'overlay') {
    return { mbpsIn: device.mbpsInWan, mbpsOut: device.mbpsOutWan, bytes: device.bytesInWan + device.bytesOutWan }
  }
  if (scope === 'lan') {
    return { mbpsIn: device.mbpsInLan, mbpsOut: device.mbpsOutLan, bytes: device.bytesInLan + device.bytesOutLan }
  }
  return { mbpsIn: device.mbpsIn, mbpsOut: device.mbpsOut, bytes: device.bytesIn + device.bytesOut }
}

const FILTER_SELECT_CLASS =
  'h-8 rounded-md border border-border bg-card px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50'

type SortState = { key: SortKey; dir: 'asc' | 'desc' }

function SortHeader({
  label,
  sortKey,
  sort,
  onToggle,
  align = 'left',
}: {
  label: string
  sortKey: SortKey
  sort: SortState
  onToggle: (key: SortKey) => void
  align?: 'left' | 'right'
}) {
  const active = sort.key === sortKey
  return (
    <th className={align === 'right' ? 'text-right' : undefined}>
      <button
        type="button"
        onClick={() => onToggle(sortKey)}
        className={cn('inline-flex items-center gap-1 hover:text-foreground', active && 'text-foreground')}
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
      >
        {label}
        {active ? sort.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" /> : null}
      </button>
    </th>
  )
}

export function DevicesPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const {
    window,
    resolutionMode,
    resolution,
    refreshInterval,
    setWindow,
    setResolutionMode,
    setRefreshInterval,
  } = useDashboardTime(DEFAULT_DEVICE_WINDOW)
  const { scope, apiScope, setScope } = useDashboardScope()
  const devices = useDevices({ window, refreshInterval })

  const [topMode, setTopMode] = useState<RateChartMode>('stacked')
  const [topDirection, setTopDirection] = useState<RateChartDirection>('both')
  const [topLimit, setTopLimit] = useState<TopLimit>('5')
  const topTraffic = useTopTraffic({
    window,
    resolution,
    scope: apiScope,
    limit: Number(topLimit),
    by: rankFor(topDirection),
    refreshInterval,
  })
  // Colour and stacking order follow the device, not its rank: a swap
  // between refreshes neither repaints nor restacks the chart.
  const topKeys = useMemo(
    () => (topTraffic.data?.devices ?? []).map((device) => topTrafficSeriesKey(device.mac)),
    [topTraffic.data],
  )
  const topSlots = useStableSeriesSlots(topKeys)
  const topOrder = useStableSeriesOrder(topKeys)
  const topRate = useMemo(
    () =>
      topTraffic.data
        ? topTrafficToRateData(topTraffic.data, {
            colorFor: (key) => seriesSlotColor(topSlots.get(key) ?? 0),
            order: topOrder,
          })
        : { series: [], points: [] },
    [topTraffic.data, topSlots, topOrder],
  )

  const [query, setQuery] = useState('')
  const [connection, setConnection] = useState<Connection>('all')
  const [activeOnly, setActiveOnly] = useState(false)
  const [deviceType, setDeviceType] = useState<DeviceType | 'all' | 'unclassified'>('all')
  const [tag, setTag] = useState('all')
  const [sort, setSort] = useState<SortState>({ key: 'total', dir: 'desc' })
  const labels = useDeviceLabels()

  // Only offer a type the user has actually assigned — a 17-entry dropdown
  // where 15 match nothing is noise.
  const typesInUse = useMemo(() => {
    const used = new Set((devices.data ?? []).map((device) => device.deviceType).filter(Boolean))
    return DEVICE_TYPE_OPTIONS.filter((option) => used.has(option.id))
  }, [devices.data])
  const tagsInUse = labels.data?.tags ?? []

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = (devices.data ?? []).map((device) => ({ device, ...pickRates(device, scope) }))
    const total = all.reduce((sum, r) => sum + r.bytes, 0)
    const filtered = all.filter(({ device, mbpsIn, mbpsOut }) => {
      // By how it was last attached, so a Wi-Fi device that left stays under WiFi.
      // Wired is everything else: marked Ethernet or cabled on the map (both `ethernet`), and Wired / unknown.
      if (connection === 'wifi' && device.presence.via !== 'wifi') return false
      if (connection === 'wired' && device.presence.via === 'wifi') return false
      if (activeOnly && mbpsIn + mbpsOut <= 0) return false
      if (deviceType === 'unclassified' && device.deviceType) return false
      if (deviceType !== 'all' && deviceType !== 'unclassified' && device.deviceType !== deviceType)
        return false
      if (tag !== 'all' && !(device.tags ?? []).includes(tag)) return false
      if (!q) return true
      // Matches the custom name, tags and notes too, so "kids" or "garage"
      // finds what you labelled that way.
      return deviceSearchText(device).includes(q)
    })
    const dir = sort.dir === 'asc' ? 1 : -1
    filtered.sort((a, b) => {
      switch (sort.key) {
        case 'name':
          return deviceDisplayName(a.device).localeCompare(deviceDisplayName(b.device)) * dir
        case 'down':
          return (a.mbpsIn - b.mbpsIn) * dir
        case 'up':
          return (a.mbpsOut - b.mbpsOut) * dir
        default:
          return (a.bytes - b.bytes) * dir
      }
    })
    return { total, filtered, count: all.length }
  }, [devices.data, scope, query, connection, activeOnly, deviceType, tag, sort])

  const toggleSort = (key: SortKey) =>
    setSort((current) =>
      current.key === key ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' ? 'asc' : 'desc' },
    )

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Devices"
        description={`${rows.count} devices with traffic in the window.`}
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

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex h-8 w-full max-w-xs items-center gap-2 rounded-md border border-border bg-card px-2.5 focus-within:border-ring">
          <MagnifyingGlass className="size-4 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by name, IP or MAC"
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
            aria-label="Filter devices"
          />
        </div>
        <div className="flex rounded-md border border-border bg-card p-0.5" role="radiogroup" aria-label="Connection">
          {(['all', 'wifi', 'wired'] as Connection[]).map((option) => (
            <Button
              key={option}
              type="button"
              size="sm"
              role="radio"
              aria-checked={connection === option}
              variant={connection === option ? 'secondary' : 'ghost'}
              className="h-7 px-2.5 text-xs capitalize"
              onClick={() => setConnection(option)}
            >
              {option === 'wifi' ? 'WiFi' : option}
            </Button>
          ))}
        </div>
        <Button
          type="button"
          size="sm"
          variant={activeOnly ? 'secondary' : 'outline'}
          className="h-7 px-2.5 text-xs"
          onClick={() => setActiveOnly((value) => !value)}
          aria-pressed={activeOnly}
        >
          Active now
        </Button>
        {typesInUse.length > 0 ? (
          <select
            aria-label="Filter by device type"
            value={deviceType}
            className={FILTER_SELECT_CLASS}
            onChange={(event) =>
              setDeviceType(event.target.value as DeviceType | 'all' | 'unclassified')
            }
          >
            <option value="all">All types</option>
            {typesInUse.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
            <option value="unclassified">Unclassified</option>
          </select>
        ) : null}
        {tagsInUse.length > 0 ? (
          <select
            aria-label="Filter by tag"
            value={tag}
            className={FILTER_SELECT_CLASS}
            onChange={(event) => setTag(event.target.value)}
          >
            <option value="all">All tags</option>
            {tagsInUse.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      <Panel
        title="Top talkers over time"
        description={`The busiest ${topLimit} devices in the window as their own rate series; everyone else stacked as Others${
          topTraffic.data ? ` · ${topTraffic.data.resolution} buckets` : ''
        }. Drag to zoom.`}
        updating={topTraffic.isPlaceholderData}
        actions={
          <>
            <Segmented
              size="xs"
              ariaLabel="Chart mode"
              value={topMode}
              onChange={setTopMode}
              options={RATE_MODE_OPTIONS}
            />
            <Segmented
              size="xs"
              ariaLabel="Direction"
              value={topDirection}
              onChange={setTopDirection}
              options={RATE_DIRECTION_OPTIONS}
            />
            <Segmented
              size="xs"
              ariaLabel="How many devices"
              value={topLimit}
              onChange={setTopLimit}
              options={TOP_LIMIT_OPTIONS}
            />
          </>
        }
      >
        {topTraffic.isPending ? (
          <div className="flex h-[300px] items-center justify-center text-xs text-muted-foreground">
            Loading top talkers…
          </div>
        ) : topTraffic.error ? (
          <p className="text-xs text-destructive">{topTraffic.error.message}</p>
        ) : (
          <SeriesRateChart
            series={topRate.series}
            data={topRate.points}
            range={topTraffic.data}
            mode={topMode}
            direction={topDirection}
            className="h-[300px] w-full"
            onZoom={setWindow}
            onResetZoom={() => setWindow(DEFAULT_DEVICE_WINDOW)}
            canResetZoom={window.kind === 'absolute'}
            emptyMessage="No device traffic in this window."
          />
        )}
      </Panel>

      <Panel title="All devices" description="Click a row for the device card." updating={devices.isPlaceholderData} flush>
        {devices.isPending ? (
          <p className="px-4 pb-4 text-xs text-muted-foreground">Loading devices…</p>
        ) : devices.error ? (
          <p className="px-4 pb-4 text-xs text-destructive">{devices.error.message}</p>
        ) : rows.filtered.length === 0 ? (
          <div className="px-4 pb-4">
            <EmptyState
              title="No devices match"
              description={rows.count === 0 ? 'Devices appear once the collector poller has written traffic.' : 'Try a different filter.'}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <SortHeader label="Device" sortKey="name" sort={sort} onToggle={toggleSort} />
                  <th>Connection</th>
                  <SortHeader label="Down now" sortKey="down" sort={sort} onToggle={toggleSort} align="right" />
                  <SortHeader label="Up now" sortKey="up" sort={sort} onToggle={toggleSort} align="right" />
                  <SortHeader label="Total" sortKey="total" sort={sort} onToggle={toggleSort} align="right" />
                  <th className="text-right">Share</th>
                </tr>
              </thead>
              <tbody>
                {rows.filtered.map(({ device, mbpsIn, mbpsOut, bytes }) => (
                  <tr
                    key={`${device.collector.id}-${device.mac}`}
                    data-clickable="true"
                    data-prefetch-href={`/devices/${macPath(device.mac)}`}
                    onClick={() => navigate(`/devices/${macPath(device.mac)}`)}
                  >
                    <td>
                      <DeviceCell device={device} />
                    </td>
                    <td>
                      {device.wifi.connected ? (
                        <span className="flex items-center gap-1.5 text-[12px]">
                          <span
                            aria-hidden
                            className={`inline-block size-2 rounded-full ${wifiSignalQualityDotClass(device.wifi.signalQuality)}`}
                          />
                          <span className="truncate">
                            {device.wifi.ap} · {formatWifiBand(device.wifi.band)} · {formatSignal(device.wifi.signalDbm)}
                          </span>
                        </span>
                      ) : device.presence.via === 'wifi' && device.wifi.last ? (
                        <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                          <span aria-hidden className="inline-block size-2 rounded-full bg-muted-foreground/40" />
                          <span className="truncate">
                            Last seen on WiFi · {device.wifi.last.ap} · {formatLastSeen(device.presence.lastSeenAt)}
                          </span>
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                          <span aria-hidden className="inline-block size-2 shrink-0 rounded-full bg-muted-foreground/40" />
                          <span className="truncate" data-connection-line>
                            {/* On the map with a cable (A4): "Ethernet · Garage AP · lan1 · 100 Mb/s". */}
                            {[connectionLabel(device.presence.via), uplinkLine(device.attachment)]
                              .filter(Boolean)
                              .join(' · ')}
                            {device.presence.status === 'disconnected' && device.presence.lastSeenAt
                              ? ` · last seen ${formatLastSeen(device.presence.lastSeenAt)}`
                              : null}
                          </span>
                          {device.collector.lastStatus?.ok === false ? (
                            <span className="shrink-0 text-status-critical">· collector offline</span>
                          ) : null}
                        </span>
                      )}
                    </td>
                    <td className="text-right font-mono tabular-nums">{formatMbps(mbpsIn)}</td>
                    <td className="text-right font-mono tabular-nums">{formatMbps(mbpsOut)}</td>
                    <td className="text-right font-mono font-medium tabular-nums">{formatBytes(bytes)}</td>
                    <td>
                      <ShareBar percentage={rows.total > 0 ? (bytes / rows.total) * 100 : 0} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  )
}

/**
 * Device column: type icon, display name (the operator's if they set one),
 * then addresses and any tags.
 */
function DeviceCell({ device }: { device: DeviceSummary }) {
  const typeMeta = deviceTypeMeta(device.deviceType)
  const tags = device.tags ?? []

  return (
    <div className="flex min-w-0 items-start gap-2">
      {typeMeta ? (
        <typeMeta.Icon
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          weight="duotone"
          aria-label={typeMeta.label}
        />
      ) : null}
      <div className="min-w-0">
        <p className="truncate font-medium">{deviceDisplayName(device)}</p>
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {device.primaryIp ?? '—'} · {device.mac}
        </p>
        {tags.length > 0 ? (
          <p className="mt-0.5 flex flex-wrap gap-1">
            {tags.map((tag) => (
              <Badge key={tag} variant="outline" className="h-4 rounded px-1 text-[10px]">
                {tag}
              </Badge>
            ))}
          </p>
        ) : null}
      </div>
    </div>
  )
}
