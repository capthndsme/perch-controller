import { useMemo } from 'react'
import { Area, AreaChart, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import {
  breakGaps,
  chartTimeDomain,
  formatTooltipTimestamp,
  type ChartRange,
} from '@/lib/time-window'
import type { WifiClientHistoryBucket } from '@/types/api'

const config = {
  total: { label: 'Clients', color: 'var(--brand)' },
} satisfies ChartConfig

type WifiClientsSparklineProps = {
  data: WifiClientHistoryBucket[]
  className?: string
  /** The window the API read: the strip spans it (a time axis, not one point per slot). */
  range?: ChartRange
  /** Bucket width (s): a longer silence is drawn as a break, not bridged. */
  stepSeconds?: number
}

/**
 * Deliberately small: one filled line of "connected Wi-Fi clients" over the
 * dashboard window, no axes, hover for the exact count. The full per-band /
 * per-AP breakdown lives on the Wi-Fi page.
 */
export function WifiClientsSparkline({ data, className, range, stepSeconds }: WifiClientsSparklineProps) {
  const points = useMemo(() => {
    const mapped = data.map((b) => ({ ts: b.ts, total: b.total as number | null }))
    return stepSeconds ? breakGaps(mapped, stepSeconds * 1000) : mapped
  }, [data, stepSeconds])
  const { domain } = useMemo(
    () => chartTimeDomain(points, range),
    [points, range?.from, range?.to], // eslint-disable-line react-hooks/exhaustive-deps
  )
  if (points.length < 2) return null

  return (
    <ChartContainer config={config} className={className}>
      <AreaChart data={points} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
        <XAxis hide dataKey="ts" type="number" scale="time" domain={domain} allowDataOverflow />
        <YAxis hide domain={[0, 'auto']} allowDecimals={false} />
        <ChartTooltip
          cursor={{ stroke: 'var(--border)' }}
          content={
            <ChartTooltipContent
              hideIndicator
              labelFormatter={(_, payload) => {
                const ts = payload?.[0]?.payload?.ts
                return typeof ts === 'number' ? formatTooltipTimestamp(ts) : ''
              }}
              formatter={(value) => (
                <div className="flex w-full items-center justify-between gap-3">
                  <span className="text-muted-foreground">Clients</span>
                  <span className="font-mono text-foreground">{Number(value)}</span>
                </div>
              )}
            />
          }
        />
        <Area
          isAnimationActive={false}
          dataKey="total"
          type="linear"
          fill="var(--color-total)"
          fillOpacity={0.16}
          stroke="var(--color-total)"
          strokeWidth={1.5}
        />
      </AreaChart>
    </ChartContainer>
  )
}
