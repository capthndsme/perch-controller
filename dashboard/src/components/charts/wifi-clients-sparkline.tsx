import { useMemo } from 'react'
import { Area, AreaChart, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { formatTooltipTimestamp } from '@/lib/time-window'
import type { WifiClientHistoryBucket } from '@/types/api'

const config = {
  total: { label: 'Clients', color: 'var(--brand)' },
} satisfies ChartConfig

type WifiClientsSparklineProps = {
  data: WifiClientHistoryBucket[]
  className?: string
}

/**
 * Deliberately small: one filled line of "connected Wi-Fi clients" over the
 * dashboard window, no axes, hover for the exact count. The full per-band /
 * per-AP breakdown lives on the Wi-Fi page.
 */
export function WifiClientsSparkline({ data, className }: WifiClientsSparklineProps) {
  const points = useMemo(() => data.map((b) => ({ ts: b.ts, total: b.total })), [data])
  if (points.length < 2) return null

  return (
    <ChartContainer config={config} className={className}>
      <AreaChart data={points} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
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
          type="monotone"
          fill="var(--color-total)"
          fillOpacity={0.16}
          stroke="var(--color-total)"
          strokeWidth={1.5}
        />
      </AreaChart>
    </ChartContainer>
  )
}
