import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type EdgeTypes,
  type NodeChange,
  type NodeTypes,
  type OnBeforeDelete,
} from '@xyflow/react'
import { CableEdge, type CableFlowEdge } from '@/components/infra/cable-edge'
import { ClientNode, type ClientFlowNode } from '@/components/infra/client-node'
import { DeviceNode, type DeviceFlowNode } from '@/components/infra/device-node'
import { HostNode, type HostFlowNode } from '@/components/infra/host-node'
import {
  InfraOverlayContext,
  InfraViewContext,
  type InfraOverlayView,
  type InfraView,
} from '@/components/infra/infra-context'
import { PortTooltip } from '@/components/infra/port-strip'
import { WifiEdge, type WifiFlowEdge } from '@/components/infra/wifi-edge'
import {
  useCreateInfraLink,
  useDeleteInfraLink,
  useSaveInfraPositions,
  useUpdateInfraLink,
  useUpdateInfraNode,
} from '@/hooks/use-infra'
import {
  describeLink,
  describePort,
  infraErrorMessage,
  NODE_MIN_WIDTH,
  type LayoutIndex,
  type MapLayout,
  type StateIndex,
} from '@/lib/infra'
import {
  CLIENT_CHIP_HEIGHT,
  CLIENT_CHIP_WIDTH,
  WIFI_EDGE_Z_INDEX,
  WIFI_HANDLE_ID,
  type WifiOverlay,
} from '@/lib/infra-overlay'
import type { InfraLayoutResponse, InfraPositionEntry } from '@/types/api'

/** Boxes of the map, plus the Wi-Fi overlay's chips (never written anywhere). */
export type InfraFlowNode = DeviceFlowNode | HostFlowNode | ClientFlowNode
type InfraFlowEdge = CableFlowEdge | WifiFlowEdge

/**
 * What the inspector shows: a node (optionally one of its ports), a cable, or
 * from the Wi-Fi overlay a client or an AP's "+N more" (A4.4).
 */
export type InfraSelection =
  | { type: 'node'; id: number; portId?: number | null }
  | { type: 'link'; id: number }
  | { type: 'client'; mac: string }
  | { type: 'clients'; apNodeId: number }

export type InfraNotice = { tone: 'error' | 'info'; text: string }

/** What the page may ask of the canvas (header actions live outside it). */
export type InfraCanvasApi = {
  /** Flow coordinates for a new device: the middle of what is on screen. */
  dropPosition: () => { x: number; y: number } | null
  fitView: () => void
  /** A spot just right of a node's host frame, at the node's height (for moving it out). */
  outsideFrame: (nodeId: number) => { x: number; y: number } | null
  /** A free spot for a new box next to a node: below it, under `portId` when given (A4). */
  spotNear: (nodeId: number, portId: number | null) => { x: number; y: number } | null
}

const nodeTypes = { device: DeviceNode, host: HostNode, client: ClientNode } as unknown as NodeTypes
const edgeTypes = { cable: CableEdge, wifi: WifiEdge } as unknown as EdgeTypes

// React Flow's own theme variables, pointed at the dashboard's tokens.
const FLOW_STYLE = {
  '--xy-background-color': 'var(--background)',
  '--xy-edge-label-background-color': 'var(--card)',
  '--xy-edge-label-color': 'var(--foreground)',
  '--xy-controls-button-background-color': 'var(--card)',
  '--xy-controls-button-background-color-hover': 'var(--muted)',
  '--xy-controls-button-color': 'var(--foreground)',
  '--xy-controls-button-color-hover': 'var(--foreground)',
  '--xy-controls-button-border-color': 'var(--border)',
  '--xy-controls-box-shadow': '0 1px 2px rgb(0 0 0 / 0.08)',
  '--xy-attribution-background-color': 'transparent',
  '--xy-connectionline-stroke': 'var(--brand)',
  '--xy-connectionline-stroke-width': '2',
  '--xy-selection-background-color': 'color-mix(in oklab, var(--brand) 8%, transparent)',
  '--xy-selection-border': '1px dashed var(--brand)',
  '--xy-resize-background-color': 'var(--brand)',
} as CSSProperties

const FIT_VIEW_OPTIONS = { padding: 0.15, maxZoom: 1.1 }
/** What a new one-port device box measures, for finding it a free spot. */
const NEW_BOX = { width: NODE_MIN_WIDTH, height: 100 }

