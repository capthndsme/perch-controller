import { memo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Position,
  useStore,
  type Edge,
  type EdgeProps,
  type ReactFlowState,
} from '@xyflow/react'
import { Warning } from '@phosphor-icons/react'
import { useInfraView } from '@/components/infra/infra-context'
import { usePlaybackRate } from '@/components/infra/use-playback-rate'
import { formatPortSpeed, linkStateText, PORT_HEIGHT, portAnchorShift, type LayoutIndex } from '@/lib/infra'
import {
  FLOW_LAP_SECONDS,
  formatTrafficRate,
  linkTrafficText,
  nextCableFlow,
  strokeWidthForStep,
} from '@/lib/infra-traffic'
import { cn } from '@/lib/utils'
import type { InfraLink, InfraLinkMedium, InfraLinkStateValue } from '@/types/api'

export type CableEdgeData = {
  linkId: number
}

export type CableFlowEdge = Edge<CableEdgeData, 'cable'>

/**
 * §8.4: Ethernet solid, fiber solid in a warmer stroke, virtual dotted,
 * wireless dashed and animated (React Flow's `animated` edge class); up is the
 * foreground colour, down muted, unknown muted and dotted, a mismatch red.
 */
function cableStyle(medium: InfraLinkMedium, state: InfraLinkStateValue, selected: boolean): CSSProperties {
  let stroke = 'var(--muted-foreground)'
  let opacity = 0.6
  if (state === 'mismatch') {
    stroke = 'var(--status-critical)'
    opacity = 1
  } else if (state === 'up') {
    stroke = medium === 'fiber' ? 'var(--series-4)' : 'var(--foreground)'
    opacity = medium === 'fiber' ? 1 : 0.72
  } else if (medium === 'fiber') {
    stroke = 'var(--series-4)'
    opacity = 0.45
  }
  let dash: string | undefined
  if (medium !== 'wireless' && (medium === 'virtual' || state === 'unknown')) dash = '2 5'
  return {
    stroke: selected ? 'var(--brand)' : stroke,
    strokeOpacity: selected ? 1 : opacity,
    strokeWidth: selected ? 3 : state === 'mismatch' ? 2.5 : 2,
    strokeDasharray: dash,
    strokeLinecap: dash ? 'round' : undefined,
  }
}

type CableEnd = { x: number; y: number; position: Position }

/**
 * How long the dots take to change speed or turn round. They run all the time
 * the map is open and are never the answer to a tap, so the change is eased
 * like something with mass rather than snapped (a tenth of the 5 s poll).
 */
const FLOW_RAMP_MS = 600

/**
 * The dots that run along a busy cable (infra-traffic.css). One lap of the
 * keyframe per second at playback rate 1; the speed step and direction set the
 * rate, so a new reading never restarts or jumps the dots.
 */
function FlowPath({
  path,
  speed,
  reverse,
  stroke,
  strokeOpacity,
  strokeWidth,
}: {
  path: string
  speed: number
  reverse: boolean
  stroke: string
  strokeOpacity: number
  strokeWidth: number
}) {
  const ref = useRef<SVGPathElement>(null)
  // The dots run from the path's start (end a) to its end; backwards for b → a.
  usePlaybackRate(ref, (reverse ? -1 : 1) / FLOW_LAP_SECONDS[speed], FLOW_RAMP_MS)
  return (
    <path
      ref={ref}
      d={path}
      className="infra-cable-flow"
      data-flow={reverse ? 'b-to-a' : 'a-to-b'}
      data-flow-step={speed}
      style={{ stroke, strokeOpacity, strokeWidth }}
    />
  )
}

/** Below this zoom a cable shows its speed only: rate chips would crowd the map. */
const RATE_CHIP_MIN_ZOOM = 0.22
/** The zoom in steps of 0.05, so a pinch re-renders the cables a few times, not every frame. */
const quantizedZoom = (state: ReactFlowState) => Math.round(state.transform[2] * 20) / 20

/**
 * Where a cable's rate chip goes: right outside the port at the end whose box
 * has fewer cables (a switch fanning out to four devices gets one chip above
 * each device, not four crowding its ports), the lower end on a tie.
 */
