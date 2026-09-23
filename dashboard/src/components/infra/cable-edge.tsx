import { memo, type CSSProperties } from 'react'
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, Position, type Edge, type EdgeProps } from '@xyflow/react'
import { Warning } from '@phosphor-icons/react'
import { useInfraView } from '@/components/infra/infra-context'
import { formatPortSpeed, linkStateText, PORT_HEIGHT, portAnchorShift, type LayoutIndex } from '@/lib/infra'
import { cn } from '@/lib/utils'
import type { InfraLinkMedium, InfraLinkStateValue } from '@/types/api'

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
  const text = speed ?? link?.label ?? null
  const title = [linkStateText(linkState), link?.label].filter(Boolean).join(' · ')

  return (
    <>
      <BaseEdge id={id} path={path} style={cableStyle(medium, value, Boolean(selected))} interactionWidth={18} />
      {text || mismatch ? (
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
