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
  buildProtocolChartConfig,
  formatProtocolLabel,
  type ProtocolStackPoint,
} from '@/lib/protocols'
import {
  formatAxisTick,
  formatTooltipTimestamp,
  type TimeWindow,
} from '@/lib/time-window'

type ProtocolStackChartProps = {
  data: ProtocolStackPoint[]
  protocols: string[]
  className?: string
  onZoom?: (window: TimeWindow) => void
  onResetZoom?: () => void
  canResetZoom?: boolean
  /** LTTB point budget for wide windows; see BandwidthChart. */
  maxPoints?: number
  /**
   * Label + colour per series key. Defaults to the protocol table; pass
   * `buildCategoryChartConfig` when the keys are nDPI categories.
   */
  config?: ChartConfig
}

export function ProtocolStackChart({
  data,
  protocols,
  className,
  onZoom,
  onResetZoom,
  canResetZoom,
  maxPoints = 2000,
  config,
}: ProtocolStackChartProps) {
  const chartConfig = useMemo(() => config ?? buildProtocolChartConfig(protocols), [config, protocols])
  const labelFor = (key: string) => String(chartConfig[key]?.label ?? formatProtocolLabel(key))

  // Downsample by total stacked magnitude so the busiest moments survive.
  const points = useMemo(
    () =>
      downsampleTimeSeries(data, maxPoints, (p) =>
        protocols.reduce((sum, key) => sum + (Number((p as Record<string, number>)[key]) || 0), 0),
      ),
    [data, maxPoints, protocols],
  )

  const { domain, spanSeconds } = useMemo(() => {
    if (points.length === 0) {
      return {
        domain: ['auto', 'auto'] as [number | string, number | string],
        spanSeconds: 0,
      }
    }
    const min = points[0].ts
    const max = points[points.length - 1].ts
    return { domain: [min, max] as [number, number], spanSeconds: (max - min) / 1000 }
  }, [points])

  if (points.length === 0 || protocols.length === 0) {
    return null
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
            data={points}
            stackOffset="none"
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
              // Sort each tooltip's payload by value descending so the
              // dominant protocols line up at the top of the popover.
              // We read the value off `payload[dataKey]` rather than
              // `item.value`: for a stacked AreaChart the latter is
              // the cumulative stack height and can disagree with the
              // formatter's displayed value. NB: this prop has to
              // live on the Tooltip (not on the inner content)
              // because Recharts `cloneElement`s the content with
              // its own props, and the default `itemSorter: 'name'`
              // would otherwise wipe out a value set directly on
              // `ChartTooltipContent`.
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
                    return typeof ts === 'number'
                      ? formatTooltipTimestamp(ts)
                      : 'Protocol rate'
                  }}
                  formatter={(value, name, item) => {
                    const payload = item.payload as ProtocolStackPoint
                    const protocol = String(name)
                    const bytes = payload.bytesByProtocol[protocol] ?? 0
                    return (
                      <div className="flex w-full items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <span
                            aria-hidden
                            className="size-2.5 shrink-0 rounded-[2px]"
                            style={{ backgroundColor: `var(--color-${protocol})` }}
                          />
                          <span className="text-muted-foreground">
                            {labelFor(protocol)}
                          </span>
                        </div>
                        <span className="font-mono text-foreground">
                          {formatMbps(Number(value))}
                          {bytes > 0 ? (
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
            <ChartLegend
              content={<ChartLegendContent nameKey="dataKey" />}
              formatter={(value) => labelFor(String(value))}
            />
            {protocols.map((protocol) => (
              <Area
                key={protocol}
                isAnimationActive={false}
                dataKey={protocol}
                type="monotone"
                stackId="protocols"
                fill={`var(--color-${protocol})`}
                fillOpacity={0.65}
                stroke={`var(--color-${protocol})`}
                strokeWidth={1}
              />
            ))}
            {referenceArea}
          </AreaChart>
        </ChartContainer>
      )}
    </ZoomableAreaChart>
  )
}