function rateChipEnd(
  index: LayoutIndex,
  link: InfraLink,
  from: CableEnd,
  to: CableEnd,
): { side: 'a' | 'b'; end: CableEnd } {
  const cables = (nodeId: number) => {
    let count = 0
    for (const other of index.links.values()) {
      if (other.a.nodeId === nodeId || other.b.nodeId === nodeId) count += 1
    }
    return count
  }
  const ca = cables(link.a.nodeId)
  const cb = cables(link.b.nodeId)
  // The edge's source is end a, its target end b (infra-canvas.tsx).
  if (ca !== cb) return ca < cb ? { side: 'a', end: from } : { side: 'b', end: to }
  return from.y > to.y ? { side: 'a', end: from } : { side: 'b', end: to }
}

/**
 * Where a cable leaves its box. The handle is the whole socket, so its top and
 * bottom are known; the cable leaves through the box's top edge when the other
 * end is above the port (an uplink) and through the bottom edge otherwise, right
 * above or below the port, instead of ending out of sight behind the box.
 */
function cableEnd(
  index: LayoutIndex,
  handleId: string | null | undefined,
  x: number,
  y: number,
  position: Position,
  otherY: number,
): CableEnd {
  const portId = Number(handleId)
  if (!handleId || !Number.isInteger(portId)) return { x, y, position }
  const socketTop = position === Position.Top ? y : y - PORT_HEIGHT
  const socketBottom = socketTop + PORT_HEIGHT
  if (otherY < socketTop - PORT_HEIGHT) {
    return { x, y: socketTop - portAnchorShift(index, portId, 'top'), position: Position.Top }
  }
  return { x, y: socketBottom + portAnchorShift(index, portId, 'bottom'), position: Position.Bottom }
}

function CableEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
  sourceHandleId,
  targetHandleId,
}: EdgeProps<CableFlowEdge>) {
  const view = useInfraView()
  const linkId = data?.linkId ?? -1
  const link = view.index.links.get(linkId)
  const linkState = view.state.links.get(linkId)
  const from = cableEnd(view.index, sourceHandleId, sourceX, sourceY, sourcePosition, targetY)
  const to = cableEnd(view.index, targetHandleId, targetX, targetY, targetPosition, sourceY)
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: from.x,
    sourceY: from.y,
    sourcePosition: from.position,
    targetX: to.x,
    targetY: to.y,
    targetPosition: to.position,
    borderRadius: 10,
    offset: 18,
  })
  const value = linkState?.state ?? 'unknown'
  const medium = link?.medium ?? 'ethernet'
  const mismatch = value === 'mismatch'
  const speed = formatPortSpeed(linkState?.speedMbps)
  // Rate chips keep about their size on screen when the map is zoomed out (up to 2.2×), and go at a far zoom.
  const zoom = useStore(quantizedZoom)
  // A6.5: the cable's rate, when the "Traffic" toggle is on and an end measures it.
  const traffic = view.showTraffic ? (linkState?.traffic ?? null) : null
  // Whether the dots run, which way, how fast and how thick the cable is, from
  // this reading and the last state (lib/infra-traffic.ts: steps with
  // hysteresis). Kept in state, so the edge (kept across polls) remembers it.
  const [cableFlow, setCableFlow] = useState(() => nextCableFlow(traffic, null))
  const flowNow = nextCableFlow(traffic, cableFlow)
  if (flowNow !== cableFlow) setCableFlow(flowNow)
  const style = cableStyle(medium, value, Boolean(selected))
  if (traffic) {
    style.strokeWidth = Math.max(Number(style.strokeWidth), strokeWidthForStep(flowNow.width))
    if (flowNow.moving && value !== 'down') style.strokeOpacity = Math.max(Number(style.strokeOpacity), 0.8)
  }
  // On a wireless cable React Flow already animates the stroke.
  const flow = Boolean(traffic) && flowNow.moving && medium !== 'wireless' && value !== 'down'
  const chipEnd = link && traffic && !mismatch && zoom >= RATE_CHIP_MIN_ZOOM ? rateChipEnd(view.index, link, from, to) : null
  const text = speed ?? link?.label ?? null
  const title = [
    linkStateText(linkState),
    link?.label,
    traffic && link ? linkTrafficText(view.index, link, traffic) : null,
  ]
    .filter(Boolean)
    .join(' · ')

  let chip: ReactNode = null
  if (chipEnd && traffic) {
    // ↓ is what flows into the chip's end (towards the box it sits on when that box is below).
    const intoChipEnd = chipEnd.side === 'a' ? traffic.bToABps : traffic.aToBBps
    const outOfChipEnd = chipEnd.side === 'a' ? traffic.aToBBps : traffic.bToABps
    const above = chipEnd.end.position === Position.Top
    const down = above ? intoChipEnd : outOfChipEnd
    const up = above ? outOfChipEnd : intoChipEnd
    const scale = Math.min(2.2, Math.max(1, 0.9 / zoom))
    chip = (
      // Anchored on the cable right outside the port (follows a dragged box at
      // once); the chip inside is scaled around that point, and eases between the
      // zoom steps instead of jumping at each one during a pinch.
      <div
        className="absolute"
        style={{
          transform: above
            ? `translate(${chipEnd.end.x}px, ${chipEnd.end.y - 5}px) translate(-50%, -100%)`
            : `translate(${chipEnd.end.x}px, ${chipEnd.end.y + 5}px) translate(-50%, 0)`,
        }}
      >
        <button
          type="button"
          data-link-id={linkId}
          data-traffic=""
          title={title}
          onClick={() => view.onCableLabelClick(linkId)}
          className={cn(
            // min-w: a rate that gains a digit does not move the centred chip's edges every poll.
            'nodrag nopan pointer-events-auto flex min-w-[11ch] flex-col items-start rounded-sm border bg-card/95 px-1 py-px font-mono text-[10px] leading-[13px] whitespace-nowrap text-foreground shadow-sm',
            'transition-transform duration-fast ease-out motion-reduce:transition-none',
            traffic.partial ? 'border-status-warning/50' : 'border-border',
            selected && 'border-brand',
          )}
          style={{ transform: `scale(${scale})`, transformOrigin: above ? '50% 100%' : '50% 0' }}
        >
          {text || traffic.partial ? (
            <span className="flex items-center gap-1 text-[9px] text-muted-foreground">
              {text}
              {traffic.partial ? (
                <span className="rounded-[2px] bg-status-warning/15 px-0.5 font-sans font-semibold text-status-warning">
                  CPU only
                </span>
              ) : null}
            </span>
          ) : null}
          <span className="tabular-nums">↓ {formatTrafficRate(down)}</span>
          <span className="tabular-nums">↑ {formatTrafficRate(up)}</span>
        </button>
      </div>
    )
  }

  return (
    <>
      <BaseEdge id={id} path={path} style={style} className="infra-cable" interactionWidth={18} />
      {flow && traffic ? (
        <FlowPath
          path={path}
          speed={flowNow.speed}
          reverse={flowNow.reverse}
          stroke={selected ? 'var(--card)' : 'var(--brand)'}
          strokeOpacity={traffic.partial ? 0.55 : 0.9}
          strokeWidth={Number(style.strokeWidth)}
        />
      ) : null}
      {chip ? (
        <EdgeLabelRenderer>{chip}</EdgeLabelRenderer>
      ) : text || mismatch ? (
        <EdgeLabelRenderer>
          <button
            type="button"
            data-link-id={linkId}
            title={title}
            onClick={() => view.onCableLabelClick(linkId)}
            className={cn(
              'nodrag nopan pointer-events-auto absolute flex items-center gap-1 rounded-sm border bg-card px-1 font-mono text-[10px] leading-4 shadow-sm',
              mismatch
                ? 'border-status-critical/60 font-sans font-semibold text-status-critical'
                : 'border-border text-foreground',
              selected && 'border-brand',
            )}
            // A mismatch badge must never hide behind a box; plain labels may.
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              zIndex: mismatch ? 5 : undefined,
            }}
          >
            {mismatch ? (
              <>
                <Warning aria-hidden weight="fill" className="size-3" />
                {linkState?.detail === 'speed' ? 'Speed mismatch' : 'Carrier mismatch'}
              </>
            ) : (
              text
            )}
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

export const CableEdge = memo(CableEdgeComponent)
