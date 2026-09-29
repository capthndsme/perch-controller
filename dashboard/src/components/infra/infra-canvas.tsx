import '@xyflow/react/dist/style.css'
import '@/components/infra/infra-traffic.css'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  ControlButton,
  Controls,
  getViewportForBounds,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type EdgeTypes,
  type NodeChange,
  type NodeTypes,
  type OnBeforeDelete,
  type Viewport,
} from '@xyflow/react'
import { CableEdge, type CableFlowEdge } from '@/components/infra/cable-edge'
import { ClientNode, type ClientFlowNode } from '@/components/infra/client-node'
import { DeviceNode, type DeviceFlowNode } from '@/components/infra/device-node'
import { HostNode, type HostFlowNode } from '@/components/infra/host-node'
import { MapCamera, planGlide, revealShift, type ViewportSample } from '@/components/infra/map-camera'
import {
  InfraOverlayContext,
  InfraViewContext,
  type InfraOverlayView,
  type InfraView,
} from '@/components/infra/infra-context'
import { PortTooltip } from '@/components/infra/port-strip'
import { WifiEdge, type WifiFlowEdge } from '@/components/infra/wifi-edge'
import {
  infraPositionsMutationKey,
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
import { easeInOut, MOTION_MS, prefersReducedMotion } from '@/lib/motion'
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

/** How much of the canvas something covers from its right and bottom edges (px): an inspector, the phone sheet. */
export type InfraOccludedInsets = { right: number; bottom: number }

const NO_INSETS: InfraOccludedInsets = { right: 0, bottom: 0 }

/** A selection as a string, to notice when it changes. */
function selectionKey(selection: InfraSelection | null): string | null {
  if (!selection) return null
  if (selection.type === 'node') return `n${selection.id}`
  if (selection.type === 'link') return `l${selection.id}`
  if (selection.type === 'client') return `c${selection.mac}`
  return `a${selection.apNodeId}`
}

/** A move of the viewport (pan, pinch, wheel) made by a finger rather than a mouse. */
function isTouch(event: MouseEvent | TouchEvent | null): boolean {
  return event !== null && event.type.startsWith('touch')
}

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
const MIN_ZOOM = 0.15
/** How a `?node=` box is framed: in the uncovered part of the canvas, not too close, not too far. */
const FOCUS = { minZoom: 0.35, maxZoom: 1, padding: 0.4 }
/** What stays clear around a selection brought into view (px), and the least room worth panning for. */
const REVEAL_MARGIN = 16
const REVEAL_MIN_ROOM = 48
/** The canvas counts as moving until its viewport has been still this long (ms): the flow dots hold meanwhile. */
const MOVING_IDLE_MS = 150
/** What a new one-port device box measures, for finding it a free spot. */
const NEW_BOX = { width: NODE_MIN_WIDTH, height: 100 }

/** React Flow's fit-view icon (its Controls do not export it). */
function FitViewIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 30" aria-hidden>
      <path d="M3.692 4.63c0-.53.4-.938.939-.938h5.215V0H4.708C2.13 0 0 2.054 0 4.63v5.216h3.692V4.631zM27.354 0h-5.2v3.692h5.17c.53 0 .984.4.984.939v5.215H32V4.631A4.624 4.624 0 0027.354 0zm.954 24.83c0 .532-.4.94-.939.94h-5.215v3.768h5.215c2.577 0 4.631-2.13 4.631-4.707v-5.139h-3.692v5.139zm-23.677.94c-.531 0-.939-.4-.939-.94v-5.138H0v5.139c0 2.577 2.13 4.707 4.708 4.707h5.138V25.77H4.631z" />
    </svg>
  )
}

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
type XY = { x: number; y: number }

/**
 * The boxes a rebuild moves (same parent, not under a hand), from where they
 * are to where the layout puts them.
 */
