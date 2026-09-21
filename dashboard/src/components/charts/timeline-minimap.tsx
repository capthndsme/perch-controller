import { useEffect, useMemo, useRef, useState } from 'react'
import { Area, AreaChart, Brush, YAxis } from 'recharts'
import { ChartContainer, type ChartConfig } from '@/components/ui/chart'
import type { BandwidthPoint } from '@/components/charts/bandwidth-chart'
import { downsampleTimeSeries } from '@/lib/traffic'
import {
  absoluteWindow,
  formatAxisTick,
  windowSpanSeconds,
  type TimeWindow,
} from '@/lib/time-window'

type MiniPoint = { ts: number; total: number }

const config = {
  total: { label: 'Mbps', color: 'var(--brand)' },
} satisfies ChartConfig

type TimelineMinimapProps = {
  /** Wide context series (e.g. last 90d) the brush selects within. */
  data: BandwidthPoint[]
  /** Current detail window — positions the brush travellers. */
  window: TimeWindow
  /** Fires once per drag gesture with the brushed absolute range. */
  onSelect: (window: TimeWindow) => void
  className?: string
}

/**
 * Grafana-style overview+detail strip. Shows a wide, fast context query as
 * a sparkline with a draggable brush; the brush selection drives the main
 * chart's window. The wide query is cheap now (hourly rollup), which is the
 * whole reason this is feasible. The brush commits once on gesture-end (not
 * on every onChange tick) so dragging doesn't spam refetches or history.
 */
export function TimelineMinimap({ data, window, onSelect, className }: TimelineMinimapProps) {
  const points = useMemo<MiniPoint[]>(() => {
    const mapped = data.map((p) => ({ ts: p.ts, total: p.download + p.upload }))
    return downsampleTimeSeries(mapped, 500, (p) => p.total)
  }, [data])

  const spanSeconds = useMemo(
    () => (points.length < 2 ? 0 : (points[points.length - 1].ts - points[0].ts) / 1000),
    [points],
  )

  // Current detail window → brush traveller indices.
  const selection = useMemo(() => {
    if (points.length === 0) return null
    // For a relative window, "now" is the right edge of the context data
    // (which ends at the latest bucket) — pure, and aligns the brush to the
    // real data end instead of wall-clock.
    const now = points[points.length - 1].ts
    const span = windowSpanSeconds(window) * 1000
    const fromTs = window.kind === 'absolute' ? Date.parse(window.from) : now - span
    const toTs = window.kind === 'absolute' ? Date.parse(window.to) : now
    return { start: nearestIndex(points, fromTs), end: nearestIndex(points, toTs) }
  }, [points, window])

  const [pending, setPending] = useState<{ start: number; end: number } | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  // Synchronous mirror of `isDragging` for the onChange gate below — set the
  // instant the pointer goes down, before React re-renders. Recharts' <Brush>
  // also fires onChange when its startIndex/endIndex props change — which
  // happens every refresh tick as the live context query refetches and
  // `selection` recomputes. Without this gate those spurious onChange ticks
  // would seed `pending` and "commit" a window the user never dragged.
  const draggingRef = useRef(false)

  const startIndex = pending?.start ?? selection?.start ?? 0
  const endIndex = pending?.end ?? selection?.end ?? Math.max(0, points.length - 1)

  function beginDrag() {
    draggingRef.current = true
    setIsDragging(true)
  }

  // Commit on the *window's* pointer-release, not the strip's — so dragging a
  // traveller off the track (and releasing anywhere) still applies the zoom
  // once, instead of the old onMouseLeave detaching the gesture mid-drag.
  // Re-subscribes as `pending` updates so the handler always sees the final
  // brush position.
  useEffect(() => {
    if (!isDragging) return
    function endDrag() {
      draggingRef.current = false
      setIsDragging(false)
      setPending(null)
      if (!pending) return
      const changed =
        !selection || pending.start !== selection.start || pending.end !== selection.end
      const from = points[pending.start]?.ts
      const to = points[pending.end]?.ts
      if (!changed || from == null || to == null || to <= from) return
      onSelect(absoluteWindow(from, to))
    }
    // `globalThis`, not `window` — the `window` prop (a TimeWindow) shadows
    // the DOM global in this component's scope.
    globalThis.addEventListener('mouseup', endDrag)
    globalThis.addEventListener('touchend', endDrag)
    return () => {
      globalThis.removeEventListener('mouseup', endDrag)
      globalThis.removeEventListener('touchend', endDrag)
    }
  }, [isDragging, pending, selection, points, onSelect])

  if (points.length < 2) return null

  return (
    <div
      className={className}
      onMouseDown={beginDrag}
      onTouchStart={beginDrag}
    >
      <ChartContainer config={config} className="h-full w-full">
        <AreaChart data={points} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <YAxis hide domain={[0, 'auto']} />
          <Area
            isAnimationActive={false}
            dataKey="total"
            type="monotone"
            fill="var(--color-total)"
            fillOpacity={0.18}
            stroke="var(--color-total)"
            strokeWidth={1}
          />
          <Brush
            dataKey="ts"
            height={20}
            travellerWidth={8}
            gap={1}
            stroke="var(--color-total)"
            startIndex={startIndex}
            endIndex={endIndex}
            onChange={(range) => {
              // Ignore onChange unless a real drag is underway — otherwise a
              // refresh tick that shifts the controlled indices would register
              // as a pending selection.
              if (!draggingRef.current) return
              if (
                typeof range.startIndex === 'number' &&
                typeof range.endIndex === 'number'
              ) {
                setPending({ start: range.startIndex, end: range.endIndex })
              }
            }}
            tickFormatter={(ts: number) => formatAxisTick(Number(ts), spanSeconds)}
          />
        </AreaChart>
      </ChartContainer>
    </div>
  )
}

/** Index of the point whose `ts` is closest to a target (points sorted asc). */
function nearestIndex(points: MiniPoint[], ts: number): number {
  let lo = 0
  let hi = points.length - 1
  if (ts <= points[lo].ts) return lo
  if (ts >= points[hi].ts) return hi
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (points[mid].ts < ts) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(points[lo - 1].ts - ts) <= Math.abs(points[lo].ts - ts)) {
    return lo - 1
  }
  return lo
}
