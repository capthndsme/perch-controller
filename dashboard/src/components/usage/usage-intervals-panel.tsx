import { useMemo, useState } from 'react'
import { EmptyState } from '@/components/ui/empty-state'
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import { UsageColumnChart, type UsageColumnPoint } from '@/components/usage/usage-bar-chart'
import { useUsageIntervals } from '@/hooks/use-usage'
import { formatAxisTick, type TimeWindow } from '@/lib/time-window'
import { slotTitle, USAGE_INTERVAL_OPTIONS } from '@/lib/usage'
import type { UsageInterval, UsageIntervalRequest, UsageScope } from '@/types/api'

type UsageIntervalsPanelProps = {
  window: TimeWindow
  scope: UsageScope
}

/**
 * The sub-day view under the daily chart: one column per 1 h / 4 h / 8 h /
 * 12 h slot aligned to local midnight. Auto follows the window (1 h up to a
 * week, then coarser) and shows the interval it resolved to.
 */
export function UsageIntervalsPanel({ window, scope }: UsageIntervalsPanelProps) {
  const [interval, setInterval] = useState<UsageIntervalRequest>('auto')
  const intervals = useUsageIntervals({ window, scope, interval })
  const data = intervals.data
  const effective: UsageInterval | null = data?.interval ?? null

  const options = useMemo(
    () =>
      USAGE_INTERVAL_OPTIONS.map((o) =>
        o.id === 'auto' && effective ? { ...o, label: `Auto · ${effective}` } : o,
      ),
    [effective],
  )

  const points = useMemo<UsageColumnPoint[]>(() => {
    const buckets = data?.buckets ?? []
    if (buckets.length === 0) return []
    const first = Date.parse(buckets[0].bucketStart)
    const last = Date.parse(buckets[buckets.length - 1].bucketStart)
    const spanSeconds = Math.max(0, (last - first) / 1000)
    // A relative window ends now, so its partial slot is the running one; an
    // absolute window's partial slot was cut by `to`.
    const running = window.kind === 'relative'
    return buckets.map((b) => {
      const start = Date.parse(b.bucketStart)
      const end = Date.parse(b.bucketEnd)
      return {
        key: b.bucketStart,
        tick: formatAxisTick(start, spanSeconds),
        title: slotTitle(start, end),
        hint: b.partial ? (running ? 'so far' : 'partial') : null,
        partial: b.partial,
        bytesIn: b.bytesIn,
        bytesOut: b.bytesOut,
        totalBytes: b.totalBytes,
        avgMbps: b.avgMbps,
        activeDevices: b.activeDevices,
      }
    })
  }, [data, window.kind])
  const hasData = points.some((p) => p.totalBytes > 0)

  return (
    <Panel
      title="Hourly breakdown"
      description={
        data
          ? `One column per ${data.interval} slot, aligned to local midnight (${data.timezone}). Download at the baseline, upload on top; lines show the average rate and active devices.`
          : 'Sub-day slots aligned to local midnight.'
      }
      updating={intervals.isPlaceholderData}
      actions={
        <Segmented value={interval} onChange={setInterval} options={options} ariaLabel="Slot length" size="xs" />
      }
    >
      {intervals.isPending && !data ? (
        <p className="text-xs text-muted-foreground">Loading breakdown…</p>
      ) : intervals.error ? (
        <p className="text-xs text-destructive">{intervals.error.message}</p>
      ) : hasData ? (
        <UsageColumnChart
          points={points}
          className="h-[220px] w-full"
          maxBarSize={points.length > 60 ? 10 : 18}
          minTickGap={40}
          overlay={data ? { slotSeconds: data.intervalSeconds } : undefined}
        />
      ) : (
        <EmptyState
          title="No usage in this window"
          description="The breakdown is built from the hourly rollups; it fills in as the collector runs."
        />
      )}
    </Panel>
  )
}
