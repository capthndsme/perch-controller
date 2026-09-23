import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, Line, XAxis, YAxis, type MouseHandlerDataParam } from 'recharts'
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, type ChartConfig } from '@/components/ui/chart'
import { byteAxisTicks, formatBytes, formatMbps } from '@/lib/format-bytes'
import { bucketHint, bucketTick, bucketTitle } from '@/lib/usage'
import type { UsageBucket, UsagePeriod } from '@/types/api'

const config = {
  bytesIn: { label: 'Download', color: 'var(--chart-download)' },
  bytesOut: { label: 'Upload', color: 'var(--chart-upload)' },
} satisfies ChartConfig

// Recharts stacks same-side axes in yAxisId order, innermost first: the
// Mbps axis sits beside the plot, the device count outside it.
const RATE_AXIS = 'right-1-rate'
const DEVICES_AXIS = 'right-2-devices'

const overlayConfig = {
  ...config,
  avgMbps: { label: 'Avg rate', color: 'var(--muted-foreground)' },
  activeDevices: { label: 'Devices', color: 'var(--series-1)' },
} satisfies ChartConfig

/** One column of the down / up chart, already labelled for its axis and tooltip. */
export type UsageColumnPoint = {
  key: string
  tick: string
  title: string
  hint: string | null
  partial: boolean
  bytesIn: number
  bytesOut: number
  totalBytes: number
  avgMbps: number
  /** Shown as an extra tooltip row when present (the hourly breakdown). */
  activeDevices?: number
}

type UsageColumnChartProps = {
  points: UsageColumnPoint[]
  className?: string
  /** Widest bar; the hourly breakdown packs more columns and uses a smaller cap. */
  maxBarSize?: number
  /** Skip axis labels between the first and last when the columns are dense. */
  minTickGap?: number
  /**
   * Overlay the average rate and active-device lines (the hourly
   * breakdown). `slotSeconds` is the full column length, which ties the
   * rate axis to the byte axis.
   */
  overlay?: { slotSeconds: number }
  /** Column index clicked (a tap on touch screens). Makes the columns look clickable. */
  onColumnClick?: (index: number) => void
  /** Column index under the pointer, `null` when it leaves the plot. */
  onColumnHover?: (index: number | null) => void
  /** Outlined column (the one a detail view below the chart is showing). */
  selectedIndex?: number | null
}

/** The column a chart event points at, if any (recharts gives a number or a string). */
function columnIndex(state: MouseHandlerDataParam, count: number): number | null {
  const raw = state.activeTooltipIndex
  if (raw === null || raw === undefined || raw === '') return null
  const index = Number(raw)
  return Number.isInteger(index) && index >= 0 && index < count ? index : null
}

/**
 * Stacked columns: download at the baseline, upload on top. A partial
 * column (the running bucket, or one cut short by the window) is drawn
 * lighter and says "so far" in the tooltip. Bars are capped in width with a
 * 1px card-colour stroke so the two segments never touch; identity comes
 * from the legend, values from the tooltip and the table.
 *
 * With `overlay`, two lines ride on top. Avg rate (dashed) sits on a right
 * Mbps axis that is the byte axis converted at the slot length, not a
 * second scale: it runs through the bar tops, and on a partial column it
 * shows the pace so far. Devices (solid) is a count on its own outer axis.
 * Still a BarChart, which in recharts 3 takes Line children and keeps the
 * column-wide hover band.
 */
