import { memo } from 'react'
import { BaseEdge, useInternalNode, type Edge, type EdgeProps, type InternalNode } from '@xyflow/react'
import { borderPoint, signalStroke, type Rect } from '@/lib/infra-overlay'
import type { WifiSignalQuality } from '@/types/api'

export type WifiEdgeData = {
  quality: WifiSignalQuality | null
  variant: 'client' | 'more'
}

export type WifiFlowEdge = Edge<WifiEdgeData, 'wifi'>

function rectOf(node: InternalNode): Rect {
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    width: node.measured.width ?? node.width ?? 0,
    height: node.measured.height ?? node.height ?? 0,
  }
}

/**
 * A wireless line of the overlay (A4.4): dashed, coloured by the client's
 * signal quality, straight from the AP's box edge to the client's (a chip, or
 * its own box when it is on the map). It follows the boxes while one is being
 * dragged, and takes no clicks.
 */
function WifiEdgeComponent({ id, source, target, data }: EdgeProps<WifiFlowEdge>) {
  const from = useInternalNode(source)
  const to = useInternalNode(target)
  if (!from || !to) return null
  const a = rectOf(from)
  const b = rectOf(to)
  const start = borderPoint(a, { x: b.x + b.width / 2, y: b.y + b.height / 2 })
  const end = borderPoint(b, { x: a.x + a.width / 2, y: a.y + a.height / 2 })
  const more = data?.variant === 'more'
  return (
    <BaseEdge
      id={id}
      path={`M ${start.x},${start.y} L ${end.x},${end.y}`}
      interactionWidth={0}
      style={{
        stroke: signalStroke(data?.quality),
        strokeOpacity: more ? 0.55 : 0.95,
        strokeWidth: more ? 1.25 : 1.75,
        strokeDasharray: '5 4',
        strokeLinecap: 'round',
      }}
    />
  )
}

export const WifiEdge = memo(WifiEdgeComponent)
