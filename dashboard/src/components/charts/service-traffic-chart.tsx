import { useMemo, useState } from 'react'
import { ChartLine } from '@phosphor-icons/react'
import { Area, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from 'recharts'
import { Button } from '@/components/ui/button'
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, type ChartConfig } from '@/components/ui/chart'
import { formatBytes, formatMbps } from '@/lib/format-bytes'
import { downsampleTimeSeries } from '@/lib/traffic'
import { formatAxisTick, formatTooltipTimestamp } from '@/lib/time-window'
import { cn } from '@/lib/utils'

export type { ServiceTrafficPoint } from '@/lib/services'
import type { ServiceTrafficPoint } from '@/lib/services'

const SERVED_CONFIG = {
  served: { label: 'Served', color: 'var(--chart-served)' },
  received: { label: 'Received', color: 'var(--chart-received)' },
} satisfies ChartConfig

/** Label + colour for the two keys; see `DESTINATION_SERIES_CONFIG` in lib/destinations. */
export type SeriesConfig = { served: { label: string; color: string }; received: { label: string; color: string } }

/**
 * `hidden`: bytes only (the default, unchanged for existing callers).
 * `on` / `off`: render a Rate toggle above the chart, initially on / off.
 */
export type RateOverlayMode = 'hidden' | 'on' | 'off'

type RatePoint = ServiceTrafficPoint & { servedMbps: number; receivedMbps: number }

function mbps(bytes: number, seconds: number): number {
  if (seconds <= 0) return 0
  return (bytes * 8) / seconds / 1_000_000
}

/**
 * Bytes served / received per bucket for one server name. Two series, one
 * axis, fixed colors (served = upload green, received = download red —
 * the same meaning those hues carry on the bandwidth chart). Pass `series`
 * to relabel the two keys (see `DESTINATION_SERIES_CONFIG` in lib/destinations).
 *
 * The optional rate overlay draws each series' average rate over its bucket
 * (bytes × 8 / bucket seconds) as a thin dashed line on a right-hand Mbps
 * axis, so a burst inside a short bucket reads as a peak even when the
 * byte bars look flat. `seconds` is each bucket's length inside the window,
 * so the partial first and last buckets read at their true rate.
 *
 * The series is dense (the API zero-fills empty buckets), and drawn linear so
 * a run of zeros stays flat and a burst is not smoothed across its neighbours.
 */