export function UsageColumnChart({
  points,
  className,
  maxBarSize = 24,
  minTickGap = 24,
  overlay,
  onColumnClick,
  onColumnHover,
  selectedIndex = null,
}: UsageColumnChartProps) {
  const slotSeconds = overlay?.slotSeconds ?? 0
  const scale = useMemo(() => {
    if (slotSeconds <= 0) return null
    // Mbps of a full column per byte in it.
    const mbpsPerByte = 8 / slotSeconds / 1_000_000
    const max = Math.max(0, ...points.map((p) => Math.max(p.totalBytes, p.avgMbps / mbpsPerByte)))
    const { ticks, format } = byteAxisTicks(max)
    return { mbpsPerByte, ticks, format, top: ticks[ticks.length - 1] }
  }, [slotSeconds, points])

  return (
    <ChartContainer config={scale ? overlayConfig : config} className={className}>
      <BarChart
        data={points}
        margin={{ top: 8, right: scale ? 0 : 8, left: 0, bottom: 0 }}
        barCategoryGap="28%"
        style={onColumnClick ? { cursor: 'pointer' } : undefined}
        onClick={
          onColumnClick
            ? (state) => {
                const index = columnIndex(state, points.length)
                if (index !== null) onColumnClick(index)
              }
            : undefined
        }
        onMouseMove={onColumnHover ? (state) => onColumnHover(columnIndex(state, points.length)) : undefined}
        onMouseLeave={onColumnHover ? () => onColumnHover(null) : undefined}
      >
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey="tick"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={minTickGap}
          interval="preserveStartEnd"
        />
        {scale ? (
          <YAxis
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            width={64}
            domain={[0, scale.top]}
            ticks={scale.ticks}
            tickFormatter={scale.format}
          />
        ) : (
          <YAxis
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            width={64}
            allowDecimals={false}
            tickFormatter={(value: number) => formatBytes(value, 0)}
          />
        )}
        {scale ? (
          <YAxis
            yAxisId={RATE_AXIS}
            orientation="right"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            width={72}
            domain={[0, scale.top * scale.mbpsPerByte]}
            ticks={scale.ticks.map((t) => t * scale.mbpsPerByte)}
            tickFormatter={formatRateTick}
          />
        ) : null}
        {scale ? (
          <YAxis
            yAxisId={DEVICES_AXIS}
            orientation="right"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            width={32}
            allowDecimals={false}
          />
        ) : null}
        <ChartTooltip
          cursor={{ fill: 'var(--muted)', fillOpacity: 0.5 }}
          content={({ active, payload }) => {
            const point = payload?.[0]?.payload as UsageColumnPoint | undefined
            if (!active || !point) return null
            return (
              <div className="min-w-44 rounded-md border border-border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-xl">
                <p className="mb-1.5 font-medium">
                  {point.title}
                  {point.hint ? <span className="ml-1 text-muted-foreground">· {point.hint}</span> : null}
                </p>
                <Row swatch="var(--chart-download)" label="Download" value={formatBytes(point.bytesIn)} />
                <Row swatch="var(--chart-upload)" label="Upload" value={formatBytes(point.bytesOut)} />
                <Row label={point.partial ? 'Total so far' : 'Total'} value={formatBytes(point.totalBytes)} strong />
                <Row
                  swatch={scale ? 'var(--color-avgMbps)' : undefined}
                  label="Avg rate"
                  value={formatMbps(point.avgMbps)}
                />
                {point.activeDevices !== undefined ? (
                  <Row
                    swatch={scale ? 'var(--color-activeDevices)' : undefined}
                    label="Devices"
                    value={String(point.activeDevices)}
                  />
                ) : null}
              </div>
            )
          }}
        />
        <ChartLegend content={<ChartLegendContent />} itemSorter={null} />
        <Bar
          dataKey="bytesIn"
          stackId="usage"
          fill="var(--color-bytesIn)"
          stroke="var(--card)"
          strokeWidth={1}
          maxBarSize={maxBarSize}
          isAnimationActive={false}
        >
          {points.map((p, i) => (
            <Cell key={p.key} fillOpacity={p.partial ? 0.45 : 1} {...selectedStroke(i === selectedIndex)} />
          ))}
        </Bar>
        <Bar
          dataKey="bytesOut"
          stackId="usage"
          fill="var(--color-bytesOut)"
          stroke="var(--card)"
          strokeWidth={1}
          radius={[4, 4, 0, 0]}
          maxBarSize={maxBarSize}
          isAnimationActive={false}
        >
          {points.map((p, i) => (
            <Cell key={p.key} fillOpacity={p.partial ? 0.45 : 1} {...selectedStroke(i === selectedIndex)} />
          ))}
        </Bar>
        {scale ? (
          <Line
            yAxisId={RATE_AXIS}
            dataKey="avgMbps"
            type="monotone"
            stroke="var(--color-avgMbps)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={false}
            activeDot={{ r: 4, stroke: 'var(--card)', strokeWidth: 2 }}
            isAnimationActive={false}
          />
        ) : null}
        {scale ? (
          <Line
            yAxisId={DEVICES_AXIS}
            dataKey="activeDevices"
            type="monotone"
            stroke="var(--color-activeDevices)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, stroke: 'var(--card)', strokeWidth: 2 }}
            isAnimationActive={false}
          />
        ) : null}
      </BarChart>
    </ChartContainer>
  )
}

/** The selected column is outlined in the foreground colour (both themes); the rest keep the card-colour gap. */
function selectedStroke(selected: boolean): { stroke?: string; strokeWidth?: number } {
  return selected ? { stroke: 'var(--foreground)', strokeWidth: 1.5 } : {}
}

function formatRateTick(mbps: number): string {
  if (mbps === 0) return '0'
  return formatMbps(mbps, mbps >= 1 ? 1 : 2)
}

type UsageBarChartProps = {
  period: UsagePeriod
  buckets: UsageBucket[]
  className?: string
} & Pick<UsageColumnChartProps, 'onColumnClick' | 'onColumnHover' | 'selectedIndex' | 'maxBarSize'>

/** The per-day / week / month usage columns (labels from the API bucket label). */
export function UsageBarChart({ period, buckets, className, ...interaction }: UsageBarChartProps) {
  const points = useMemo<UsageColumnPoint[]>(
    () =>
      buckets.map((b) => ({
        key: b.bucketStart,
        tick: bucketTick(period, b.label),
        title: bucketTitle(period, b.label),
        hint: bucketHint(period, b),
        partial: b.partial,
        bytesIn: b.bytesIn,
        bytesOut: b.bytesOut,
        totalBytes: b.totalBytes,
        avgMbps: b.avgMbps,
      })),
    [buckets, period],
  )
  return <UsageColumnChart points={points} className={className} {...interaction} />
}

export function Row({
  swatch,
  label,
  value,
  strong = false,
}: {
  swatch?: string
  label: string
  value: string
  strong?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-px">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {swatch ? <span aria-hidden className="size-2 rounded-[2px]" style={{ backgroundColor: swatch }} /> : null}
        {label}
      </span>
      <span className={strong ? 'font-mono font-medium tabular-nums' : 'font-mono tabular-nums'}>{value}</span>
    </div>
  )
}
