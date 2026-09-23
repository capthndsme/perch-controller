import { useMemo } from 'react'
import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from 'recharts'
import { ZoomableAreaChart } from '@/components/charts/zoomable-area-chart'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { formatMbps } from '@/lib/format-bytes'
import { scopeMarkLabel } from '@/lib/networks'
import { formatAxisTick, formatTooltipTimestamp, type TimeWindow } from '@/lib/time-window'
import { cn } from '@/lib/utils'
import type { NetworkHistoryPoint, NetworkScopeMark } from '@/types/networks'

const config = {
  downloadMbps: { label: 'Download', color: 'var(--chart-download)' },
  uploadMbps: { label: 'Upload', color: 'var(--chart-upload)' },
} satisfies ChartConfig

/** Axis ticks short enough not to wrap: "40 Mbps", "2.5 Mbps". */
function formatMbpsTick(value: number): string {
  if (!Number.isFinite(value)) return ''
  if (Math.abs(value) >= 10 || Number.isInteger(value)) return `${Math.round(value)} Mbps`
  return `${value.toFixed(1)} Mbps`
}

type Row = { ts: number; downloadMbps: number | null; uploadMbps: number | null }

/**
 * A network's rate over the window in client terms (download = what the
 * router sent into the network), from the router's interface counters. The
 * dashed marks are the dates the WAN/LAN scope rule changed (owner decision 8):
 * before a "routed" mark, routed LAN↔LAN traffic and traffic to the router's
 * own addresses counted as WAN in the per-device charts.
 */
export function NetworkHistoryChart({
  points,
  scopeChanges,
  className,
  onZoom,
  onResetZoom,
  canResetZoom,
}: {
  points: NetworkHistoryPoint[]
  scopeChanges: NetworkScopeMark[]
  className?: string
  onZoom?: (window: TimeWindow) => void
  onResetZoom?: () => void
  canResetZoom?: boolean
}) {
  const data = useMemo<Row[]>(
    () =>
      points.map((p) => ({
        ts: p.ts,
        downloadMbps: p.txBps === null ? null : p.txBps / 1_000_000,
        uploadMbps: p.rxBps === null ? null : p.rxBps / 1_000_000,
      })),
    [points],
  )
  const marks = useMemo(
    () => scopeChanges.map((c) => ({ ...c, ts: Date.parse(c.changedAt) })).filter((c) => Number.isFinite(c.ts)),
    [scopeChanges],
  )
  const spanSeconds = data.length > 1 ? (data[data.length - 1].ts - data[0].ts) / 1000 : 0

  if (data.length === 0) {
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground',
          className ?? 'h-[220px]',
        )}
      >
        No samples for this range.
      </div>
    )
  }

  const domain: [number, number] = [
    Math.min(data[0].ts, ...marks.map((m) => m.ts)),
    Math.max(data[data.length - 1].ts, ...marks.map((m) => m.ts)),
  ]

  return (
    <ZoomableAreaChart className={className ?? 'h-[240px]'} onZoom={onZoom} onResetZoom={onResetZoom} canResetZoom={canResetZoom}>
      {({ onMouseDown, onMouseMove, onMouseUp, onMouseLeave, referenceArea }) => (
        <ChartContainer config={config} className="h-full w-full">
          <AreaChart
            data={data}
            margin={{ top: 18, right: 8, left: 0, bottom: 0 }}
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
              tickFormatter={formatMbpsTick}
            />
            <ChartTooltip
              cursor={{ stroke: 'var(--border)' }}
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) => {
                    const ts = (payload?.[0]?.payload as Row | undefined)?.ts
                    return ts ? formatTooltipTimestamp(ts) : ''
                  }}
                  formatter={(value, name) => (
                    <span className="flex w-full justify-between gap-3">
                      <span className="text-muted-foreground">{config[name as keyof typeof config]?.label ?? name}</span>
                      <span className="font-mono tabular-nums">{formatMbps(Number(value))}</span>
                    </span>
                  )}
                />
              }
            />
            <Area
              isAnimationActive={false}
              dataKey="downloadMbps"
              type="monotone"
              stroke="var(--color-downloadMbps)"
              fill="var(--color-downloadMbps)"
              fillOpacity={0.18}
              strokeWidth={1.5}
              connectNulls={false}
            />
            <Area
              isAnimationActive={false}
              dataKey="uploadMbps"
              type="monotone"
              stroke="var(--color-uploadMbps)"
              fill="var(--color-uploadMbps)"
              fillOpacity={0.14}
              strokeWidth={1.5}
              connectNulls={false}
            />
            {marks.map((m) => (
              <ReferenceLine
                key={`${m.scope}-${m.ts}`}
                x={m.ts}
                stroke="var(--status-warning)"
                strokeDasharray="4 3"
                ifOverflow="extendDomain"
                label={{
                  value: scopeMarkLabel(m.scope),
                  position: 'insideTopLeft',
                  fill: 'var(--muted-foreground)',
                  fontSize: 10,
                }}
              />
            ))}
            {referenceArea}
          </AreaChart>
        </ChartContainer>
      )}
    </ZoomableAreaChart>
  )
}
