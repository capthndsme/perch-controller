import { useMemo } from 'react'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { formatBytes, formatMbps } from '@/lib/format-bytes'
import { chartTimeDomain, formatAxisTick, formatTooltipTimestamp, type ChartRange } from '@/lib/time-window'

/** One bucket: rates in Mbps over the bucket's own seconds, and its bytes. */
export type TrafficChartPoint = {
  ts: number
  down: number
  up: number
  downBytes: number
  upBytes: number
}

type TrafficChartProps = {
  points: TrafficChartPoint[]
  /** The window the API read: the x-axis spans it. */
  range: ChartRange
  /** What each direction is: "Received", "RAX-1F → Garage AP". */
  downLabel: string
  upLabel: string
  className?: string
}

/**
 * The inspector's small accounting chart (docs/infrastructure-view.md A6.5):
 * two directions of one port or cable over the chosen span, download colour
 * for the direction into the device (or away from the gateway), upload colour
 * for the other. Every bucket of the window is there (quiet ones as zero) and
 * segments are straight. Loaded on its own (React.lazy) so the map's chunk
 * does not carry Recharts.
 */
export default function TrafficChart({ points, range, downLabel, upLabel, className }: TrafficChartProps) {
  const config = useMemo(
    () =>
      ({
        down: { label: downLabel, color: 'var(--chart-download)' },
        up: { label: upLabel, color: 'var(--chart-upload)' },
      }) satisfies ChartConfig,
    [downLabel, upLabel],
  )
  const { domain, spanSeconds } = useMemo(
    () => chartTimeDomain(points, range),
    [points, range.from, range.to], // eslint-disable-line react-hooks/exhaustive-deps
  )

  return (
    <ChartContainer config={config} className={className}>
      <AreaChart data={points} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="ts"
          type="number"
          domain={domain}
          scale="time"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          minTickGap={40}
          tickFormatter={(value: number) => formatAxisTick(value, spanSeconds)}
          allowDataOverflow
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={4}
          width={64}
          tickCount={3}
          tickFormatter={(value: number) => formatMbps(value, 1)}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              indicator="dot"
              labelFormatter={(_, payload) => {
                const ts = payload?.[0]?.payload?.ts
                return typeof ts === 'number' ? formatTooltipTimestamp(ts) : ''
              }}
              formatter={(value, name, item) => {
                const point = item.payload as TrafficChartPoint
                const bytes = name === 'down' ? point.downBytes : point.upBytes
                return (
                  <div className="flex w-full items-center justify-between gap-3">
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="size-2.5 shrink-0 rounded-[2px]"
                        style={{ backgroundColor: `var(--color-${String(name)})` }}
                      />
                      <span className="text-muted-foreground">{name === 'down' ? downLabel : upLabel}</span>
                    </span>
                    <span className="font-mono text-foreground">
                      {formatMbps(Number(value))}
                      <span className="ml-1 text-muted-foreground">({formatBytes(bytes)})</span>
                    </span>
                  </div>
                )
              }}
            />
          }
        />
        <Area
          isAnimationActive={false}
          dataKey="down"
          type="linear"
          fill="var(--color-down)"
          fillOpacity={0.25}
          stroke="var(--color-down)"
          strokeWidth={1.5}
        />
        <Area
          isAnimationActive={false}
          dataKey="up"
          type="linear"
          fill="var(--color-up)"
          fillOpacity={0.25}
          stroke="var(--color-up)"
          strokeWidth={1.5}
        />
      </AreaChart>
    </ChartContainer>
  )
}