/** A box of the map, as opposed to a chip of the Wi-Fi overlay: only these are ever written. */
function isMapNode(node: InfraFlowNode | undefined): node is DeviceFlowNode | HostFlowNode {
  return node?.type === 'device' || node?.type === 'host'
}

function buildFlowNodes(mapLayout: MapLayout): InfraFlowNode[] {
  return mapLayout.placed.map((entry): InfraFlowNode => {
    const common = {
      id: String(entry.node.id),
      position: entry.position,
      deletable: false,
      ...(entry.parentId !== null ? { parentId: String(entry.parentId), extent: 'parent' as const } : {}),
    }
    if (entry.node.kind === 'host') {
      return { ...common, type: 'host', data: { node: entry.node }, width: entry.width, height: entry.height }
    }
    return { ...common, type: 'device', data: { node: entry.node, width: entry.width } }
  })
}

/**
 * The overlay's chips, each a child of its AP's box so it moves with the AP
 * while that is dragged. Not selectable, draggable, connectable or deletable.
 */
function buildClientNodes(overlay: WifiOverlay | null): ClientFlowNode[] {
  if (!overlay) return []
  return overlay.chips.map((chip) => ({
    id: chip.id,
    type: 'client',
    parentId: String(chip.apNodeId),
    position: { x: chip.x, y: chip.y },
    data: chip,
    width: CLIENT_CHIP_WIDTH,
    height: CLIENT_CHIP_HEIGHT,
    draggable: false,
    selectable: false,
    connectable: false,
    deletable: false,
    focusable: false,
  }))
}

function sameFields(a: object | undefined, b: object | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  return aKeys.every((key) => (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key])
}

/**
 * Whether a rebuilt node says exactly what React Flow already has for it.
 * `live` skips the geometry a drag or a resize in progress owns.
 */
function describesSame(prev: InfraFlowNode, next: InfraFlowNode, live: { position: boolean; size: boolean }): boolean {
  if (prev.type !== next.type || prev.parentId !== next.parentId) return false
  if (!live.position && (prev.position.x !== next.position.x || prev.position.y !== next.position.y)) return false
  if (!live.size && (prev.width !== next.width || prev.height !== next.height)) return false
  return sameFields(prev.data, next.data)
}

/**
 * A new build replaces only the nodes whose description changed, and keeps
 * what React Flow knows about the others (measured size, selection, a drag or
 * a resize in progress), object for object. A poll that changes nothing, or
 * changes only the overlay, leaves every map box as it was; when nothing at
 * all changed the array itself is kept, so React Flow sees no update.
 */
function mergeFlowNodes(current: InfraFlowNode[], next: InfraFlowNode[]): InfraFlowNode[] {
  const previous = new Map(current.map((node) => [node.id, node]))
  let changed = current.length !== next.length
  const merged = next.map((node, i) => {
    const prev = previous.get(node.id)
    let out: InfraFlowNode = node
    if (prev) {
      const resizing = prev.type === 'host' && node.type === 'host' && Boolean(prev.resizing)
      const live = { position: Boolean(prev.dragging) || resizing, size: resizing }
      if (describesSame(prev, node, live)) {
        out = prev
      } else {
        const fresh = { ...node, selected: prev.selected, measured: prev.measured } as InfraFlowNode
        if (live.position) {
          fresh.position = prev.position
          fresh.dragging = prev.dragging
        }
        if (resizing) {
          fresh.width = prev.width
          fresh.height = prev.height
        }
        out = fresh
      }
    }
    if (out !== current[i]) changed = true
    return out
  })
  return changed ? merged : current
}

function buildFlowEdges(layout: InfraLayoutResponse, index: LayoutIndex, drawn: Set<number>): CableFlowEdge[] {
  const drawable = (portId: number) => {
    const port = index.ports.get(portId)
    return Boolean(port) && !port!.hidden
  }
  return layout.links
    .filter(
      (link) =>
        drawn.has(link.a.nodeId) &&
        drawn.has(link.b.nodeId) &&
        drawable(link.a.portId) &&
        drawable(link.b.portId),
    )
    .map((link) => ({
      id: `link-${link.id}`,
      type: 'cable' as const,
      source: String(link.a.nodeId),
      sourceHandle: String(link.a.portId),
      target: String(link.b.nodeId),
      targetHandle: String(link.b.portId),
      data: { linkId: link.id },
      animated: link.medium === 'wireless',
    }))
}

