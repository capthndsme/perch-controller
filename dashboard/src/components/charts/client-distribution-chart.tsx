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
import {
  breakGaps,
  chartTimeDomain,
  formatAxisTick,
  formatTooltipTimestamp,
  type ChartRange,
  type TimeWindow,
} from '@/lib/time-window'
import type { WifiClientHistoryBucket } from '@/types/api'
import { formatWifiBand } from '@/lib/wifi'

type ClientDistributionChartProps = {
  data: WifiClientHistoryBucket[]
  groupBy: 'band' | 'ap'
  allBands: string[]
  allAps: string[]
  onZoom?: (window: TimeWindow) => void
  onResetZoom?: () => void
  canResetZoom?: boolean
  className?: string
  /** The window the API read: the x-axis spans it. */
  range?: ChartRange
  /** Bucket width (s): a gap longer than two buckets is "no report", drawn as a break. */
  stepSeconds?: number
  /**
   * Colour of an AP by name, shared with the AP throughput chart so an AP
   * wears one colour across the page. Defaults to its position in `allAps`.
   */
  apColor?: (name: string) => string
}

function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '_')
}

export function ClientDistributionChart({
  data,
  groupBy,
  allBands,
  allAps,
  onZoom,
  onResetZoom,
  canResetZoom,
  className,
  range,
  stepSeconds,
  apColor,
}: ClientDistributionChartProps) {
  const sanitizedSeries = useMemo(() => {
    if (groupBy === 'band') {
      return allBands.map((band) => ({
        original: band,
        key: sanitizeKey(band),
        label: formatWifiBand(band),
      }))
    } else {
      return allAps.map((ap) => ({
        original: ap,
        key: sanitizeKey(ap),
        label: ap,
      }))
    }
  }, [groupBy, allBands, allAps])

  const flattenedData = useMemo(() => {
    const points = data.map((bucket) => {
      const point: { ts: number } & Record<string, number> = {
        ts: bucket.ts,
        total: bucket.total,
      }
      for (const series of sanitizedSeries) {
        if (groupBy === 'band') {
          point[series.key] = bucket.bands[series.original] ?? 0
        } else {
          point[series.key] = bucket.aps[series.original] ?? 0
        }
      }
      return point
    })
    // Buckets exist only where an AP reported: a longer silence is unknown,
    // not zero clients, so the stack breaks there instead of bridging it.
    return stepSeconds ? breakGaps(points, stepSeconds * 1000) : points
  }, [data, groupBy, sanitizedSeries, stepSeconds])

  const chartConfig = useMemo(() => {
    const config: ChartConfig = {}
    if (groupBy === 'band') {
      // Bands keep fixed series slots (entity-stable): 2.4 GHz amber,
      // 5 GHz aqua, 6 GHz violet; unknown wears the neutral slot.
      const bandColors: Record<string, string> = {
        '2_4': 'var(--series-4)',
        '5': 'var(--series-3)',
        '6': 'var(--series-7)',
        'Unknown': 'var(--series-other)',
      }
      for (const series of sanitizedSeries) {
        config[series.key] = {
          label: series.label,
          color: bandColors[series.key] ?? 'oklch(0.6 0 0)',
        }
      }
    } else {
      const apColors = [
        'var(--series-1)',
        'var(--series-2)',
        'var(--series-3)',
        'var(--series-4)',
        'var(--series-5)',
        'var(--series-6)',
        'var(--series-7)',
        'var(--series-8)',
      ]
      sanitizedSeries.forEach((series, index) => {
        config[series.key] = {
          label: series.label,
          color: apColor ? apColor(series.original) : apColors[index % apColors.length],
        }
      })
    }
    return config
  }, [groupBy, sanitizedSeries, apColor])

  const { domain, spanSeconds } = useMemo(
    () => chartTimeDomain(flattenedData, range),
    [flattenedData, range?.from, range?.to], // eslint-disable-line react-hooks/exhaustive-deps
  )

  if (flattenedData.length === 0 || sanitizedSeries.length === 0) {
    return (
      <div className="flex h-[200px] items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
        No historical client data available for this range.
      </div>
    )
  }

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
            data={flattenedData}
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
              width={36}
              allowDecimals={false}
            />
            <ChartTooltip
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
                  formatter={(value, name) => {
                    const seriesKey = String(name)
                    const series = sanitizedSeries.find((s) => s.key === seriesKey)
                    const label = series?.label ?? name
                    return (
                      <div className="flex w-full items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <span
                            aria-hidden
                            className="size-2.5 shrink-0 rounded-[2px]"
                            style={{ backgroundColor: `var(--color-${seriesKey})` }}
                          />
                          <span className="text-muted-foreground">
                            {label}
                          </span>
                        </div>
                        <span className="font-mono text-foreground font-medium">
                          {value} {Number(value) === 1 ? 'client' : 'clients'}
                        </span>
                      </div>
                    )
                  }}
                />
              }
            />
            <ChartLegend content={<ChartLegendContent />} />
            {sanitizedSeries.map((series) => (
              <Area
                key={series.key}
                isAnimationActive={false}
                dataKey={series.key}
                type="linear"
                stackId="clients"
                fill={`var(--color-${series.key})`}
                fillOpacity={0.4}
                stroke={`var(--color-${series.key})`}
                strokeWidth={1.5}
              />
            ))}
            {referenceArea}
          </AreaChart>
        </ChartContainer>
      )}
    </ZoomableAreaChart>
  )
}
