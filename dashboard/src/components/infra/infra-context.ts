import { createContext, useContext } from 'react'
import type { LayoutIndex, StateIndex } from '@/lib/infra'

/**
 * What every node and cable on the map reads besides its own layout row: the
 * live state (joined in by id, so a 5 s state poll re-renders the boxes without
 * rebuilding React Flow's node array) and the canvas callbacks.
 */
export type InfraView = {
  index: LayoutIndex
  state: StateIndex
  editing: boolean
  /** A port picked in the inspector or on the map, drawn with a ring. */
  focusedPortId: number | null
  onPortClick: (nodeId: number, portId: number) => void
  onPortHover: (portId: number | null, anchor?: DOMRect) => void
  onCableLabelClick: (linkId: number) => void
  /** "Add ports" on an old agent's box. */
  onAddPorts: (nodeId: number) => void
  /** "Connect a device…" on a free port (edit mode, A4). */
  onConnectDevice: (nodeId: number, portId: number) => void
  onFrameResizeStart: () => void
  onFrameResizeEnd: (nodeId: number, frame: { x: number; y: number; width: number; height: number }) => void
}

export const InfraViewContext = createContext<InfraView | null>(null)

export function useInfraView(): InfraView {
  const view = useContext(InfraViewContext)
  if (!view) throw new Error('useInfraView() needs an InfraViewContext provider')
  return view
}

/**
 * What the Wi-Fi overlay's chips read. Its own context, so a 5 s state poll,
 * which changes `InfraView`, does not re-render the chips.
 */
export type InfraOverlayView = {
  /** The chip whose details are open, if any. */
  selectedChipId: string | null
  onClientClick: (mac: string) => void
  onMoreClick: (apNodeId: number) => void
}

export const InfraOverlayContext = createContext<InfraOverlayView | null>(null)

export function useInfraOverlay(): InfraOverlayView {
  const view = useContext(InfraOverlayContext)
  if (!view) throw new Error('useInfraOverlay() needs an InfraOverlayContext provider')
  return view
}