function buildWifiEdges(overlay: WifiOverlay | null): WifiFlowEdge[] {
  if (!overlay) return []
  return overlay.edges.map((edge) => ({
    id: edge.id,
    type: 'wifi' as const,
    source: edge.source,
    sourceHandle: WIFI_HANDLE_ID,
    target: edge.target,
    targetHandle: WIFI_HANDLE_ID,
    data: { quality: edge.quality, variant: edge.variant },
    // Beneath every box and chip, whatever React Flow lifts edges of child nodes to.
    zIndex: WIFI_EDGE_Z_INDEX,
    selectable: false,
    focusable: false,
    deletable: false,
    reconnectable: false,
  }))
}

function sameEdge(a: InfraFlowEdge, b: InfraFlowEdge): boolean {
  return (
    a.type === b.type &&
    a.source === b.source &&
    a.target === b.target &&
    a.sourceHandle === b.sourceHandle &&
    a.targetHandle === b.targetHandle &&
    a.animated === b.animated &&
    sameFields(a.data, b.data)
  )
}

/** Edges as nodes: unchanged ones are kept object for object, a selection survives a rebuild. */
function mergeFlowEdges(current: InfraFlowEdge[], next: InfraFlowEdge[]): InfraFlowEdge[] {
  const previous = new Map(current.map((edge) => [edge.id, edge]))
  let changed = current.length !== next.length
  const merged = next.map((edge, i) => {
    const prev = previous.get(edge.id)
    let out: InfraFlowEdge = edge
    if (prev && sameEdge(prev, edge)) out = prev
    else if (prev?.selected) out = { ...edge, selected: true } as InfraFlowEdge
    if (out !== current[i]) changed = true
    return out
  })
  return changed ? merged : current
}

type Rect = { x: number; y: number; width: number; height: number }

/**
 * The first spot at or after `start` (stepping down, then right) where a box of
 * `size` overlaps none of `taken`, so a new or moved box never lands on another.
 */
function freeSpot(start: { x: number; y: number }, size: { width: number; height: number }, taken: Rect[]) {
  const gap = 16
  const overlaps = (x: number, y: number) =>
    taken.some(
      (r) =>
        x < r.x + r.width + gap && x + size.width + gap > r.x && y < r.y + r.height + gap && y + size.height + gap > r.y,
    )
  for (let column = 0; column < 8; column += 1) {
    for (let row = 0; row < 12; row += 1) {
      const x = start.x + column * (size.width + 32)
      const y = start.y + row * 48
      if (!overlaps(x, y)) return { x: Math.round(x), y: Math.round(y) }
    }
  }
  return { x: Math.round(start.x), y: Math.round(start.y) }
}

type InfraCanvasProps = {
  layout: InfraLayoutResponse
  index: LayoutIndex
  stateIndex: StateIndex
  mapLayout: MapLayout
  /** The Wi-Fi overlay while it is on (A4.4), else null. */
  overlay: WifiOverlay | null
  editing: boolean
  isDark: boolean
  selection: InfraSelection | null
  onSelect: (selection: InfraSelection | null) => void
  /** A drag, a cable being drawn or a frame being resized: the page pauses its polls. */
  onInteractingChange: (active: boolean) => void
  onNotice: (notice: InfraNotice | null) => void
  onAddPorts: (nodeId: number) => void
  onConnectDevice: (nodeId: number, portId: number) => void
  /** `?node=`: the box to centre on (A4.3). */
  focusNodeId: number | null
  apiRef: RefObject<InfraCanvasApi | null>
}

