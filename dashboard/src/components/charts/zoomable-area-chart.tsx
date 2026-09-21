import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { ReferenceArea } from 'recharts'
import { ArrowsClockwise } from '@phosphor-icons/react'

/**
 * Recharts v3 hands every mouse handler this object (not the legacy
 * `CategoricalChartState`). We re-declare the slice we care about so
 * the wrapper component doesn't drag the whole synchronisation type
 * into its public API.
 */
type MouseHandlerState = {
  activeLabel?: string | number | null
  isTooltipActive?: boolean
}
import { Button } from '@/components/ui/button'
import { absoluteWindow, type TimeWindow } from '@/lib/time-window'
import { cn } from '@/lib/utils'

type ZoomState = { start: number | null; end: number | null }

type ZoomableAreaChartProps = {
  /**
   * Render-prop the parent uses to inject Recharts series, axes, etc.
   * The injected props supply mouse handlers and (when an active drag is
   * in progress) a `<ReferenceArea>` overlay marking the selected
   * window. The parent attaches all chart pieces inside the returned
   * `<ChartContainer><AreaChart>` block.
   */
  children: (chartProps: {
    onMouseDown: (state: MouseHandlerState) => void
    onMouseMove: (state: MouseHandlerState) => void
    onMouseUp: () => void
    onMouseLeave: () => void
    referenceArea: ReactNode
  }) => ReactNode
  /**
   * Fired with `[from, to]` epoch-ms after the user releases a drag
   * covering more than `minDragMs`. Triggers a zoom-in by swapping the
   * parent dashboard's `TimeWindow` to absolute.
   */
  onZoom?: (window: TimeWindow) => void
  /**
   * Minimum drag distance to count as a zoom (vs. a click). 1 second
   * is enough to dismiss accidental click-drags without making slow
   * drags feel unresponsive.
   */
  minDragMs?: number
  /** Shown over the chart while a drag is in progress. */
  className?: string
  /** Optional reset-zoom button overlay; clicked when the user wants
   * to break out of an absolute window back to a relative one. */
  onResetZoom?: () => void
  canResetZoom?: boolean
}

/**
 * Generic wrapper that adds Grafana-style drag-to-zoom on top of any
 * Recharts `<AreaChart>`. The actual chart is rendered by `children`
 * — this component only manages drag state, draws the selection
 * `<ReferenceArea>`, and translates the released drag into an
 * `[from, to]` absolute window that the parent forwards into its
 * `TimeWindow` state.
 */
export function ZoomableAreaChart({
  children,
  onZoom,
  minDragMs = 1000,
  className,
  onResetZoom,
  canResetZoom,
}: ZoomableAreaChartProps) {
  const [drag, setDrag] = useState<ZoomState>({ start: null, end: null })
  // Stored separately from state so the handlers don't have to close
  // over a re-rendered value; we only care about the start when
  // mouseUp fires.
  const dragRef = useRef<ZoomState>({ start: null, end: null })

  const updateDrag = useCallback((next: ZoomState) => {
    dragRef.current = next
    setDrag(next)
  }, [])

  const handleMouseDown = useCallback(
    (state: MouseHandlerState) => {
      const ts = extractTs(state)
      if (ts == null) return
      updateDrag({ start: ts, end: ts })
    },
    [updateDrag],
  )

  const handleMouseMove = useCallback(
    (state: MouseHandlerState) => {
      if (dragRef.current.start == null) return
      const ts = extractTs(state)
      if (ts == null) return
      updateDrag({ start: dragRef.current.start, end: ts })
    },
    [updateDrag],
  )

  const finishDrag = useCallback(() => {
    const { start, end } = dragRef.current
    updateDrag({ start: null, end: null })
    if (start == null || end == null || !onZoom) return
    const [from, to] = start <= end ? [start, end] : [end, start]
    if (to - from < minDragMs) return
    onZoom(absoluteWindow(from, to))
  }, [onZoom, minDragMs, updateDrag])

  const handleMouseUp = useCallback(() => {
    finishDrag()
  }, [finishDrag])

  const handleMouseLeave = useCallback(() => {
    // Cancel — don't commit a partial drag if the cursor leaves the chart.
    updateDrag({ start: null, end: null })
  }, [updateDrag])

  const referenceArea = useMemo(() => {
    if (drag.start == null || drag.end == null || drag.start === drag.end) return null
    return (
      <ReferenceArea
        x1={Math.min(drag.start, drag.end)}
        x2={Math.max(drag.start, drag.end)}
        strokeOpacity={0.4}
        stroke="var(--ring)"
        fill="var(--ring)"
        fillOpacity={0.12}
        ifOverflow="visible"
      />
    )
  }, [drag])

  return (
    <div className={cn('relative', className)}>
      {/* The handlers close over `dragRef`; they are only *called* from Recharts
          events, never during render — the compiler rule cannot see that. */}
      {/* eslint-disable-next-line react-hooks/refs */}
      {children({
        onMouseDown: handleMouseDown,
        onMouseMove: handleMouseMove,
        onMouseUp: handleMouseUp,
        onMouseLeave: handleMouseLeave,
        referenceArea,
      })}
      {canResetZoom ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="absolute right-2 top-2 z-10 h-7 gap-1.5 px-2 text-[11px]"
          onClick={onResetZoom}
          title="Reset zoom"
        >
          <ArrowsClockwise className="size-3" />
          Reset zoom
        </Button>
      ) : null}
    </div>
  )
}

/**
 * Pull the active X value out of Recharts' chart-state callback.
 * Recharts exposes the value of the X-axis dataKey at the active
 * cursor position as `state.activeLabel`; when the axis is numeric
 * (our `ts` field) that's an epoch-ms number we can use directly.
 */
function extractTs(state: MouseHandlerState | null | undefined): number | null {
  if (!state) return null
  const value = state.activeLabel
  if (value == null) return null
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : null
}