function movedNodes(current: InfraFlowNode[], next: InfraFlowNode[]): Map<string, { from: XY; to: XY }> {
  const previous = new Map(current.map((node) => [node.id, node]))
  const moved = new Map<string, { from: XY; to: XY }>()
  for (const node of next) {
    const prev = previous.get(node.id)
    if (!prev || prev.dragging || prev.parentId !== node.parentId) continue
    const { x, y } = prev.position
    if (Math.abs(x - node.position.x) > 0.5 || Math.abs(y - node.position.y) > 0.5) {
      moved.set(node.id, { from: { x, y }, to: node.position })
    }
  }
  return moved
}

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
  /** A6.5: rates on the cables and activity lights on the ports. */
  showTraffic: boolean
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
  /**
   * What covers the canvas (the inspector, the phone sheet at the detent it is
   * heading for; px). A selection is brought into the rest of it, and a
   * `?node=` box is framed there.
   */
  occludedInsets?: InfraOccludedInsets
  apiRef: RefObject<InfraCanvasApi | null>
}

export function InfraCanvas({
  layout,
  index,
  stateIndex,
  mapLayout,
  overlay,
  editing,
  showTraffic,
  isDark,
  selection,
  onSelect,
  onInteractingChange,
  onNotice,
  onAddPorts,
  onConnectDevice,
  focusNodeId,
  occludedInsets = NO_INSETS,
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

  // The layout or the overlay changed: swap what changed, keep React Flow's own
  // facts. Boxes that Auto-arrange moves (a batch of positions being saved)
  // glide to their new places in 300 ms (`easeInOut`, moving on screen); the
  // cables follow, being drawn from the boxes. Anything else (a poll, someone
  // else's edit, reduced motion) lands at once.
  const queryClient = useQueryClient()
  const glide = useRef<{ frame: number; target: InfraFlowNode[] } | null>(null)
  useEffect(() => {
    const running = glide.current
    if (running) {
      // A refetch during the glide: it ends on the latest layout.
      running.target = builtNodes
      return
    }
    const arranging = queryClient.isMutating({ mutationKey: infraPositionsMutationKey }) > 0
    const moved = arranging && !prefersReducedMotion() ? movedNodes(flow.getNodes(), builtNodes) : null
    if (!moved || moved.size === 0) {
      setNodes((current) => mergeFlowNodes(current, builtNodes))
      return
    }
    const state = { frame: 0, target: builtNodes }
    glide.current = state
    const place = (at: (from: XY, to: XY) => XY) => (current: InfraFlowNode[]) =>
      current.map((node) => {
        const move = moved.get(node.id)
        return move ? ({ ...node, position: at(move.from, move.to) } as InfraFlowNode) : node
      })
    // Everything but the moved boxes' positions changes now.
    setNodes((current) => place((from) => from)(mergeFlowNodes(current, builtNodes)))
    const start = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / MOTION_MS.slow))
      if (t < 1) {
        const e = easeInOut(t)
        setNodes(place((from, to) => ({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e })))
        state.frame = window.requestAnimationFrame(step)
        return
      }
      glide.current = null
      setNodes((current) => mergeFlowNodes(current, state.target))
    }
    state.frame = window.requestAnimationFrame(step)
  }, [builtNodes, flow, queryClient, setNodes])
  useEffect(
    () => () => {
      if (glide.current) window.cancelAnimationFrame(glide.current.frame)
    },
    [],
  )
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

  // ── Camera (map-camera.ts): every programmatic move and the flick glide. ──
  const [camera] = useState(
    () =>
      new MapCamera(
        (viewport) => void flow.setViewport(viewport),
        () => flow.getViewport(),
      ),
  )
  useEffect(() => () => camera.stop(), [camera])
  // A pan or pinch by hand is under way: nothing moves the camera meanwhile.
  const userMoving = useRef(false)
  const panSamples = useRef<ViewportSample[]>([])
  // A selection or inset change waits a frame to be brought into view.
  const revealPending = useRef(false)
  const movingTimer = useRef<number | null>(null)
  const insetRight = occludedInsets.right
  const insetBottom = occludedInsets.bottom
  // The latest selection and insets, for camera moves that finish later.
  const latest = useRef({ selection, insets: NO_INSETS })
  useEffect(() => {
    latest.current = { selection, insets: { right: insetRight, bottom: insetBottom } }
  })

  /** The whole map in view (the fit button, after Arrange, when the Wi-Fi chips arrive). */
  const fitAll = useCallback(() => {
    const box = containerRef.current?.getBoundingClientRect()
    const all = flow.getNodes()
    if (!box || box.width === 0 || all.length === 0) return
    const bounds = glide.current ? landedBounds(glide.current.target) : flow.getNodesBounds(all)
    const { maxZoom, padding } = FIT_VIEW_OPTIONS
    camera.moveTo(getViewportForBounds(bounds, box.width, box.height, MIN_ZOOM, maxZoom, padding))
    // Where the boxes of a running Arrange glide end up: the top-level boxes and frames at their new places.
    function landedBounds(target: InfraFlowNode[]): Rect {
      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
      for (const node of target) {
        if (node.parentId) continue
        const measured = flow.getInternalNode(node.id)?.measured
        const width = measured?.width ?? node.width ?? 200
        const height = measured?.height ?? node.height ?? 100
        x0 = Math.min(x0, node.position.x)
        y0 = Math.min(y0, node.position.y)
        x1 = Math.max(x1, node.position.x + width)
        y1 = Math.max(y1, node.position.y + height)
      }
      return Number.isFinite(x0) ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : flow.getNodesBounds(all)
    }
  }, [camera, flow])

  // The part of the canvas nothing covers, in canvas pixels (null before layout).
  const openArea = useCallback((insets: InfraOccludedInsets) => {
    const box = containerRef.current?.getBoundingClientRect()
    if (!box || box.width === 0) return null
    return { width: box.width - insets.right, height: box.height - insets.bottom }
  }, [])

  /** `?node=`: frame the box in the uncovered part of the canvas. */
  const focusNode = useCallback(
    (id: string, animate: boolean) => {
      const node = flow.getInternalNode(id)
      const area = openArea(latest.current.insets)
      if (!node?.measured.width || !area) return
      // Too little left uncovered: frame it in the whole canvas instead.
      const box = containerRef.current!.getBoundingClientRect()
      const cramped = area.width < REVEAL_MIN_ROOM * 2 || area.height < REVEAL_MIN_ROOM * 2
      const { width, height } = cramped ? box : area
      const bounds = flow.getNodesBounds([id])
      const target = getViewportForBounds(bounds, width, height, FOCUS.minZoom, FOCUS.maxZoom, FOCUS.padding)
      camera.moveTo(target, animate)
    },
    [camera, flow, openArea],
  )

  /** A selection's box in flow coordinates, or null when it is not on the map (or not measured yet). */
  const selectionBox = useCallback(
    (picked: InfraSelection): Rect | null => {
      const nodeBox = (id: string): Rect | null => {
        const node = flow.getInternalNode(id)
        const width = node?.measured.width
        const height = node?.measured.height
        if (!node || node.hidden || !width || !height) return null
        return { ...node.internals.positionAbsolute, width, height }
      }
      if (picked.type === 'node') return nodeBox(String(picked.id))
      if (picked.type === 'client') return nodeBox(`wifi:${picked.mac}`)
      if (picked.type === 'clients') return nodeBox(`wifi-more:${picked.apNodeId}`)
      // A cable: its two sockets, with room for the rate chip beside them.
      const link = index.links.get(picked.id)
      if (!link) return null
      const ends = [link.a, link.b].map((end) => {
        const node = flow.getInternalNode(String(end.nodeId))
        const socket = node?.internals.handleBounds?.source?.find((handle) => handle.id === String(end.portId))
        if (!node || !socket) return null
        const at = node.internals.positionAbsolute
        return { x: at.x + socket.x + socket.width / 2, y: at.y + socket.y + socket.height / 2 }
      })
      if (!ends[0] || !ends[1]) return null
      const pad = 24
      const x = Math.min(ends[0].x, ends[1].x) - pad
      const y = Math.min(ends[0].y, ends[1].y) - pad
      const width = Math.abs(ends[0].x - ends[1].x) + pad * 2
      return { x, y, width, height: Math.abs(ends[0].y - ends[1].y) + pad * 2 }
    },
    [flow, index],
  )

  /**
   * Brings the selection into the uncovered part of the canvas, moving the
   * least (never zooming), and not at all when it is already in view. A cable
   * too long to fit shows its middle.
   */
  const revealSelection = useCallback(
    (animate: boolean) => {
      const { selection: picked, insets } = latest.current
      if (!picked || dragRef.current || userMoving.current) return
      const rect = selectionBox(picked)
      const area = openArea(insets)
      if (!rect || !area) return
      const room = {
        left: REVEAL_MARGIN,
        top: REVEAL_MARGIN,
        right: area.width - REVEAL_MARGIN,
        bottom: area.height - REVEAL_MARGIN,
      }
      if (room.right - room.left < REVEAL_MIN_ROOM || room.bottom - room.top < REVEAL_MIN_ROOM) return
      // From where a running move is heading, so a second move does not undo the first.
      const vp = camera.target() ?? flow.getViewport()
      let box = {
        left: rect.x * vp.zoom + vp.x,
        top: rect.y * vp.zoom + vp.y,
        right: (rect.x + rect.width) * vp.zoom + vp.x,
        bottom: (rect.y + rect.height) * vp.zoom + vp.y,
      }
      const fits = box.right - box.left <= room.right - room.left && box.bottom - box.top <= room.bottom - room.top
      if (picked.type === 'link' && !fits) {
        const cx = (box.left + box.right) / 2
        const cy = (box.top + box.bottom) / 2
        box = { left: cx - 24, top: cy - 24, right: cx + 24, bottom: cy + 24 }
      }
      const { dx, dy } = revealShift(box, room)
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return
      camera.moveTo({ x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom }, animate)
    },
    [camera, flow, openArea, selectionBox],
  )

  // `?node=` (A4.3): frame that box. Arriving on such a link (the map not
  // measured yet) lands on it with no flight: the fit replaces the queued
  // initial one and waits for the measurements. Once the map is up, a change
  // of the address flies there.
  const landing = useRef(false)
  // The box this address was framed for: the effect re-runs whenever the
  // layout changes (a drag, a rename, a poll), and the address stays in the
  // URL, so without this the camera would fly back to it each time.
  const framedFor = useRef<number | null>(null)
  useEffect(() => {
    if (focusNodeId === null) {
      framedFor.current = null
      return
    }
    const id = String(focusNodeId)
    if (!flow.getNode(id)) return
    if (framedFor.current === focusNodeId) return
    framedFor.current = focusNodeId
    viewTouched.current = true
    if (flow.getInternalNode(id)?.measured.width && !landing.current) {
      focusNode(id, true)
      return
    }
    landing.current = true
    camera.stop()
    void flow.fitView({ nodes: [{ id }], ...FOCUS, duration: 0 }).then(() => {
      landing.current = false
      revealPending.current = false
      // Measured now: frame it in what the inspector or sheet leaves, in the same frame.
      focusNode(id, false)
      revealSelection(false)
    })
  }, [camera, focusNodeId, flow, focusNode, revealSelection])

  // Keep the selection in view when it changes (a pick in the table, a link in
  // the inspector) or when more of the canvas gets covered (the phone sheet
  // rising, the inspector opening). One frame later, so a change of both in
  // successive renders makes one move, and so the sheet and the camera start
  // together.
  const selected = selectionKey(selection)
  const revealSeen = useRef<{ key: string | null; right: number; bottom: number } | null>(null)
  useEffect(() => {
    const seen = revealSeen.current
    revealSeen.current = { key: selected, right: insetRight, bottom: insetBottom }
    // On mount the camera is the page's fit or the `?node=` landing.
    if (seen === null) return
    if (selected !== seen.key || insetRight > seen.right || insetBottom > seen.bottom) revealPending.current = true
    if (!revealPending.current) return
    if (selected === null) {
      revealPending.current = false
      return
    }
    const frame = window.requestAnimationFrame(() => {
      // The landing brings it into view itself once the map is measured.
      if (landing.current) return
      revealPending.current = false
      revealSelection(true)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [selected, insetRight, insetBottom, revealSelection])

  /** The viewport moved (by hand or not): the flow dots hold still until it rests (infra-traffic.css). */
  const markMoving = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    if (el.dataset.moving === undefined) el.dataset.moving = ''
    if (movingTimer.current !== null) window.clearTimeout(movingTimer.current)
    movingTimer.current = window.setTimeout(() => {
      movingTimer.current = null
      delete el.dataset.moving
    }, MOVING_IDLE_MS)
  }, [])
  useEffect(
    () => () => {
      if (movingTimer.current !== null) window.clearTimeout(movingTimer.current)
    },
    [],
  )

  /**
   * The translations a glide may reach (per axis): at least a third of the map
   * (or of the canvas, whichever is smaller) stays on screen.
   */
  const glideRoom = useCallback(
    (vp: Viewport) => {
      const box = containerRef.current?.getBoundingClientRect()
      const all = flow.getNodes()
      if (!box || all.length === 0) return null
      const bounds = flow.getNodesBounds(all)
      const axis = (start: number, size: number, view: number): [number, number] => {
        const scaled = size * vp.zoom
        const keep = Math.min(scaled, view) / 3
        return [keep - scaled - start * vp.zoom, view - keep - start * vp.zoom]
      }
      return { x: axis(bounds.x, bounds.width, box.width), y: axis(bounds.y, bounds.height, box.height) }
    },
    [flow],
  )

  // The overlay's chips arrive after the map was fitted: fit again to take them
  // in, as long as the view is untouched. Keyed on the nodes React Flow was
  // given, so its store has the chips by the time the fit is measured.
  const hasChips = nodes.some((node) => node.type === 'client')
  useEffect(() => {
    if (!hasChips || viewTouched.current) return
    const frame = window.requestAnimationFrame(fitAll)
    return () => window.cancelAnimationFrame(frame)
  }, [hasChips, fitAll])

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
    // A box under a hand: the camera holds still.
    camera.stop()
    setHover(null)
    onInteractingChange(true)
  }, [camera, onInteractingChange])

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
      fitView: fitAll,
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
  }, [apiRef, fitAll, flow])

  const focusedPortId = selection?.type === 'node' ? (selection.portId ?? null) : null
  const view = useMemo<InfraView>(
    () => ({
      index,
      state: stateIndex,
      editing,
      showTraffic,
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
    [
      editing,
      focusedPortId,
      index,
      onAddPorts,
      onConnectDevice,
      onInteractingChange,
      onSelect,
      saveFrame,
      showTraffic,
      stateIndex,
    ],
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
              // A press on the map by hand (programmatic moves have no event)
              // stops any camera move or glide where it is (d3 interrupts it).
              // It is not a pan yet: d3 starts a gesture on every press, and the
              // end of a tap arrives in a timeout, after the click's reveal may
              // already have run. Only a view that moves counts (onMove).
              if (!event) return
              camera.stop()
              panSamples.current = []
            }}
            onMove={(event, viewport) => {
              markMoving()
              if (!event) return
              if (!userMoving.current) {
                userMoving.current = true
                markViewTouched()
              }
              // The finger's last stretch, for the glide after it lifts.
              if (!isTouch(event)) return
              const t = performance.now()
              const samples = panSamples.current
              samples.push({ ...viewport, t })
              while (samples.length > 2 && t - samples[0].t > 100) samples.shift()
            }}
            onMoveEnd={(event, viewport) => {
              const samples = panSamples.current
              panSamples.current = []
              if (!event) return
              userMoving.current = false
              // A flick-pan on a touch screen glides on and slows to a stop
              // (at most 900 ms); the next touch stops it.
              if (!isTouch(event) || prefersReducedMotion()) return
              const glide = planGlide(samples, performance.now(), viewport, glideRoom(viewport))
              if (glide) camera.glide(glide.velocity, glide.tau)
            }}
            fitView
            fitViewOptions={FIT_VIEW_OPTIONS}
            minZoom={MIN_ZOOM}
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
              showFitView={false}
              position="bottom-left"
              onZoomIn={markViewTouched}
              onZoomOut={markViewTouched}
            >
              {/* React Flow's own fit button, moving like every other camera move. */}
              <ControlButton
                className="react-flow__controls-fitview"
                title="Fit view"
                aria-label="Fit view"
                onClick={fitAll}
              >
                <FitViewIcon />
              </ControlButton>
            </Controls>
          </ReactFlow>
        </div>
        {hover ? <PortTooltip portId={hover.portId} anchor={hover.anchor} index={index} state={stateIndex} /> : null}
      </InfraOverlayContext.Provider>
    </InfraViewContext.Provider>
  )
}
