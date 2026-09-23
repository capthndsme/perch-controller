import { useMemo } from 'react'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { ZoomableAreaChart } from '@/components/charts/zoomable-area-chart'
import { formatBytes, formatMbps } from '@/lib/format-bytes'
import { downsampleTimeSeries } from '@/lib/traffic'
import {
  chartTimeDomain,
  formatAxisTick,
  formatTooltipTimestamp,
  type ChartRange,
  type TimeWindow,
} from '@/lib/time-window'

export type BandwidthPoint = {
  /** Epoch ms — used as the numeric X-axis key. */
  ts: number
  download: number
  upload: number
  downloadBytes?: number
  uploadBytes?: number
  /**
   * Optional overlay series — populated when the dashboard's
   * "Overlay LAN" switch is on. We attach overlay bytes/Mbps to the
   * SAME row as the primary numbers (keyed by ts) so Recharts can
   * draw all four areas off one dataset without doing a second join.
   */
  lanDownload?: number
  lanUpload?: number
  lanDownloadBytes?: number
  lanUploadBytes?: number
  /** Optional WiFi PHY-link overlay (Mbps). */
  wifiDownload?: number
  wifiUpload?: number
  /**
   * Optional period-over-period ghost series — the prior period's values
   * re-based onto this axis (see `withComparison`). Rendered as faint dashed
   * lines so "this week vs last week" reads at a glance.
   */
  compareDownload?: number
  compareUpload?: number
  compareDownloadBytes?: number
  compareUploadBytes?: number
}

const chartConfig = {
  download: {
    label: 'Mbps down',
    color: 'var(--chart-download)',
  },
  upload: {
    label: 'Mbps up',
    color: 'var(--chart-upload)',
  },
  lanDownload: {
    label: 'LAN down',
    color: 'var(--chart-download-overlay)',
  },
  lanUpload: {
    label: 'LAN up',
    color: 'var(--chart-upload-overlay)',
  },
  wifiDownload: {
    label: 'WiFi PHY down',
    color: 'var(--chart-download)',
  },
  wifiUpload: {
    label: 'WiFi PHY up',
    color: 'var(--chart-upload)',
  },
  compareDownload: {
    label: 'Down (prev)',
    color: 'var(--chart-download)',
  },
  compareUpload: {
    label: 'Up (prev)',
    color: 'var(--chart-upload)',
  },
} satisfies ChartConfig

type BandwidthChartProps = {
  data: BandwidthPoint[]
  className?: string
  /** Render the LAN overlay series on top of the primary areas. */
  showOverlay?: boolean
  /** Render WiFi PHY rate overlays as dashed lines. */
  showWifiOverlay?: boolean
  /** Render the period-over-period ghost series (compareDownload/Up). */
  showComparison?: boolean
  /**
   * Drag-to-zoom emits `{kind:'absolute', from, to}` here. When omitted,
   * drag interactions are inert (used for the small per-device charts
   * where zoom doesn't make sense).
   */
  onZoom?: (window: TimeWindow) => void
  onResetZoom?: () => void
  canResetZoom?: boolean
  /**
   * Max points to draw. Wider windows return more buckets than Recharts can
   * smoothly render (the backend's coarsest grain is 1h, so 1y ≈ 8.7k pts),
   * so the data is LTTB-downsampled to this budget — shape preserved.
   */
  maxPoints?: number
  /** The window the API read: the x-axis spans it even where it was quiet. */
  range?: ChartRange
}

/**
 * Download / upload rate over the window. The API returns every bucket
 * (quiet ones as zero) with rates over each bucket's own seconds; segments
 * are straight between buckets (a smoothed curve overshoots and bridges
 * nothing that is not there) and the axis spans the requested window.
 */
