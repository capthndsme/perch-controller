import { useMemo } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from 'recharts'
import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart'
import { ZoomableAreaChart } from '@/components/charts/zoomable-area-chart'
import { formatMbps } from '@/lib/format-bytes'
import {
  downKey,
  upKey,
  type RateChartDirection,
  type RateChartMode,
  type RatePoint,
  type RateSeries,
} from '@/lib/rate-series'
import { downsampleTimeSeries } from '@/lib/traffic'
import {
  chartTimeDomain,
  formatAxisTick,
  formatTooltipTimestamp,
  type ChartRange,
  type TimeWindow,
} from '@/lib/time-window'
import { cn } from '@/lib/utils'

type SeriesRateChartProps = {
  series: RateSeries[]
  data: RatePoint[]
  mode: RateChartMode
  direction: RateChartDirection
  className?: string
  onZoom?: (window: TimeWindow) => void
  onResetZoom?: () => void
  canResetZoom?: boolean
  /** LTTB point budget for wide windows; see BandwidthChart. */
  maxPoints?: number
  emptyMessage?: string
  /** The window the API read: the x-axis spans it even where it was quiet. */
  range?: ChartRange
}

/**
 * Several entities, each with a download and an upload rate, on one Mbps
 * axis. `lines` draws one line per entity (solid ↓, dashed ↑); `stacked`
 * stacks the entities so the outline is the total, and with `both`
 * mirrors upload below the axis UniFi-style so the two stacks never
 * overlap. Drag to zoom like the other time charts. Straight segments
 * between buckets (a smoothed curve overshoots and invents values between
 * sums), and the axis spans the requested window (`range`).
 */
