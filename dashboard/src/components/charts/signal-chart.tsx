import { useMemo } from 'react'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import {
  ChartContainer,
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

export type SignalPoint = {
  ts: number
  signalDbm: number | null
  snrDb?: number | null
}

const chartConfig = {
  signalDbm: {
    label: 'Signal (dBm)',
    color: 'var(--brand)',
  },
} satisfies ChartConfig

export function SignalChart({
  data,
  className,
  onZoom,
  onResetZoom,
  canResetZoom,
  range,
  stepSeconds,
}: {
  data: SignalPoint[]
  className?: string
  onZoom?: (window: TimeWindow) => void
  onResetZoom?: () => void
  canResetZoom?: boolean
  /** The window the API read: the x-axis spans it. */
  range?: ChartRange
  /**
   * Bucket width (s). A bucket exists only while an AP listed the client, so
   * a longer gap is "not connected" and drawn as a break, not bridged.
   */
  stepSeconds?: number
}) {
  const points = useMemo(
    () => (stepSeconds ? breakGaps(data, stepSeconds * 1000) : data),
    [data, stepSeconds],
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
              width={64}
              tickFormatter={(value: number) => `${Math.round(value)} dBm`}
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
                    const payload = item.payload as SignalPoint
                    if (String(name) === 'signalDbm') {
                      return (
                        <div className="flex w-full items-center justify-between gap-3">
                          <span className="text-muted-foreground">Signal</span>
                          <span className="font-mono text-foreground">
                            {Math.round(Number(value))} dBm
                            {payload.snrDb !== null && payload.snrDb !== undefined ? (
                              <span className="ml-1 text-muted-foreground">
                                ({Math.round(payload.snrDb)} dB SNR)
                              </span>
                            ) : null}
                          </span>
                        </div>
                      )
                    }
                    return value
                  }}
                />
              }
            />
            <Area
              isAnimationActive={false}
              dataKey="signalDbm"
              type="linear"
              fill="var(--color-signalDbm)"
              fillOpacity={0.2}
              stroke="var(--color-signalDbm)"
              strokeWidth={2}
            />
            {referenceArea}
          </AreaChart>
        </ChartContainer>
      )}
    </ZoomableAreaChart>
  )
}