export function BandwidthChart({
  data,
  className,
  showOverlay = false,
  showWifiOverlay = false,
  showComparison = false,
  onZoom,
  onResetZoom,
  canResetZoom,
  maxPoints = 2000,
  range,
}: BandwidthChartProps) {
  // Downsample by combined WAN magnitude so spikes in either direction
  // survive; kept rows retain their LAN/WiFi/compare values too.
  const points = useMemo(
    () => downsampleTimeSeries(data, maxPoints, (p) => p.download + p.upload),
    [data, maxPoints],
  )

  const { domain, spanSeconds } = useMemo(
    () => chartTimeDomain(points, range),
    [points, range?.from, range?.to], // eslint-disable-line react-hooks/exhaustive-deps
  )

  return (
    <ZoomableAreaChart
      className={className}
      onZoom={onZoom}
      onResetZoom={onResetZoom}
      canResetZoom={canResetZoom}
    >
      {({ onMouseDown, onMouseMove, onMouseUp, onMouseLeave, referenceArea }) => (
        <ChartContainer config={chartConfig} className="h-full w-full">
          <AreaChart
            data={points}
            margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseLeave}
          >
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis
              dataKey="ts"
              type="number"
              domain={domain}
              scale="time"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={48}
              tickFormatter={(value: number) => formatAxisTick(value, spanSeconds)}
              allowDataOverflow
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={56}
              tickFormatter={(value: number) => formatMbps(value, 1)}
            />
            <ChartTooltip
              // Sort rows by value desc so the dominant series (usually
              // the download/upload primary) reads first. Read from
              // `payload[dataKey]` to match the formatter's displayed
              // value; see the note in protocol-stack-chart for why
              // this lives on the outer Tooltip.
              itemSorter={(item) => {
                const datum = item.payload as Record<string, unknown> | undefined
                const key = String(item.dataKey ?? item.name ?? '')
                const raw = datum?.[key]
                return -Number(raw ?? item.value ?? 0)
              }}
              content={
                <ChartTooltipContent
                  indicator="dot"
                  labelFormatter={(_, payload) => {
                    const ts = payload?.[0]?.payload?.ts
                    return typeof ts === 'number' ? formatTooltipTimestamp(ts) : ''
                  }}
                  formatter={(value, name, item) => {
                    const payload = item.payload as BandwidthPoint
                    const bytes = bytesForSeries(name, payload)
                    return (
                      <div className="flex w-full items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <span
                            aria-hidden
                            className="size-2.5 shrink-0 rounded-[2px]"
                            style={{ backgroundColor: `var(--color-${String(name)})` }}
                          />
                          <span className="text-muted-foreground">
                            {seriesLabel(name)}
                          </span>
                        </div>
                        <span className="font-mono text-foreground">
                          {formatMbps(Number(value))}
                          {bytes != null ? (
                            <span className="ml-1 text-muted-foreground">
                              ({formatBytes(bytes)})
                            </span>
                          ) : null}
                        </span>
                      </div>
                    )
                  }}
                />
              }
            />
            <ChartLegend content={<ChartLegendContent />} />
            {showComparison ? (
              <>
                <Area
                  isAnimationActive={false}
                  dataKey="compareDownload"
                  type="linear"
                  fill="none"
                  stroke="var(--color-compareDownload)"
                  strokeOpacity={0.45}
                  strokeWidth={1.5}
                  strokeDasharray="5 3"
                  connectNulls
                  dot={false}
                />
                <Area
                  isAnimationActive={false}
                  dataKey="compareUpload"
                  type="linear"
                  fill="none"
                  stroke="var(--color-compareUpload)"
                  strokeOpacity={0.45}
                  strokeWidth={1.5}
                  strokeDasharray="5 3"
                  connectNulls
                  dot={false}
                />
              </>
            ) : null}
            <Area
              isAnimationActive={false}
              dataKey="download"
              type="linear"
              fill="var(--color-download)"
              fillOpacity={0.25}
              stroke="var(--color-download)"
              strokeWidth={2}
            />
            <Area
              isAnimationActive={false}
              dataKey="upload"
              type="linear"
              fill="var(--color-upload)"
              fillOpacity={0.25}
              stroke="var(--color-upload)"
              strokeWidth={2}
            />
            {showOverlay ? (
              <>
                <Area
                  isAnimationActive={false}
                  dataKey="lanDownload"
                  type="linear"
                  fill="var(--color-lanDownload)"
                  fillOpacity={0.1}
                  stroke="var(--color-lanDownload)"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                />
                <Area
                  isAnimationActive={false}
                  dataKey="lanUpload"
                  type="linear"
                  fill="var(--color-lanUpload)"
                  fillOpacity={0.1}
                  stroke="var(--color-lanUpload)"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                />
              </>
            ) : null}
            {showWifiOverlay ? (
              <>
                <Area
                  isAnimationActive={false}
                  dataKey="wifiDownload"
                  type="linear"
                  fill="var(--color-wifiDownload)"
                  fillOpacity={0}
                  stroke="var(--color-wifiDownload)"
                  strokeWidth={1.5}
                  strokeDasharray="2 4"
                />
                <Area
                  isAnimationActive={false}
                  dataKey="wifiUpload"
                  type="linear"
                  fill="var(--color-wifiUpload)"
                  fillOpacity={0}
                  stroke="var(--color-wifiUpload)"
                  strokeWidth={1.5}
                  strokeDasharray="2 4"
                />
              </>
            ) : null}
            {referenceArea}
          </AreaChart>
        </ChartContainer>
      )}
    </ZoomableAreaChart>
  )
}

function seriesLabel(name: unknown): string {
  const key = String(name)
  return (chartConfig as Record<string, { label?: string }>)[key]?.label ?? key
}

/**
 * Picks the byte-total field that matches a given series name. Centralised
 * so adding a new overlay series only touches one place.
 */
function bytesForSeries(name: unknown, payload: BandwidthPoint): number | undefined {
  switch (name) {
    case 'download':
      return payload.downloadBytes
    case 'upload':
      return payload.uploadBytes
    case 'lanDownload':
      return payload.lanDownloadBytes
    case 'lanUpload':
      return payload.lanUploadBytes
    case 'wifiDownload':
      return undefined
    case 'wifiUpload':
      return undefined
    case 'compareDownload':
      return payload.compareDownloadBytes
    case 'compareUpload':
      return payload.compareUploadBytes
    default:
      return undefined
  }
}