export function InfraCanvas({
  layout,
  index,
  stateIndex,
  mapLayout,
  overlay,
  editing,
  isDark,
  selection,
  onSelect,
  onInteractingChange,
  onNotice,
  onAddPorts,
  onConnectDevice,
  focusNodeId,
  apiRef,
}: InfraCanvasProps) {
  const flow = useReactFlow<InfraFlowNode, InfraFlowEdge>()
  const containerRef = useRef<HTMLDivElement>(null)
  // Two independent sets joined by id: the map's boxes follow the layout, the
  // overlay's chips follow the Wi-Fi poll. A state poll touches neither.
  const mapNodes = useMemo(() => buildFlowNodes(mapLayout), [mapLayout])
  const clientNodes = useMemo(() => buildClientNodes(overlay), [overlay])
  const builtNodes = useMemo<InfraFlowNode[]>(
    () => (clientNodes.length > 0 ? [...mapNodes, ...clientNodes] : mapNodes),
    [mapNodes, clientNodes],
  )
  const drawnIds = useMemo(() => new Set(mapLayout.placed.map((entry) => entry.node.id)), [mapLayout])
  const cableEdges = useMemo(() => buildFlowEdges(layout, index, drawnIds), [layout, index, drawnIds])
  const wifiEdges = useMemo(() => buildWifiEdges(overlay), [overlay])
  const builtEdges = useMemo<InfraFlowEdge[]>(
    () => (wifiEdges.length > 0 ? [...cableEdges, ...wifiEdges] : cableEdges),
    [cableEdges, wifiEdges],
  )
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<InfraFlowNode>(builtNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<InfraFlowEdge>(builtEdges)
  const [hover, setHover] = useState<{ portId: number; anchor: DOMRect } | null>(null)
  const portClickRef = useRef<number | null>(null)
  const dragRef = useRef(false)
  const keyboardMoved = useRef(new Set<string>())
  const keyboardTimer = useRef<number | null>(null)

  const updateNode = useUpdateInfraNode()
  const savePositions = useSaveInfraPositions()
  const createLink = useCreateInfraLink()
  const updateLink = useUpdateInfraLink()
  const deleteLink = useDeleteInfraLink()

  // The layout or the overlay changed: swap what changed, keep React Flow's own facts.
  useEffect(() => {
    setNodes((current) => mergeFlowNodes(current, builtNodes))
  }, [builtNodes, setNodes])
  useEffect(() => {
    setEdges((current) => mergeFlowEdges(current, builtEdges))
  }, [builtEdges, setEdges])

  // A selection made elsewhere (the inspector, the table) shows on the map too.
  useEffect(() => {
    const nodeId = selection?.type === 'node' ? String(selection.id) : null
    const edgeId = selection?.type === 'link' ? `link-${selection.id}` : null
    setNodes((current) => {
      if (nodeId && current.find((node) => node.id === nodeId)?.selected) return current
      let changed = false
      const next = current.map((node) => {
        const want = node.id === nodeId
        if (Boolean(node.selected) === want) return node
        changed = true
        return { ...node, selected: want }
      })
      return changed ? next : current
    })
    setEdges((current) => {
      let changed = false
      const next = current.map((edge) => {
        const want = edge.id === edgeId
        if (Boolean(edge.selected) === want) return edge
        changed = true
        return { ...edge, selected: want }
      })
      return changed ? next : current
    })
  }, [selection, setNodes, setEdges])

  // Whether the view is still the one the page fitted: nobody has panned or
  // zoomed, and no `?node=` box has been centred.
  const viewTouched = useRef(false)
  const markViewTouched = useCallback(() => {
    viewTouched.current = true
  }, [])

  // `?node=` (A4.3): centre that box, once the map is measured. A later
  // fitView replaces the initial one while it is still queued.
  useEffect(() => {
    if (focusNodeId === null) return
    const id = String(focusNodeId)
    if (!flow.getNode(id)) return
    viewTouched.current = true
    void flow.fitView({ nodes: [{ id }], maxZoom: 1, minZoom: 0.35, padding: 0.4, duration: 250 })
  }, [focusNodeId, flow])

  // The overlay's chips arrive after the map was fitted: fit again to take them
  // in, as long as the view is untouched. Keyed on the nodes React Flow was
  // given, so its store has the chips by the time the fit is measured.
  const hasChips = nodes.some((node) => node.type === 'client')
  useEffect(() => {
    if (!hasChips || viewTouched.current) return
    const frame = window.requestAnimationFrame(() => {
      void flow.fitView({ ...FIT_VIEW_OPTIONS, duration: 200 })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [hasChips, flow])

  // Never leave the page's polls paused behind.
  useEffect(() => () => onInteractingChange(false), [onInteractingChange])
  useEffect(
    () => () => {
      if (keyboardTimer.current !== null) window.clearTimeout(keyboardTimer.current)
    },
    [],
  )

  const reportError = useCallback(
    (error: unknown, fallback: string, context?: { portIds?: number[]; nodeId?: number }) => {
      onNotice({ tone: 'error', text: infraErrorMessage(error, index, fallback, context) })
    },
    [index, onNotice],
  )

  const hasAutoPlaced = useMemo(() => mapLayout.placed.some((entry) => entry.auto), [mapLayout])

  /**
   * Saves where nodes are now. While some of the map is still laid out here
   * (never placed), the first move writes the whole picture as it is on
   * screen, so the unplaced part does not rearrange itself around the move.
   * Only map boxes are ever written: the overlay's chips are not persisted.
   */
  const persistPositions = useCallback(
    (movedIds: string[]) => {
      const all = flow.getNodes().filter(isMapNode)
      const byId = new Map(all.map((node) => [node.id, node]))
      const ids = hasAutoPlaced ? all.map((node) => node.id) : movedIds
      const entries: InfraPositionEntry[] = []
      for (const id of ids) {
        const node = byId.get(id)
        if (!node) continue
        entries.push({
          nodeId: Number(id),
          x: Math.round(node.position.x),
          y: Math.round(node.position.y),
          parentId: node.parentId ? Number(node.parentId) : null,
        })
      }
      if (entries.length === 0) return
      const onError = (error: unknown) => reportError(error, 'Could not save the new position.')
      if (entries.length === 1) {
        const [entry] = entries
        updateNode.mutate({ id: entry.nodeId, payload: { position: { x: entry.x, y: entry.y } } }, { onError })
        return
      }
      for (let i = 0; i < entries.length; i += 200) {
        savePositions.mutate(entries.slice(i, i + 200), { onError })
      }
    },
    [flow, hasAutoPlaced, reportError, savePositions, updateNode],
  )

  const onNodesChange = useCallback(
    (changes: NodeChange<InfraFlowNode>[]) => {
      // Nodes are never removed from the canvas; deleting one goes through the inspector.
      const kept = changes.filter((change) => change.type !== 'remove')
      if (editing && !dragRef.current) {
        // Arrow keys move a selected node: position changes outside a drag.
        for (const change of kept) {
          if (change.type === 'position' && change.position && change.dragging === false) {
            keyboardMoved.current.add(change.id)
          }
        }
        if (keyboardMoved.current.size > 0) {
          if (keyboardTimer.current !== null) window.clearTimeout(keyboardTimer.current)
          keyboardTimer.current = window.setTimeout(() => {
            keyboardTimer.current = null
            const ids = [...keyboardMoved.current]
            keyboardMoved.current.clear()
            persistPositions(ids)
          }, 600)
        }
      }
      onNodesChangeBase(kept)
    },
    [editing, onNodesChangeBase, persistPositions],
  )

  const onDragStart = useCallback(() => {
    dragRef.current = true
    setHover(null)
    onInteractingChange(true)
  }, [onInteractingChange])

  const onDragStop = useCallback(
    (movedIds: string[]) => {
      dragRef.current = false
      onInteractingChange(false)
      persistPositions(movedIds)
    },
    [onInteractingChange, persistPositions],
  )

  const saveFrame = useCallback(
    (nodeId: number, frame: { x: number; y: number; width: number; height: number }) => {
      const size = { width: Math.round(frame.width), height: Math.round(frame.height) }
      const onError = (error: unknown) => reportError(error, 'Could not save the frame size.')
      if (hasAutoPlaced) {
        updateNode.mutate({ id: nodeId, payload: { size } }, { onError })
        persistPositions([String(nodeId)])
        return
      }
      updateNode.mutate(
        { id: nodeId, payload: { size, position: { x: Math.round(frame.x), y: Math.round(frame.y) } } },
        { onError },
      )
    },
    [hasAutoPlaced, persistPositions, reportError, updateNode],
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      const aPortId = Number(connection.sourceHandle)
      const bPortId = Number(connection.targetHandle)
      if (!Number.isInteger(aPortId) || !Number.isInteger(bPortId)) return
      onNotice(null)
      createLink.mutate(
        { aPortId, bPortId },
        {
          onSuccess: () =>
            onNotice({
              tone: 'info',
              text: `Cable added: ${describePort(index, aPortId)} to ${describePort(index, bPortId)}.`,
            }),
          onError: (error) => reportError(error, 'Could not add the cable.', { portIds: [aPortId, bPortId] }),
        },
      )
    },
    [createLink, index, onNotice, reportError],
  )

  const onReconnect = useCallback(
    (oldEdge: InfraFlowEdge, connection: Connection) => {
      if (oldEdge.type !== 'cable') return
      const link = index.links.get(oldEdge.data?.linkId ?? -1)
      if (!link) return
      const ends = [Number(connection.sourceHandle), Number(connection.targetHandle)]
      const kept = ends.find((portId) => portId === link.a.portId || portId === link.b.portId)
      const moved = ends.find((portId) => portId !== link.a.portId && portId !== link.b.portId)
      if (kept === undefined || moved === undefined || !Number.isInteger(moved)) return
      const payload = kept === link.a.portId ? { bPortId: moved } : { aPortId: moved }
      onNotice(null)
      updateLink.mutate(
        { id: link.id, payload },
        {
          onSuccess: () =>
            onNotice({
              tone: 'info',
              text: `Cable moved: ${describePort(index, kept)} to ${describePort(index, moved)}.`,
            }),
          onError: (error) => reportError(error, 'Could not move the cable.', { portIds: [moved, kept] }),
        },
      )
    },
    [index, onNotice, reportError, updateLink],
  )

  // Delete / Backspace on a selected cable removes it; boxes are never deleted by key.
  const onBeforeDelete = useCallback<OnBeforeDelete<InfraFlowNode, InfraFlowEdge>>(
    async ({ edges: doomed }) => {
      if (!editing) return false
      let removed = 0
      for (const edge of doomed) {
        if (edge.type !== 'cable') continue
        const linkId = edge.data?.linkId
        if (linkId === undefined) continue
        const label = describeLink(index, linkId)
        removed += 1
        deleteLink.mutate(linkId, {
          onSuccess: () => onNotice({ tone: 'info', text: `Cable removed: ${label}.` }),
          onError: (error) => reportError(error, 'Could not remove the cable.'),
        })
      }
      if (removed > 0) onSelect(null)
      return false
    },
    [deleteLink, editing, index, onNotice, onSelect, reportError],
  )

  useEffect(() => {
    // What the top level of the map occupies, in flow coordinates: root boxes
    // and frames, and the overlay's chips (children of their AP) where they are.
    const rootRects = (except?: string): Rect[] =>
      flow
        .getNodes()
        .filter((node) => node.id !== except && (!node.parentId || node.type === 'client'))
        .map((node) => {
          const at = node.parentId ? (flow.getInternalNode(node.id)?.internals.positionAbsolute ?? node.position) : node.position
          return {
            x: at.x,
            y: at.y,
            width: node.measured?.width ?? node.width ?? 200,
            height: node.measured?.height ?? node.height ?? 100,
          }
        })
    apiRef.current = {
      dropPosition: () => {
        const box = containerRef.current?.getBoundingClientRect()
        if (!box) return null
        const at = flow.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 })
        // A new box lands near the middle of the screen, on free space.
        return freeSpot({ x: at.x - 92, y: at.y - 50 }, { width: 200, height: 100 }, rootRects())
      },
      fitView: () => {
        void flow.fitView({ ...FIT_VIEW_OPTIONS, duration: 300 })
      },
      outsideFrame: (nodeId) => {
        const internal = flow.getInternalNode(String(nodeId))
        if (!internal) return null
        const frame = internal.parentId ? flow.getInternalNode(internal.parentId) : undefined
        if (!frame) return { ...internal.internals.positionAbsolute }
        const frameWidth = frame.measured.width ?? frame.width ?? 0
        const size = { width: internal.measured.width ?? 200, height: internal.measured.height ?? 100 }
        const start = { x: frame.internals.positionAbsolute.x + frameWidth + 48, y: internal.internals.positionAbsolute.y }
        return freeSpot(start, size, rootRects(String(nodeId)))
      },
      spotNear: (nodeId, portId) => {
        const internal = flow.getInternalNode(String(nodeId))
        if (!internal) return null
        const at = internal.internals.positionAbsolute
        const width = internal.measured.width ?? internal.width ?? 200
        const height = internal.measured.height ?? internal.height ?? 100
        // Under the port when there is one (a cable leaves its socket downwards), else under the box.
        const handle =
          portId !== null ? internal.internals.handleBounds?.source?.find((entry) => entry.id === String(portId)) : undefined
        const centre = handle ? at.x + handle.x + handle.width / 2 : at.x + width / 2
        return freeSpot({ x: centre - NEW_BOX.width / 2, y: at.y + height + 72 }, NEW_BOX, rootRects())
      },
    }
    return () => {
      apiRef.current = null
    }
  }, [apiRef, flow])

  const focusedPortId = selection?.type === 'node' ? (selection.portId ?? null) : null
  const view = useMemo<InfraView>(
    () => ({
      index,
      state: stateIndex,
      editing,
      focusedPortId,
      onPortClick: (_nodeId, portId) => {
        portClickRef.current = portId
      },
      onPortHover: (portId, anchor) => setHover(portId !== null && anchor ? { portId, anchor } : null),
      onCableLabelClick: (linkId) => onSelect({ type: 'link', id: linkId }),
      onAddPorts,
      onConnectDevice,
      onFrameResizeStart: () => onInteractingChange(true),
      onFrameResizeEnd: (nodeId, frame) => {
        onInteractingChange(false)
        saveFrame(nodeId, frame)
      },
    }),
    [editing, focusedPortId, index, onAddPorts, onConnectDevice, onInteractingChange, onSelect, saveFrame, stateIndex],
  )

  const selectedChipId =
    selection?.type === 'client'
      ? `wifi:${selection.mac}`
      : selection?.type === 'clients'
        ? `wifi-more:${selection.apNodeId}`
        : null
  const overlayView = useMemo<InfraOverlayView>(
    () => ({
      selectedChipId,
      onClientClick: (mac) => onSelect({ type: 'client', mac: mac.toLowerCase() }),
      onMoreClick: (apNodeId) => onSelect({ type: 'clients', apNodeId }),
    }),
    [onSelect, selectedChipId],
  )

  return (
    <InfraViewContext.Provider value={view}>
      <InfraOverlayContext.Provider value={overlayView}>
        <div ref={containerRef} className="h-full w-full">
          <ReactFlow<InfraFlowNode, InfraFlowEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            connectionMode={ConnectionMode.Loose}
            // A click on a port picks it (and offers "Connect a device…"); cables are drawn by dragging.
            connectOnClick={false}
            nodesDraggable={editing}
            nodesConnectable={editing}
            edgesReconnectable={editing}
            elementsSelectable
            deleteKeyCode={editing ? ['Delete', 'Backspace'] : null}
            selectionKeyCode={editing ? 'Shift' : null}
            multiSelectionKeyCode={editing ? ['Meta', 'Control'] : null}
            onBeforeDelete={onBeforeDelete}
            onNodeClick={(_event, node) => {
              const portId = portClickRef.current
              portClickRef.current = null
              if (!isMapNode(node)) return
              onSelect({ type: 'node', id: Number(node.id), portId })
            }}
            onEdgeClick={(_event, edge) => {
              if (edge.type === 'cable' && edge.data) onSelect({ type: 'link', id: edge.data.linkId })
            }}
            onPaneClick={() => onSelect(null)}
            onNodeDragStart={onDragStart}
            onNodeDragStop={(_event, _node, dragged) => onDragStop(dragged.map((node) => node.id))}
            onSelectionDragStart={onDragStart}
            onSelectionDragStop={(_event, dragged) => onDragStop(dragged.map((node) => node.id))}
            onConnect={onConnect}
            onConnectStart={() => {
              setHover(null)
              onInteractingChange(true)
            }}
            onConnectEnd={() => onInteractingChange(false)}
            onReconnect={onReconnect}
            onReconnectStart={() => onInteractingChange(true)}
            onReconnectEnd={() => onInteractingChange(false)}
            onMoveStart={(event) => {
              setHover(null)
              // A pan or zoom by hand (programmatic moves have no event).
              if (event) markViewTouched()
            }}
            fitView
            fitViewOptions={FIT_VIEW_OPTIONS}
            minZoom={0.15}
            maxZoom={2}
            colorMode={isDark ? 'dark' : 'light'}
            style={FLOW_STYLE}
            connectionLineStyle={{ stroke: 'var(--brand)', strokeWidth: 2 }}
            elevateEdgesOnSelect
            aria-label="Network map"
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={22}
              size={1.2}
              color="color-mix(in oklab, var(--muted-foreground) 45%, transparent)"
            />
            <Controls
              showInteractive={false}
              position="bottom-left"
              onZoomIn={markViewTouched}
              onZoomOut={markViewTouched}
            />
          </ReactFlow>
        </div>
        {hover ? <PortTooltip portId={hover.portId} anchor={hover.anchor} index={index} state={stateIndex} /> : null}
      </InfraOverlayContext.Provider>
    </InfraViewContext.Provider>
  )
}