export function ServiceTrafficChart({
  data,
  className,
  maxPoints = 1500,
  series,
  rateOverlay = 'hidden',
}: {
  data: ServiceTrafficPoint[]
  className?: string
  maxPoints?: number
  series?: SeriesConfig
  rateOverlay?: RateOverlayMode
}) {
  const [rateOn, setRateOn] = useState(rateOverlay === 'on')
  const showRate = rateOverlay !== 'hidden' && rateOn
  const seriesConfig: SeriesConfig = series ?? SERVED_CONFIG
  const chartConfig = useMemo(
    () =>
      ({
        ...seriesConfig,
        servedMbps: { label: `${seriesConfig.served.label} rate`, color: seriesConfig.served.color },
        receivedMbps: { label: `${seriesConfig.received.label} rate`, color: seriesConfig.received.color },
      }) satisfies ChartConfig,
    [seriesConfig],
  )

  const points = useMemo<RatePoint[]>(() => {
    const sampled = downsampleTimeSeries(data, maxPoints, (p) => p.served + p.received)
    return sampled.map((p) => ({
      ...p,
      servedMbps: mbps(p.served, p.seconds),
      receivedMbps: mbps(p.received, p.seconds),
    }))
  }, [data, maxPoints])
  const { domain, spanSeconds } = useMemo(() => {
    if (points.length === 0) {
      return { domain: ['auto', 'auto'] as [number | string, number | string], spanSeconds: 0 }
    }
    const min = points[0].ts
    const max = points[points.length - 1].ts
    return { domain: [min, max] as [number, number], spanSeconds: (max - min) / 1000 }
  }, [points])

  return (
    <div className={cn('flex min-w-0 flex-col', className)}>
      {rateOverlay !== 'hidden' ? (
        <div className="flex justify-end pb-1">
          <Button
            type="button"
            size="sm"
            variant={showRate ? 'secondary' : 'ghost'}
            className="h-6 gap-1 px-2 text-xs"
            aria-pressed={showRate}
            title="Overlay the average rate of each bucket (Mbps, right axis)"
            onClick={() => setRateOn((v) => !v)}
          >
            <ChartLine className="size-3.5" />
            Rate
          </Button>
        </div>
      ) : null}
      <ChartContainer config={chartConfig} className="min-h-0 w-full flex-1">
        <ComposedChart data={points} margin={{ top: 8, right: showRate ? 4 : 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
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
          />
          <YAxis
            yAxisId="bytes"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            width={64}
            tickFormatter={(value: number) => formatBytes(value, 0)}
          />
          {showRate ? (
            <YAxis
              yAxisId="rate"
              orientation="right"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={76}
              tickFormatter={(value: number) => formatMbps(value, value >= 10 ? 0 : 1)}
            />
          ) : null}
          <ChartTooltip
            cursor={{ stroke: 'var(--border)' }}
            content={({ active, payload }) => {
              const point = payload?.[0]?.payload as RatePoint | undefined
              if (!active || !point) return null
              return (
                <div className="min-w-48 rounded-md border border-border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-xl">
                  <p className="mb-1.5 font-medium">{formatTooltipTimestamp(point.ts)}</p>
                  <Row
                    swatch={seriesConfig.served.color}
                    label={seriesConfig.served.label}
                    value={formatBytes(point.served)}
                    rate={showRate ? formatMbps(point.servedMbps) : undefined}
                  />
                  <Row
                    swatch={seriesConfig.received.color}
                    label={seriesConfig.received.label}
                    value={formatBytes(point.received)}
                    rate={showRate ? formatMbps(point.receivedMbps) : undefined}
                  />
                </div>
              )
            }}
          />
          <ChartLegend content={<ChartLegendContent />} />
          <Area
            yAxisId="bytes"
            isAnimationActive={false}
            dataKey="served"
            type="linear"
            fill="var(--color-served)"
            fillOpacity={0.2}
            stroke="var(--color-served)"
            strokeWidth={2}
          />
          <Area
            yAxisId="bytes"
            isAnimationActive={false}
            dataKey="received"
            type="linear"
            fill="var(--color-received)"
            fillOpacity={0.15}
            stroke="var(--color-received)"
            strokeWidth={2}
          />
          {showRate ? (
            <Line
              yAxisId="rate"
              isAnimationActive={false}
              dataKey="servedMbps"
              type="linear"
              stroke="var(--color-servedMbps)"
              strokeWidth={1.25}
              strokeDasharray="3 3"
              dot={false}
              activeDot={{ r: 3 }}
            />
          ) : null}
          {showRate ? (
            <Line
              yAxisId="rate"
              isAnimationActive={false}
              dataKey="receivedMbps"
              type="linear"
              stroke="var(--color-receivedMbps)"
              strokeWidth={1.25}
              strokeDasharray="3 3"
              dot={false}
              activeDot={{ r: 3 }}
            />
          ) : null}
        </ComposedChart>
      </ChartContainer>
    </div>
  )
}

function Row({ swatch, label, value, rate }: { swatch: string; label: string; value: string; rate?: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-px">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <span aria-hidden className="size-2 rounded-[2px]" style={{ backgroundColor: swatch }} />
        {label}
      </span>
      <span className="font-mono tabular-nums">
        {value}
        {rate ? <span className="ml-1.5 text-muted-foreground">{rate}</span> : null}
      </span>
    </div>
  )
}
