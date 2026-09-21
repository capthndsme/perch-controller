import { useMemo } from 'react'
import { Info } from '@phosphor-icons/react'
import { Area, CartesianGrid, ComposedChart, Line, LineChart, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { EmptyState } from '@/components/ui/empty-state'
import { Panel } from '@/components/ui/panel'
import { formatLastSeen } from '@/lib/collectors'
import { formatBytes, formatMbps } from '@/lib/format-bytes'
import { formatCompactCount, formatSampleAge, wanSourceHint } from '@/lib/gateway'
import { formatAxisTick, formatTooltipTimestamp } from '@/lib/time-window'
import { cn } from '@/lib/utils'
import type { RouterResponse, RouterSeriesBucket, RouterSource } from '@/types/api'

const connectionsConfig = {
  conntrackEntries: { label: 'Connections', color: 'var(--brand)' },
  conntrackMax: { label: 'Peak in bucket', color: 'var(--series-other)' },
} satisfies ChartConfig

const wanConfig = {
  wanRxMbps: { label: 'Download', color: 'var(--chart-download)' },
  wanTxMbps: { label: 'Upload', color: 'var(--chart-upload)' },
} satisfies ChartConfig

type GatewayPanelProps = {
  data: RouterResponse | undefined
  isPending: boolean
  isPlaceholderData?: boolean
  error: Error | null
}

/** Axis ticks: "80 Mbps", "2.5 Mbps", short enough not to wrap in the axis. */
function formatMbpsTick(value: number): string {
  if (!Number.isFinite(value)) return ''
  if (Math.abs(value) >= 10 || Number.isInteger(value)) return `${Math.round(value)} Mbps`
  return `${value.toFixed(1)} Mbps`
}

function spanOf(series: RouterSeriesBucket[]): number {
  if (series.length < 2) return 0
  return (series[series.length - 1].ts - series[0].ts) / 1000
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <p className="section-label">{label}</p>
      <p className="truncate font-mono text-sm tabular-nums text-foreground">{value}</p>
      {hint ? <p className="truncate text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

/** "Reported by gateway, the collector on your router · online". */
function SourceLine({ source }: { source: RouterSource }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span>
        Reported by <span className="font-medium text-foreground">{source.name}</span>, the collector on your router
      </span>
      <span aria-hidden>·</span>
      <span className="inline-flex items-center gap-1">
        <span
          aria-hidden
          className={cn('inline-block size-1.5 rounded-full', source.online ? 'bg-status-good' : 'bg-status-critical')}
        />
        {source.online ? 'online' : `offline, last report ${formatLastSeen(source.reportedAt)}`}
      </span>
    </span>
  )
}

/**
 * The edge router's own view: conntrack table fill (how many connections the
 * house holds open), the WAN rate from its interface counters, and a health
 * strip. Everything here is what the collector on the router reads from its
 * own kernel every 30 s, not from the LAN capture.
 */
export function GatewayPanel({ data, isPending, isPlaceholderData = false, error }: GatewayPanelProps) {
  const series = useMemo(() => data?.series ?? [], [data])
  const spanSeconds = useMemo(() => spanOf(series), [series])
  const latest = data?.latest ?? null
  const source = data?.source ?? null
  const memUsedPct =
    latest && latest.memTotal && latest.memAvailable !== null
      ? Math.round(((latest.memTotal - latest.memAvailable) / latest.memTotal) * 1000) / 10
      : null

  let body: React.ReactNode
  if (isPending && !data) {
    body = <p className="px-4 pb-4 text-xs text-muted-foreground">Loading gateway metrics…</p>
  } else if (error) {
    body = <p className="px-4 pb-4 text-xs text-destructive">{error.message}</p>
  } else if (!data || (!source && !latest)) {
    body = (
      <div className="px-4 pb-4">
        <EmptyState
          title="No collector on the router yet"
          description={
            <>
              Run Perch Network Collector on the router itself (OpenWrt package{' '}
              <code className="whitespace-nowrap font-mono">perch-collector</code>). Gateway stats are on by
              default there: connection tracking, the WAN rate and load show up here within 30 seconds of
              adopting it.
            </>
          }
        />
      </div>
    )
  } else if (!latest) {
    body = (
      <div className="px-4 pb-4">
        <EmptyState
          title="Waiting for the first gateway report"
          description="The collector on the router reports every 30 seconds; this fills in with its first report."
        />
      </div>
    )
  } else {
    body = (
      <div className="flex flex-col gap-4 px-4 pb-4">
        {!source ? (
          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <Info aria-hidden className="mt-px size-3.5 shrink-0" />
            No collector reports gateway stats right now, so this is recorded history. It resumes once
            the collector on the router reports again.
          </p>
        ) : null}
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="min-w-0 space-y-1">
            <div className="flex items-baseline justify-between gap-2">
              <p className="section-label">Connections</p>
              <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
                <span className="text-foreground">{latest.conntrackEntries?.toLocaleString() ?? '—'}</span>{' '}
                {source ? 'now' : 'at the last report'}
                {latest.conntrackLimit ? ` · limit ${latest.conntrackLimit.toLocaleString()}` : ''}
                {latest.conntrackPct !== null ? ` · ${latest.conntrackPct}%` : ''}
              </p>
            </div>
            {series.length > 1 ? (
              <ChartContainer config={connectionsConfig} className="h-40 w-full">
                <ComposedChart data={series} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--border)" />
                  <XAxis
                    dataKey="ts"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    scale="time"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={6}
                    minTickGap={48}
                    tickFormatter={(value: number) => formatAxisTick(value, spanSeconds)}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tickMargin={6}
                    width={44}
                    domain={[0, 'auto']}
                    tickFormatter={(value: number) => formatCompactCount(value)}
                  />
                  <ChartTooltip
                    cursor={{ stroke: 'var(--border)' }}
                    content={
                      <ChartTooltipContent
                        indicator="dot"
                        labelFormatter={(_, payload) => {
                          const ts = payload?.[0]?.payload?.ts
                          return typeof ts === 'number' ? formatTooltipTimestamp(ts) : ''
                        }}
                        formatter={(value, name) => (
                          <div className="flex w-full items-center justify-between gap-3">
                            <span className="text-muted-foreground">
                              {connectionsConfig[name as keyof typeof connectionsConfig]?.label ?? String(name)}
                            </span>
                            <span className="font-mono text-foreground">
                              {value === null || value === undefined ? '—' : Math.round(Number(value)).toLocaleString()}
                            </span>
                          </div>
                        )}
                      />
                    }
                  />
                  <Area
                    isAnimationActive={false}
                    dataKey="conntrackEntries"
                    type="monotone"
                    fill="var(--color-conntrackEntries)"
                    fillOpacity={0.16}
                    stroke="var(--color-conntrackEntries)"
                    strokeWidth={1.5}
                    connectNulls
                  />
                  <Line
                    isAnimationActive={false}
                    dataKey="conntrackMax"
                    type="monotone"
                    stroke="var(--color-conntrackMax)"
                    strokeWidth={1}
                    dot={false}
                    connectNulls
                  />
                </ComposedChart>
              </ChartContainer>
            ) : (
              <p className="text-[11px] text-muted-foreground">Not enough samples in this window for a chart yet.</p>
            )}
          </section>

          <section className="min-w-0 space-y-1">
            <div className="flex items-baseline justify-between gap-2">
              <p className="section-label">WAN as the router sees it</p>
              <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
                <span className="text-chart-download">↓</span>{' '}
                {latest.wanRxMbps === null ? '—' : formatMbps(latest.wanRxMbps)}{' '}
                <span className="text-chart-upload">↑</span>{' '}
                {latest.wanTxMbps === null ? '—' : formatMbps(latest.wanTxMbps)}
              </p>
            </div>
            {series.length > 1 ? (
              <ChartContainer config={wanConfig} className="h-40 w-full">
                <LineChart data={series} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--border)" />
                  <XAxis
                    dataKey="ts"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    scale="time"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={6}
                    minTickGap={48}
                    tickFormatter={(value: number) => formatAxisTick(value, spanSeconds)}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tickMargin={6}
                    width={68}
                    domain={[0, 'auto']}
                    tickFormatter={formatMbpsTick}
                  />
                  <ChartTooltip
                    cursor={{ stroke: 'var(--border)' }}
                    content={
                      <ChartTooltipContent
                        indicator="dot"
                        labelFormatter={(_, payload) => {
                          const ts = payload?.[0]?.payload?.ts
                          return typeof ts === 'number' ? formatTooltipTimestamp(ts) : ''
                        }}
                        formatter={(value, name) => (
                          <div className="flex w-full items-center justify-between gap-3">
                            <span className="text-muted-foreground">
                              {wanConfig[name as keyof typeof wanConfig]?.label ?? String(name)}
                            </span>
                            <span className="font-mono text-foreground">
                              {value === null || value === undefined ? '—' : formatMbps(Number(value))}
                            </span>
                          </div>
                        )}
                      />
                    }
                  />
                  <Line
                    isAnimationActive={false}
                    dataKey="wanRxMbps"
                    type="monotone"
                    stroke="var(--color-wanRxMbps)"
                    strokeWidth={1.5}
                    dot={false}
                    connectNulls
                  />
                  <Line
                    isAnimationActive={false}
                    dataKey="wanTxMbps"
                    type="monotone"
                    stroke="var(--color-wanTxMbps)"
                    strokeWidth={1.5}
                    dot={false}
                    connectNulls
                  />
                </LineChart>
              </ChartContainer>
            ) : (
              <p className="text-[11px] text-muted-foreground">Rates appear once two samples are in the window.</p>
            )}
          </section>
        </div>

        <div className="grid grid-cols-2 gap-3 border-t border-border/60 pt-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Load (1 m)" value={latest.load1 === null ? '—' : latest.load1.toFixed(2)} />
          <Stat
            label="Established TCP"
            value={latest.tcpEstablished === null ? '—' : latest.tcpEstablished.toLocaleString()}
            hint="the router's own sockets"
          />
          <Stat
            label="Memory used"
            value={memUsedPct === null ? '—' : `${memUsedPct}%`}
            hint={
              latest.memTotal && latest.memAvailable !== null
                ? `${formatBytes(latest.memTotal - latest.memAvailable)} of ${formatBytes(latest.memTotal)}`
                : undefined
            }
          />
          <Stat
            label="Conntrack"
            value={`${formatCompactCount(latest.conntrackEntries)} / ${formatCompactCount(latest.conntrackLimit)}`}
            hint={latest.conntrackPct !== null ? `${latest.conntrackPct}% of the table` : undefined}
          />
          <Stat
            label="WAN interfaces"
            value={(data.wanIfaces.length ? data.wanIfaces : latest.wanIfaces).join(', ') || '—'}
            hint={wanSourceHint(source?.wanSource)}
          />
          <Stat label="Sample" value={`updated ${formatSampleAge(latest.ageSeconds)}`} hint="reported every 30 s" />
        </div>
      </div>
    )
  }

  return (
    <Panel
      title="Gateway"
      description={
        source ? (
          <SourceLine source={source} />
        ) : (
          'As the edge router sees it: connection tracking, WAN rate and load.'
        )
      }
      updating={isPlaceholderData}
      flush
    >
      {body}
    </Panel>
  )
}