export function SeriesRateChart({
  series,
  data,
  mode,
  direction,
  className,
  onZoom,
  onResetZoom,
  canResetZoom,
  maxPoints = 2000,
  emptyMessage = 'No data for this range.',
  range,
}: SeriesRateChartProps) {
  const showDown = direction !== 'up'
  const showUp = direction !== 'down'
  const mirrored = mode === 'stacked' && direction === 'both'

  // Downsample by total magnitude so the busiest moments survive.
  const points = useMemo(
    () =>
      downsampleTimeSeries(data, maxPoints, (p) =>
        series.reduce(
          (sum, s) =>
            sum + (showDown ? p[downKey(s.key)] || 0 : 0) + (showUp ? p[upKey(s.key)] || 0 : 0),
          0,
        ),
      ),
    [data, maxPoints, series, showDown, showUp],
  )

  // The mirrored stack plots upload as negative values; the tooltip and
  // axis flip the sign back.
  const plotData = useMemo(() => {
    if (!mirrored) return points
    return points.map((p) => {
      const next: RatePoint = { ...p }
      for (const s of series) {
        const key = upKey(s.key)
        next[key] = -(p[key] || 0)
      }
      return next
    })
  }, [points, series, mirrored])

  const chartConfig = useMemo(() => {
    const config: ChartConfig = {}
    for (const s of series) {
      config[downKey(s.key)] = { label: `${s.label} ↓`, color: s.color }
      config[upKey(s.key)] = { label: `${s.label} ↑`, color: s.color }
    }
    return config
  }, [series])

  const { domain, spanSeconds } = useMemo(
    () => chartTimeDomain(points, range),
    [points, range?.from, range?.to], // eslint-disable-line react-hooks/exhaustive-deps
  )

  if (points.length === 0 || series.length === 0) {
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground',
          className ?? 'h-[200px]',
        )}
      >
        {emptyMessage}
      </div>
    )
  }

  const axes = (
    <>
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
        tickFormatter={(value: number) => formatMbps(Math.abs(value), 1)}
      />
      <ChartTooltip
        cursor={{ stroke: 'var(--border)' }}
        content={(props) => (
          <RateTooltip
            active={props.active}
            payload={props.payload as ReadonlyArray<{ payload?: RatePoint }> | undefined}
            series={series}
            showDown={showDown}
            showUp={showUp}
          />
        )}
      />
      {mirrored ? <ReferenceLine y={0} stroke="var(--border)" /> : null}
    </>
  )

  return (
    <div className={cn('flex min-w-0 flex-col', className)}>
      <ZoomableAreaChart
        className="min-h-0 flex-1"
        onZoom={onZoom}
        onResetZoom={onResetZoom}
        canResetZoom={canResetZoom}
      >
        {({ onMouseDown, onMouseMove, onMouseUp, onMouseLeave, referenceArea }) => (
          <ChartContainer config={chartConfig} className="h-full w-full">
            {mode === 'lines' ? (
              <LineChart
                data={plotData}
                margin={{ top: 14, right: 8, left: 0, bottom: 0 }}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
                onMouseLeave={onMouseLeave}
              >
                {axes}
                {series.flatMap((s) => [
                  showDown ? (
                    <Line
                      key={downKey(s.key)}
                      isAnimationActive={false}
                      dataKey={downKey(s.key)}
                      type="linear"
                      stroke={s.color}
                      strokeWidth={1.75}
                      dot={false}
                      activeDot={{ r: 3 }}
                    />
                  ) : null,
                  showUp ? (
                    <Line
                      key={upKey(s.key)}
                      isAnimationActive={false}
                      dataKey={upKey(s.key)}
                      type="linear"
                      stroke={s.color}
                      strokeWidth={1.5}
                      strokeDasharray={direction === 'both' ? '5 3' : undefined}
                      dot={false}
                      activeDot={{ r: 3 }}
                    />
                  ) : null,
                ])}
                {referenceArea}
              </LineChart>
            ) : (
              <AreaChart
                data={plotData}
                stackOffset={mirrored ? 'sign' : 'none'}
                margin={{ top: 14, right: 8, left: 0, bottom: 0 }}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
                onMouseLeave={onMouseLeave}
              >
                {axes}
                {series.flatMap((s) => [
                  showDown ? (
                    <Area
                      key={downKey(s.key)}
                      isAnimationActive={false}
                      dataKey={downKey(s.key)}
                      type="linear"
                      stackId="down"
                      fill={s.color}
                      fillOpacity={0.45}
                      stroke={s.color}
                      strokeWidth={1}
                    />
                  ) : null,
                  showUp ? (
                    <Area
                      key={upKey(s.key)}
                      isAnimationActive={false}
                      dataKey={upKey(s.key)}
                      type="linear"
                      stackId="up"
                      fill={s.color}
                      fillOpacity={mirrored ? 0.3 : 0.45}
                      stroke={s.color}
                      strokeWidth={1}
                      strokeDasharray={mirrored ? '4 3' : undefined}
                    />
                  ) : null,
                ])}
                {referenceArea}
              </AreaChart>
            )}
          </ChartContainer>
        )}
      </ZoomableAreaChart>

      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-2 text-xs">
        {series.map((s) => (
          <div key={s.key} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-[2px]"
              style={{ backgroundColor: s.color }}
            />
            <span className="text-muted-foreground">{s.label}</span>
            {s.detail ? (
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground/80">
                {s.detail}
              </span>
            ) : null}
          </div>
        ))}
        {direction === 'both' ? (
          <span className="text-[11px] text-muted-foreground/80">
            {mode === 'lines' ? 'solid ↓ · dashed ↑' : '↓ above · ↑ below the axis'}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function RateTooltip({
  active,
  payload,
  series,
  showDown,
  showUp,
}: {
  active?: boolean
  payload?: ReadonlyArray<{ payload?: RatePoint }>
  series: RateSeries[]
  showDown: boolean
  showUp: boolean
}) {
  const row = payload?.[0]?.payload
  if (!active || !row) return null

  // Read straight off the row (not the stacked item values) and use the
  // absolute value so the mirrored stack reads as positive Mbps.
  const rows = series
    .map((s) => ({
      series: s,
      down: Math.abs(row[downKey(s.key)] || 0),
      up: Math.abs(row[upKey(s.key)] || 0),
    }))
    .sort((a, b) => (showDown ? b.down - a.down : 0) + (showUp ? b.up - a.up : 0))
  const totalDown = rows.reduce((sum, r) => sum + r.down, 0)
  const totalUp = rows.reduce((sum, r) => sum + r.up, 0)

  return (
    <div className="grid min-w-[12rem] gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{formatTooltipTimestamp(row.ts)}</div>
      <div className="grid gap-1">
        {rows.map((r) => (
          <div key={r.series.key} className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-[2px]"
                style={{ backgroundColor: r.series.color }}
              />
              <span className="truncate text-muted-foreground">{r.series.label}</span>
            </div>
            <span className="shrink-0 font-mono tabular-nums text-foreground">
              {showDown ? <span>↓ {formatMbps(r.down)}</span> : null}
              {showDown && showUp ? <span className="text-muted-foreground"> · </span> : null}
              {showUp ? <span>↑ {formatMbps(r.up)}</span> : null}
            </span>
          </div>
        ))}
      </div>
      {rows.length > 1 ? (
        <div className="flex items-center justify-between gap-3 border-t border-border/50 pt-1">
          <span className="text-muted-foreground">Total</span>
          <span className="font-mono tabular-nums font-medium text-foreground">
            {showDown ? <span>↓ {formatMbps(totalDown)}</span> : null}
            {showDown && showUp ? <span className="text-muted-foreground"> · </span> : null}
            {showUp ? <span>↑ {formatMbps(totalUp)}</span> : null}
          </span>
        </div>
      ) : null}
    </div>
  )
}
