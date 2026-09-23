import { Graph, layout as dagreLayout } from '@dagrejs/dagre'
import { Devices, Globe, HardDrives, Network, Plugs, Rows, WifiHigh, type Icon } from '@phosphor-icons/react'
import { ApiError, apiErrorCode } from '@/lib/api'
import { portDisplayName } from '@/lib/attachment'
import { formatLastSeen } from '@/lib/collectors'
import { deviceTypeLabel } from '@/lib/device-labels'
import { connectionLabel, presenceDotClass, presenceLabel } from '@/lib/presence'
import type {
  DeviceAttachment,
  InfraBinding,
  InfraKindInfo,
  InfraLayoutResponse,
  InfraLink,
  InfraLinkMedium,
  InfraLinkState,
  InfraNode,
  InfraNodeKind,
  InfraNodeState,
  InfraNodeStatus,
  InfraPort,
  InfraPortMedium,
  InfraPortRole,
  InfraPortState,
  InfraStateResponse,
} from '@/types/api'

/**
 * Pure helpers for the infrastructure view (docs/infrastructure-view.md §8):
 * kind labels and icons, port LEDs and speeds, the geometry the node boxes
 * share with the layout, the dagre auto-layout, and the wording of the API's
 * refusals. Only the lazily loaded Infrastructure page imports this module, so
 * dagre stays out of the main bundle.
 */

// ── Kinds ────────────────────────────────────────────────────────────────

type KindMeta = {
  label: string
  Icon: Icon
  /** Upstream (0) to downstream: how the auto-layout orders a cable's ends. */
  rank: number
}

// Phosphor 2.1 has no `Router` glyph; `Network` is what the device list uses for
// "Router / gateway" (src/lib/device-labels.ts).
const KIND_META: Record<InfraNodeKind, KindMeta> = {
  isp: { label: 'ISP uplink', Icon: Globe, rank: 0 },
  modem: { label: 'Modem / ONT', Icon: Plugs, rank: 1 },
  router: { label: 'Router', Icon: Network, rank: 2 },
  gateway: { label: 'Gateway', Icon: Network, rank: 3 },
  host: { label: 'Host / hypervisor', Icon: HardDrives, rank: 3 },
  switch: { label: 'Switch', Icon: Rows, rank: 4 },
  access_point: { label: 'Access point', Icon: WifiHigh, rank: 5 },
  device: { label: 'Device', Icon: Devices, rank: 6 },
}

/** The API's label for a kind (its catalog), else ours. */
export function kindLabel(kind: InfraNodeKind, kinds?: InfraKindInfo[]): string {
  return kinds?.find((entry) => entry.kind === kind)?.label ?? KIND_META[kind]?.label ?? kind
}

/** Label and Phosphor glyph for a kind; render the glyph as `<meta.Icon />`. */
export function kindMeta(kind: InfraNodeKind): { label: string; Icon: Icon } {
  return KIND_META[kind] ?? { label: kind, Icon: Devices }
}

/** "Switch", or what a virtual one stands for. */
export function nodeKindWord(node: Pick<InfraNode, 'kind' | 'virtual'>, kinds?: InfraKindInfo[]): string {
  if (node.virtual && node.kind === 'switch') return 'Bridge / vSwitch'
  if (node.virtual && node.kind === 'host') return 'Virtual machine'
  return kindLabel(node.kind, kinds)
}

// ── Agents ───────────────────────────────────────────────────────────────

/** Which software sits behind a binding: the Gateway agent, the AP daemon, or a scrape. */
export function agentSoftware(binding: InfraBinding): string {
  if (binding.type === 'collector') return 'perch-collector'
  return binding.transport === 'scrape' ? 'node_exporter' : 'perch-apd'
}

/** "perch-apd 0.1.2", "perch-collector 1.0.0", "node_exporter". */
export function agentVersionLabel(binding: InfraBinding, version?: string | null): string {
  const software = agentSoftware(binding)
  const v = version ?? binding.version
  return v && software !== 'node_exporter' ? `${software} ${v}` : software
}

/** The node's agent cannot say which ports it has (too old, or a scrape). */
export function portsUnsupported(node: InfraNode): boolean {
  return node.binding !== null && node.binding.portsSupported !== true
}

/**
 * §8.5 "Old agents": why a bound node has no reported ports, or `null`. Holds
 * for `portsSupported: false` (an agent without the `ports` capability) and
 * `null` (not known yet: an AP that has not answered `system.info`, a collector
 * whose gateway reports carry no ports, which is also what `ports off` looks
 * like) alike (A3.7).
 */
export function oldAgentHint(node: InfraNode, version?: string | null): string | null {
  const binding = node.binding
  if (!binding || binding.portsSupported === true) return null
  if (binding.type === 'ap' && binding.transport === 'scrape') {
    return 'This access point is read over node_exporter, which does not report ports — install perch-apd, or add ports by hand'
  }
  return `This agent does not report ports yet — ${agentVersionLabel(binding, version)} · upgrade it or turn its ports option on, or add ports by hand`
}

/** The binding type a node of this kind can take, or `null` (manual-only kinds). */
export function bindingTypeFor(kind: InfraNodeKind): InfraBinding['type'] | null {
  if (kind === 'gateway') return 'collector'
  if (kind === 'access_point') return 'ap'
  return null
}

/**
 * A4.1: a device from Perch's list can be bound to every manual node except an
 * ISP line. Agent nodes (bound or detached) are their agent's.
 */
export function canBindDevice(node: InfraNode): boolean {
  return !node.binding && !node.detached && node.source === 'manual' && node.kind !== 'isp' && node.kind !== 'gateway'
}

/**
 * Boxes by the device MAC they are bound to (lowercase), hidden ones included:
 * one box per device (A4.2), so the pickers show these as placed.
 */
export function placedDevices(index: LayoutIndex): Map<string, InfraNode> {
  const placed = new Map<string, InfraNode>()
  for (const node of index.nodes.values()) {
    if (node.device) placed.set(node.device.mac.toLowerCase(), node)
  }
  return placed
}

// ── Status ───────────────────────────────────────────────────────────────

const NODE_STATUS_LABELS: Record<InfraNodeStatus, string> = {
  online: 'Online',
  stale: 'Stale',
  offline: 'Offline',
  unmanaged: 'Unmanaged',
  detached: 'Agent removed',
}

export function nodeStatusLabel(status: InfraNodeStatus): string {
  return NODE_STATUS_LABELS[status] ?? status
}

/** Status dot: good / warning / critical for agents, muted for unmanaged and detached nodes. */
export function nodeStatusDotClass(status: InfraNodeStatus | undefined): string {
  if (status === 'online') return 'bg-status-good'
  if (status === 'stale') return 'bg-status-warning'
  if (status === 'offline') return 'bg-status-critical'
  return 'bg-muted-foreground/40'
}

/** What the layout alone says before the first state poll lands. */
export function fallbackNodeStatus(node: InfraNode): InfraNodeStatus {
  if (node.detached) return 'detached'
  if (!node.binding) return 'unmanaged'
  return 'offline'
}

export type NodeSummary = {
  status: InfraNodeStatus
  /** Status dot; a box bound to a device uses the device's presence dot. */
  dotClass: string
  /** "perch-apd 1.0.0", "Switch · Unmanaged", "NAS / storage · Connected · Ethernet", "Agent removed". */
  subtitle: string
}

/** "Connected · Ethernet" or "Disconnected · last seen 2 h ago", as the Devices page says it. */
export function presenceWords(presence: InfraNodeState['presence']): string | null {
  if (!presence) return null
  return presence.status === 'connected'
    ? `${presenceLabel(true, presence.lastSeenAt)} · ${connectionLabel(presence.via)}`
    : presenceLabel(false, presence.lastSeenAt)
}

/** The dot and the one-line subtitle a box (and the inspector) shows under the name. */
export function nodeSummary(node: InfraNode, state: InfraNodeState | undefined, kinds?: InfraKindInfo[]): NodeSummary {
  const status = state?.status ?? fallbackNodeStatus(node)
  if (node.device) {
    // A box bound to a device from Perch's list (A4.2): "type · presence", as the Devices page says it.
    const presence = state?.presence ?? null
    const connected = presence?.status === 'connected'
    const where = presenceWords(presence)
    const what = deviceTypeLabel(node.device.deviceType) ?? nodeKindWord(node, kinds)
    return {
      status,
      dotClass: presence ? presenceDotClass(connected) : nodeStatusDotClass(status),
      subtitle: [what, where].filter(Boolean).join(' · '),
    }
  }
  const parts: string[] = []
  if (node.detached) {
    parts.push('Agent removed')
  } else if (node.binding) {
    parts.push(agentVersionLabel(node.binding, state?.version))
    if (status !== 'online') parts.push(nodeStatusLabel(status))
  } else {
    parts.push(node.model ?? nodeKindWord(node, kinds))
    parts.push('Unmanaged')
  }
  if (node.model && (node.binding || node.detached)) parts.push(node.model)
  return { status, dotClass: nodeStatusDotClass(status), subtitle: parts.join(' · ') }
}

// ── Speeds, media, LEDs ──────────────────────────────────────────────────

/** 10 → "10M", 1000 → "1G", 2500 → "2.5G", 10000 → "10G". */
export function formatPortSpeed(mbps: number | null | undefined): string | null {
  if (mbps === null || mbps === undefined || !Number.isFinite(mbps) || mbps <= 0) return null
  if (mbps >= 1000) {
    const gbps = mbps / 1000
    return `${Number.isInteger(gbps) ? gbps : Number(gbps.toFixed(1))}G`
  }
  return `${Math.round(mbps)}M`
}

export const PORT_MEDIUM_LABELS: Record<InfraPortMedium, string> = {
  copper: 'Copper',
  sfp: 'SFP',
  virtual: 'Virtual',
  wireless: 'Wireless',
}

export const LINK_MEDIUM_LABELS: Record<InfraLinkMedium, string> = {
  ethernet: 'Ethernet',
  fiber: 'Fiber',
  virtual: 'Virtual',
  wireless: 'Wireless',
}

export const PORT_ROLE_LABELS: Record<InfraPortRole, string> = { wan: 'WAN', lan: 'LAN' }

/**
 * One port LED: `fast` link at 1 Gb/s or more (or of unknown speed), `slow` at
 * 10/100 Mb/s, `down` no carrier, `unknown` nothing believable (a manual port
 * with no live far end, an offline agent), `missing` the agent stopped
 * reporting it.
 */
export type PortLed = 'fast' | 'slow' | 'down' | 'unknown' | 'missing'

export function portLed(port: InfraPort, state: InfraPortState | undefined): PortLed {
  if (!(state?.present ?? port.present)) return 'missing'
  if (!state) return 'unknown'
  const believable = state.live || state.derivedFrom !== null
  if (!believable || state.up === null) return 'unknown'
  if (!state.up) return 'down'
  if (state.speedMbps !== null && state.speedMbps < 1000) return 'slow'
  return 'fast'
}

/** The LED bar at the top of a port (Tailwind classes). */
export const PORT_LED_CLASSES: Record<PortLed, string> = {
  fast: 'bg-status-good',
  slow: 'bg-status-warning',
  down: 'bg-muted-foreground/40',
  unknown: 'border border-dashed border-muted-foreground/70 bg-transparent',
  missing: 'bg-transparent',
}

export const PORT_LED_LABELS: Record<PortLed, string> = {
  fast: 'Link at 1 Gb/s or faster',
  slow: 'Link at 10 or 100 Mb/s',
  down: 'No link',
  unknown: 'Unknown',
  missing: 'No longer reported',
}

/** "Up · 1G full duplex", "No link", "Disabled (admin down)", "Unknown: the agent is offline". */
export function portStateText(port: InfraPort, state: InfraPortState | undefined): string {
  const led = portLed(port, state)
  if (led === 'missing') {
    return port.missingSince
      ? `Missing: the agent stopped reporting it ${formatLastSeen(port.missingSince)}`
      : 'Missing: the agent stopped reporting it'
  }
  if (led === 'unknown') {
    if (port.origin === 'manual') return 'Unknown: no live agent port on the other end of its cable'
    if (state && state.up !== null) {
      const last = state.up ? `up${state.speedMbps ? ` at ${formatPortSpeed(state.speedMbps)}` : ''}` : 'no link'
      return `Unknown: the agent is not reporting right now (last reported ${last})`
    }
    return 'Unknown: the agent is not reporting right now'
  }
  if (led === 'down') {
    return state?.adminUp === false ? 'Disabled (admin down)' : 'No link'
  }
  const speed = formatPortSpeed(state?.speedMbps)
  const duplex = state?.duplex ? ` ${state.duplex} duplex` : ''
  const via = state?.derivedFrom !== null && state?.derivedFrom !== undefined ? ' (from the far end)' : ''
  return speed ? `Up · ${speed}${duplex}${via}` : `Up${via}`
}

export function linkStateText(state: InfraLinkState | undefined): string {
  if (!state) return 'Unknown'
  const speed = formatPortSpeed(state.speedMbps)
  if (state.state === 'up') return speed ? `Up · ${speed}` : 'Up'
  if (state.state === 'down') return 'Down'
  if (state.state === 'mismatch') {
    return state.detail === 'speed'
      ? 'Mismatch: the two ends report different speeds'
      : 'Mismatch: one end has a link, the other has none'
  }
  return 'Unknown'
}

export { portDisplayName }

// ── Indexes ──────────────────────────────────────────────────────────────

export type LayoutIndex = {
  nodes: Map<number, InfraNode>
  ports: Map<number, InfraPort>
  links: Map<number, InfraLink>
  /** Port id → the cable plugged into it. */
  linkByPort: Map<number, InfraLink>
  kinds: InfraKindInfo[]
  rootNodeId: number | null
}

export function buildLayoutIndex(layout: InfraLayoutResponse): LayoutIndex {
  const nodes = new Map<number, InfraNode>()
  const ports = new Map<number, InfraPort>()
  for (const node of layout.nodes) {
    nodes.set(node.id, node)
    for (const port of node.ports) ports.set(port.id, port)
  }
  const links = new Map<number, InfraLink>()
  const linkByPort = new Map<number, InfraLink>()
  for (const link of layout.links) {
    links.set(link.id, link)
    linkByPort.set(link.a.portId, link)
    linkByPort.set(link.b.portId, link)
  }
  return { nodes, ports, links, linkByPort, kinds: layout.kinds, rootNodeId: layout.rootNodeId }
}

export type StateIndex = {
  nodes: Map<number, InfraNodeState>
  ports: Map<number, InfraPortState>
  links: Map<number, InfraLinkState>
}

export function buildStateIndex(state: InfraStateResponse | undefined): StateIndex {
  return {
    nodes: new Map((state?.nodes ?? []).map((entry) => [entry.id, entry])),
    ports: new Map((state?.ports ?? []).map((entry) => [entry.id, entry])),
    links: new Map((state?.links ?? []).map((entry) => [entry.id, entry])),
  }
}

/** "Garage switch · port 3", or a placeholder for a port the layout does not have. */
export function describePort(index: LayoutIndex | null, portId: number): string {
  const port = index?.ports.get(portId)
  if (!port) return 'another port'
  const node = index?.nodes.get(port.nodeId)
  return node ? `${node.name} · ${portDisplayName(port)}` : portDisplayName(port)
}

/** "Garage switch · port 3 to AP-1 · wan". */
export function describeLink(index: LayoutIndex | null, linkId: number): string {
  const link = index?.links.get(linkId)
  if (!link) return 'a cable'
  return `${describePort(index, link.a.portId)} to ${describePort(index, link.b.portId)}`
}

/** The other end of a cable, seen from `portId`. */
export function otherEnd(link: InfraLink, portId: number): InfraLink['a'] {
  return link.a.portId === portId ? link.b : link.a
}

/** Ports of a node that carry a cable. */
export function cabledPortCount(node: InfraNode, index: LayoutIndex): number {
  return node.ports.filter((port) => index.linkByPort.has(port.id)).length
}

/**
 * Where a device-bound box plugs in, read off the map on the page: the A4
 * `DeviceAttachment` that `/devices/:mac/presence` would send. The uplink is
 * the cable of its cabled port with the lowest position; its link and speed
 * only when the far port is live (§7.3), as the API has it.
 */
export function attachmentOnMap(node: InfraNode, index: LayoutIndex, stateIndex: StateIndex): DeviceAttachment {
  const cabled = node.ports
    .filter((port) => index.linkByPort.has(port.id))
    .reduce<InfraPort | null>((lowest, port) => (lowest === null || port.position < lowest.position ? port : lowest), null)
  const link = cabled ? index.linkByPort.get(cabled.id) : undefined
  const far = link && cabled ? otherEnd(link, cabled.id) : null
  const farPort = far ? index.ports.get(far.portId) : undefined
  const farNode = far ? index.nodes.get(far.nodeId) : undefined
  if (!link || !farPort || !farNode) return { nodeId: node.id, nodeName: node.name, uplink: null }
  const state = stateIndex.ports.get(farPort.id)
  const live = state?.live ?? false
  return {
    nodeId: node.id,
    nodeName: node.name,
    uplink: {
      linkId: link.id,
      medium: link.medium,
      nodeId: farNode.id,
      nodeName: farNode.name,
      nodeKind: farNode.kind,
      portId: farPort.id,
      portKey: farPort.key,
      portLabel: farPort.label,
      live,
      up: live ? (state?.up ?? null) : null,
      speedMbps: live ? (state?.speedMbps ?? null) : null,
      duplex: live ? (state?.duplex ?? null) : null,
    },
  }
}

// ── Port keys ────────────────────────────────────────────────────────────

/** Same rule as the API (§3): what a netdev name looks like. */
export const PORT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,31}$/

/** "wan, lan1 lan2" → ["wan", "lan1", "lan2"], order kept, duplicates dropped. */
export function parsePortKeys(text: string): string[] {
  const keys = text
    .split(/[\s,]+/)
    .map((key) => key.trim())
    .filter(Boolean)
  return [...new Set(keys)]
}

/** `wan…` is a WAN port and `lan…` a LAN port, as the agents name them. */
export function inferPortRole(key: string): InfraPortRole | null {
  if (/^wan/i.test(key)) return 'wan'
  if (/^lan/i.test(key)) return 'lan'
  return null
}

function sequenceFor(kind: InfraNodeKind): (i: number) => string {
  switch (kind) {
    case 'access_point':
    case 'gateway':
    case 'router':
    case 'modem':
      // The names the agents report (LuCI's), so a pinned port is adopted on upgrade.
      return (i) => (i === 0 ? 'wan' : `lan${i}`)
    case 'switch':
      return (i) => String(i + 1)
    case 'isp':
      return (i) => (i === 0 ? 'uplink' : `uplink${i + 1}`)
    default:
      return (i) => `eth${i}`
  }
}

/**
 * Keys to prefill the "Add ports" form with: an old agent gets `wan, lan1`
 * (what it will report once upgraded), anything else its next free name.
 */
export function suggestPortKeys(node: InfraNode): string[] {
  const taken = new Set(node.ports.map((port) => port.key))
  const next = sequenceFor(node.kind)
  const count = node.ports.length === 0 && ['access_point', 'gateway', 'router', 'modem'].includes(node.kind) ? 2 : 1
  const keys: string[] = []
  for (let i = 0; keys.length < count && i < 128; i += 1) {
    const key = next(i)
    if (!taken.has(key)) keys.push(key)
  }
  return keys
}

// ── Geometry shared by the node components and the layout ────────────────

export const PORT_HEIGHT = 14
export const PORT_WIDTH = 18
export const SFP_PORT_WIDTH = 12
export const PORT_GAP = 4
/** More visible ports than this: two rows (odd on top, even below), labels on hover. */
export const ONE_ROW_MAX_PORTS = 12
export const WAN_CAPTION_WIDTH = 24
export const GROUP_SEPARATOR_WIDTH = 13
export const NODE_PADDING_X = 10
export const NODE_MIN_WIDTH = 184
/** The root box also carries the "Gateway agent" chip next to its name. */
const ROOT_MIN_WIDTH = 236
const NODE_MAX_WIDTH = 1200
/** Header (name + subtitle) of a device box, top border included. */
const NODE_HEADER_HEIGHT = 53
const STRIP_ONE_ROW_HEIGHT = 46
const STRIP_TWO_ROW_HEIGHT = 50
const HINT_HEIGHT = 64

export const HOST_HEADER_HEIGHT = 48
export const HOST_PADDING = 16
const HOST_MIN_WIDTH = 280
const HOST_MIN_HEIGHT = 150

export function visiblePorts(node: InfraNode): InfraPort[] {
  return node.ports.filter((port) => !port.hidden)
}

/** WAN ports first (the case's WAN socket, whatever it is used for), then the rest. */
export function splitPortGroups(ports: InfraPort[]): { wan: InfraPort[]; rest: InfraPort[] } {
  return {
    wan: ports.filter((port) => port.role === 'wan'),
    rest: ports.filter((port) => port.role !== 'wan'),
  }
}

export function portRectWidth(port: InfraPort): number {
  return port.medium === 'sfp' ? SFP_PORT_WIDTH : PORT_WIDTH
}

/** A one-row cell is as wide as its label (9 px mono), within bounds. */
export function portCellWidth(port: InfraPort, twoRows: boolean): number {
  if (twoRows) return PORT_WIDTH
  const label = Math.min(46, Math.ceil(port.label.length * 5.5) + 2)
  return Math.max(portRectWidth(port), label)
}

function groupWidth(ports: InfraPort[], twoRows: boolean): number {
  if (ports.length === 0) return 0
  if (twoRows) {
    const columns = Math.ceil(ports.length / 2)
    return columns * PORT_WIDTH + (columns - 1) * PORT_GAP
  }
  return ports.reduce((sum, port) => sum + portCellWidth(port, false), 0) + (ports.length - 1) * PORT_GAP
}

export function portStripWidth(ports: InfraPort[]): number {
  const twoRows = ports.length > ONE_ROW_MAX_PORTS
  const { wan, rest } = splitPortGroups(ports)
  let width = groupWidth(rest, twoRows)
  if (wan.length > 0) {
    width += WAN_CAPTION_WIDTH + groupWidth(wan, twoRows) + (rest.length > 0 ? GROUP_SEPARATOR_WIDTH : 0)
  }
  return width
}

/** The width a device box is drawn at (fixed, so the layout and the drawing agree). */
export function deviceNodeWidth(node: InfraNode): number {
  const strip = portStripWidth(visiblePorts(node))
  const min = node.isRoot ? ROOT_MIN_WIDTH : NODE_MIN_WIDTH
  return Math.min(NODE_MAX_WIDTH, Math.max(min, strip + 2 * NODE_PADDING_X + 2))
}

/**
 * How far a cable end is moved from its socket's edge to the box's edge, in
 * flow units, so a cable visibly leaves the box right under (or above) its
 * port instead of ending out of sight behind the box. Mirrors the markup of
 * `DeviceNode` (header 52 + borders, strip padding 8, labels 3 + 11) and
 * `HostNode` (ports centred in a 48 px header).
 */
export function portAnchorShift(index: LayoutIndex, portId: number, side: 'top' | 'bottom'): number {
  const port = index.ports.get(portId)
  const node = port ? index.nodes.get(port.nodeId) : undefined
  if (!port || !node) return 0
  const twoRows = visiblePorts(node).length > ONE_ROW_MAX_PORTS
  if (node.kind === 'host') {
    const strip = twoRows ? 2 * PORT_HEIGHT + PORT_GAP : PORT_HEIGHT + 14
    const top = 1 + (HOST_HEADER_HEIGHT - 1 - strip) / 2
    if (side === 'top') return top
    return HOST_HEADER_HEIGHT + 1 - (top + (twoRows ? strip : PORT_HEIGHT))
  }
  if (side === 'top') return NODE_HEADER_HEIGHT + 1 + 8
  return twoRows ? 9 : 23
}

/** Estimated height; React Flow measures the real one. */
export function deviceNodeHeight(node: InfraNode): number {
  const ports = visiblePorts(node)
  if (ports.length > ONE_ROW_MAX_PORTS) return NODE_HEADER_HEIGHT + STRIP_TWO_ROW_HEIGHT
  if (ports.length > 0) return NODE_HEADER_HEIGHT + STRIP_ONE_ROW_HEIGHT
  if (portsUnsupported(node)) return NODE_HEADER_HEIGHT + HINT_HEIGHT
  return NODE_HEADER_HEIGHT
}

function hostHeaderMinWidth(host: InfraNode): number {
  return 220 + portStripWidth(visiblePorts(host))
}

// ── Layout ───────────────────────────────────────────────────────────────

export type PlacedNode = {
  node: InfraNode
  /** The host frame this node is drawn in, or null. */
  parentId: number | null
  /** Top-left, relative to the parent when there is one (React Flow's convention). */
  position: { x: number; y: number }
  width: number
  height: number
  /** Laid out here, not stored: nothing has been written for it yet. */
  auto: boolean
}

export type MapLayout = {
  /** Parents before their children, as React Flow requires. */
  placed: PlacedNode[]
  /** Nodes not drawn because they, or the host they sit in, are hidden. */
  hiddenNodes: InfraNode[]
}

type Box = { id: number; width: number; height: number }
type Point = { x: number; y: number }

/** Upstream end first: the far side of a WAN port is upstream, then by kind. */
function orientLink(link: InfraLink, index: LayoutIndex): [number, number] {
  const aRole = index.ports.get(link.a.portId)?.role ?? null
  const bRole = index.ports.get(link.b.portId)?.role ?? null
  if (aRole === 'wan' && bRole !== 'wan') return [link.b.nodeId, link.a.nodeId]
  if (bRole === 'wan' && aRole !== 'wan') return [link.a.nodeId, link.b.nodeId]
  const aNode = index.nodes.get(link.a.nodeId)
  const bNode = index.nodes.get(link.b.nodeId)
  const aRank = aNode ? KIND_META[aNode.kind]?.rank ?? 9 : 9
  const bRank = bNode ? KIND_META[bNode.kind]?.rank ?? 9 : 9
  if (aRank !== bRank) return aRank < bRank ? [link.a.nodeId, link.b.nodeId] : [link.b.nodeId, link.a.nodeId]
  return link.a.nodeId < link.b.nodeId ? [link.a.nodeId, link.b.nodeId] : [link.b.nodeId, link.a.nodeId]
}

/**
 * Lays out `boxes`: the ones joined by `edges` as a top-down dagre tree, the
 * loose ones in rows under it (grouped by kind, upstream kinds first). Returns
 * top-left positions starting at (0, 0).
 */
function arrange(
  boxes: Box[],
  edges: Array<[number, number]>,
  rankOf: (id: number) => number,
): Map<number, Point> {
  const result = new Map<number, Point>()
  if (boxes.length === 0) return result
  const ids = new Set(boxes.map((box) => box.id))
  const linked = new Set<number>()
  const seen = new Set<string>()
  const graphEdges: Array<[number, number]> = []
  for (const [from, to] of edges) {
    if (from === to || !ids.has(from) || !ids.has(to)) continue
    const key = `${from}>${to}`
    if (seen.has(key)) continue
    seen.add(key)
    graphEdges.push([from, to])
    linked.add(from)
    linked.add(to)
  }

  let bottom = 0
  let left = 0
  if (linked.size > 0) {
    const graph = new Graph()
    graph.setGraph({ rankdir: 'TB', nodesep: 56, ranksep: 88, marginx: 0, marginy: 0 })
    graph.setDefaultEdgeLabel(() => ({}))
    for (const box of boxes) {
      if (linked.has(box.id)) graph.setNode(String(box.id), { width: box.width, height: box.height })
    }
    for (const [from, to] of graphEdges) graph.setEdge(String(from), String(to))
    dagreLayout(graph)
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    const centers = new Map<number, Point>()
    for (const box of boxes) {
      if (!linked.has(box.id)) continue
      const laid = graph.node(String(box.id)) as { x: number; y: number }
      const x = laid.x - box.width / 2
      const y = laid.y - box.height / 2
      centers.set(box.id, { x, y })
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
    }
    for (const box of boxes) {
      const at = centers.get(box.id)
      if (!at) continue
      const position = { x: Math.round(at.x - minX), y: Math.round(at.y - minY) }
      result.set(box.id, position)
      bottom = Math.max(bottom, position.y + box.height)
      left = 0
    }
    bottom += 72
  }

  // Loose boxes: one row per kind rank, wrapped at a readable width.
  const loose = boxes
    .filter((box) => !linked.has(box.id))
    .sort((a, b) => rankOf(a.id) - rankOf(b.id) || a.id - b.id)
  const maxRowWidth = 1100
  let x = left
  let y = bottom
  let rowHeight = 0
  let rowRank: number | null = null
  for (const box of loose) {
    const rank = rankOf(box.id)
    const wraps = x > left && x + box.width > left + maxRowWidth
    if ((rowRank !== null && rank !== rowRank && x > left) || wraps) {
      x = left
      y += rowHeight + 56
      rowHeight = 0
    }
    result.set(box.id, { x: Math.round(x), y: Math.round(y) })
    x += box.width + 48
    rowHeight = Math.max(rowHeight, box.height)
    rowRank = rank
  }
  return result
}

function boundsOf(entries: Array<{ position: Point; width: number; height: number }>) {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const entry of entries) {
    minX = Math.min(minX, entry.position.x)
    minY = Math.min(minY, entry.position.y)
    maxX = Math.max(maxX, entry.position.x + entry.width)
    maxY = Math.max(maxY, entry.position.y + entry.height)
  }
  return { minX, minY, maxX, maxY }
}

/**
 * Where every visible node is drawn. Stored positions win; unplaced nodes
 * (`position: null`, or all of them with `arrangeAll`) are laid out here with
 * dagre, under whatever is already placed, so nothing placed ever moves. Host
 * frames grow to hold their children (display only; nothing is written).
 */
export function computeMapLayout(
  layout: InfraLayoutResponse,
  index: LayoutIndex,
  options: { arrangeAll?: boolean } = {},
): MapLayout {
  const arrangeAll = options.arrangeAll ?? false
  const hostOf = (node: InfraNode): InfraNode | null => {
    if (node.parentId === null || node.kind === 'host') return null
    const parent = index.nodes.get(node.parentId)
    return parent && parent.kind === 'host' ? parent : null
  }

  const hiddenNodes: InfraNode[] = []
  const visible: InfraNode[] = []
  for (const node of layout.nodes) {
    const host = hostOf(node)
    if (node.hidden || host?.hidden) hiddenNodes.push(node)
    else visible.push(node)
  }
  const visibleIds = new Set(visible.map((node) => node.id))
  const rankOf = (id: number) => {
    const node = index.nodes.get(id)
    return node ? KIND_META[node.kind]?.rank ?? 9 : 9
  }

  const oriented = layout.links
    .filter((link) => visibleIds.has(link.a.nodeId) && visibleIds.has(link.b.nodeId))
    .map((link) => orientLink(link, index))

  const placed = new Map<number, PlacedNode>()
  const sizeOf = (node: InfraNode) => ({ width: deviceNodeWidth(node), height: deviceNodeHeight(node) })

  // Host frames first: their children decide how big they are.
  const hosts = visible.filter((node) => node.kind === 'host')
  const childrenOf = new Map<number, InfraNode[]>()
  for (const node of visible) {
    const host = hostOf(node)
    if (!host) continue
    const list = childrenOf.get(host.id) ?? []
    list.push(node)
    childrenOf.set(host.id, list)
  }
  const frameSize = new Map<number, { width: number; height: number }>()
  const contentTop = HOST_HEADER_HEIGHT + HOST_PADDING
  for (const host of hosts) {
    const children = childrenOf.get(host.id) ?? []
    const fixed = children.filter((child) => !arrangeAll && child.position !== null)
    const loose = children.filter((child) => arrangeAll || child.position === null)
    const entries: PlacedNode[] = fixed.map((child) => ({
      node: child,
      parentId: host.id,
      position: child.position!,
      ...sizeOf(child),
      auto: false,
    }))
    if (loose.length > 0) {
      const boxes = loose.map((child) => ({ id: child.id, ...sizeOf(child) }))
      const laid = arrange(boxes, oriented, rankOf)
      const start =
        entries.length > 0
          ? { x: boundsOf(entries).minX, y: boundsOf(entries).maxY + 32 }
          : { x: HOST_PADDING, y: contentTop }
      for (const child of loose) {
        const at = laid.get(child.id) ?? { x: 0, y: 0 }
        entries.push({
          node: child,
          parentId: host.id,
          position: { x: start.x + at.x, y: start.y + at.y },
          ...sizeOf(child),
          auto: true,
        })
      }
    }
    const content = entries.length > 0 ? boundsOf(entries) : null
    const width = Math.max(
      host.size?.width ?? 0,
      content ? content.maxX + HOST_PADDING : 0,
      hostHeaderMinWidth(host),
      HOST_MIN_WIDTH,
    )
    const height = Math.max(host.size?.height ?? 0, content ? content.maxY + HOST_PADDING : 0, HOST_MIN_HEIGHT)
    frameSize.set(host.id, { width, height })
    for (const entry of entries) placed.set(entry.node.id, entry)
  }

  // The top level: a child counts as its host frame.
  const roots = visible.filter((node) => hostOf(node) === null)
  const rootBox = (node: InfraNode) => frameSize.get(node.id) ?? sizeOf(node)
  const representative = (id: number) => {
    const node = index.nodes.get(id)
    const host = node ? hostOf(node) : null
    return host ? host.id : id
  }
  const rootEdges = oriented
    .map(([from, to]) => [representative(from), representative(to)] as [number, number])
    .filter(([from, to]) => from !== to)

  const fixedRoots: PlacedNode[] = roots
    .filter((node) => !arrangeAll && node.position !== null)
    .map((node) => ({ node, parentId: null, position: node.position!, ...rootBox(node), auto: false }))
  const looseRoots = roots.filter((node) => arrangeAll || node.position === null)
  if (looseRoots.length > 0) {
    const laid = arrange(
      looseRoots.map((node) => ({ id: node.id, ...rootBox(node) })),
      rootEdges,
      rankOf,
    )
    const start =
      fixedRoots.length > 0
        ? { x: boundsOf(fixedRoots).minX, y: boundsOf(fixedRoots).maxY + 96 }
        : { x: 0, y: 0 }
    for (const node of looseRoots) {
      const at = laid.get(node.id) ?? { x: 0, y: 0 }
      placed.set(node.id, {
        node,
        parentId: null,
        position: { x: start.x + at.x, y: start.y + at.y },
        ...rootBox(node),
        auto: true,
      })
    }
  }
  for (const entry of fixedRoots) placed.set(entry.node.id, entry)

  // React Flow wants every parent before its children.
  const ordered = [...placed.values()].sort((a, b) => {
    const aChild = a.parentId === null ? 0 : 1
    const bChild = b.parentId === null ? 0 : 1
    return aChild - bChild || a.node.id - b.node.id
  })
  return { placed: ordered, hiddenNodes }
}

// ── API refusals, in words ───────────────────────────────────────────────

function bodyOf(error: unknown): Record<string, unknown> {
  if (!(error instanceof ApiError)) return {}
  return typeof error.body === 'object' && error.body !== null ? (error.body as Record<string, unknown>) : {}
}

function numberField(body: Record<string, unknown>, key: string): number | null {
  const value = body[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * The box a 409 `infra_device_already_placed` names (A4.2), so the form that
 * got it can offer to show that box; null for any other failure.
 */
export function placedRefusalNodeId(error: unknown): number | null {
  if (apiErrorCode(error) !== 'infra_device_already_placed') return null
  return numberField(bodyOf(error), 'nodeId')
}

/** Vine's `{ errors: [{ field, message }] }`, as one sentence. */
function vineMessage(body: Record<string, unknown>): string | null {
  const errors = body.errors
  if (!Array.isArray(errors) || errors.length === 0) return null
  const messages = errors
    .map((entry) => (typeof entry === 'object' && entry !== null && 'message' in entry ? String(entry.message) : null))
    .filter((message): message is string => Boolean(message))
  return messages.length > 0 ? messages.join(' ') : null
}

/** "port 3 and port 4" from the `ports` a 409 names, when it names them. */
function portList(body: Record<string, unknown>, index: LayoutIndex | null): string | null {
  const ports = body.ports
  if (!Array.isArray(ports) || ports.length === 0) return null
  const names = ports.map((entry) => {
    if (typeof entry === 'number') return index?.ports.get(entry) ? portDisplayName(index.ports.get(entry)!) : `#${entry}`
    if (typeof entry === 'string') return /^\d+$/.test(entry) ? `port ${entry}` : entry
    if (typeof entry === 'object' && entry !== null) {
      const record = entry as Record<string, unknown>
      if (typeof record.label === 'string') return portDisplayName({ label: record.label })
      if (typeof record.key === 'string') return portDisplayName({ label: record.key })
      if (typeof record.id === 'number' && index?.ports.get(record.id)) return portDisplayName(index.ports.get(record.id)!)
    }
    return null
  })
  const known = names.filter((name): name is string => Boolean(name))
  if (known.length === 0) return null
  return known.length === 1 ? known[0] : `${known.slice(0, -1).join(', ')} and ${known[known.length - 1]}`
}

/**
 * What to tell the admin when the API refuses a change (Appendix B), using
 * the loaded layout to name devices, ports and cables. `context` carries what
 * the request was about when the response does not say.
 */
export function infraErrorMessage(
  error: unknown,
  index: LayoutIndex | null,
  fallback: string,
  context: { portIds?: number[]; nodeId?: number } = {},
): string {
  const code = apiErrorCode(error)
  const body = bodyOf(error)
  const serverMessage = typeof body.message === 'string' ? body.message : null
  switch (code) {
    case 'infra_port_busy': {
      const portId = numberField(body, 'portId') ?? context.portIds?.[0] ?? null
      const linkId = numberField(body, 'linkId')
      const port = portId !== null ? describePort(index, portId) : 'That port'
      const link = linkId !== null ? index?.links.get(linkId) : undefined
      if (link && portId !== null) {
        return `${port} already has a cable, to ${describePort(index, otherEnd(link, portId).portId)}. Remove that cable first, or drag its end to another port.`
      }
      return `${port} already has a cable. Remove that cable first, or drag its end to another port.`
    }
    case 'infra_port_hidden':
      return 'That port is hidden. Show it again on its device before you cable it.'
    case 'infra_link_same_node': {
      const portId = context.portIds?.[0]
      const node = portId !== undefined ? index?.nodes.get(index.ports.get(portId)?.nodeId ?? -1) : undefined
      return `Both ends are on ${node ? node.name : 'the same device'}. A cable joins two different devices.`
    }
    case 'infra_link_same_port':
      return 'A cable needs two different ports.'
    case 'infra_port_not_found':
      return 'That port no longer exists; the map has been reloaded.'
    case 'infra_link_not_found':
      return 'That cable is already gone.'
    case 'infra_node_not_found':
      return 'That device is no longer on the map; it has been reloaded.'
    case 'infra_node_bound': {
      const binding = body.binding as { type?: string; id?: number } | undefined
      const node = context.nodeId !== undefined ? index?.nodes.get(context.nodeId) : undefined
      const name = node?.binding?.name ?? node?.name ?? 'this agent'
      if (binding?.type === 'collector' || node?.binding?.type === 'collector') {
        return `This is the Gateway agent ${name}: deleted here, it would come straight back. Remove the collector in Settings → Collectors, or hide it here.`
      }
      return `This is the AP ${name}: deleted here, it would come straight back. Remove it in Settings → Wi-Fi sources, or hide it here.`
    }
    case 'infra_node_already_bound':
      return 'This device is already bound to an agent.'
    case 'infra_device_already_placed': {
      // A4.2: one box per device. Name the box that has it when the loaded map knows it.
      const nodeId = numberField(body, 'nodeId')
      const holder = nodeId !== null ? index?.nodes.get(nodeId) : undefined
      if (holder) {
        return `That device is already on the map, as ${holder.name}${holder.hidden ? ' (hidden)' : ''}. A device has one box; use that one.`
      }
      return 'That device is already on the map. A device has one box; use that one.'
    }
    case 'infra_agent_node_has_links':
      return "That agent's own device on the map still has cables. Delete it or move its cables first, then bind."
    case 'infra_binding_not_found':
      return 'That agent no longer exists.'
    case 'infra_binding_kind_mismatch':
      return 'An access point binds to an AP, and a gateway to a collector.'
    case 'infra_kind_not_manual':
      return 'The Gateway agent adds its own device; add a router instead.'
    case 'infra_parent_invalid':
      return 'Only a host holds other devices, one level deep: a host cannot go inside another host.'
    case 'infra_field_not_applicable': {
      const field = typeof body.field === 'string' ? body.field : null
      // A4.4: `linkTo` on a node that has no port to cable.
      if (field === 'linkTo') return 'The new box has no port to cable, so it cannot be connected.'
      const words: Record<string, string> = {
        portCount: 'A port count',
        sfpPorts: 'SFP ports',
        size: 'A frame size',
        virtual: 'Virtual',
        deviceMac: 'A device from the list',
        parentId: 'Inside host',
      }
      return field && words[field]
        ? `${words[field]} does not apply to this kind of device.`
        : 'That setting does not apply to this kind of device.'
    }
    case 'infra_port_has_link': {
      const names = portList(body, index)
      if (!names) return 'That port has a cable. Remove the cable first.'
      const several = names.includes(' and ')
      // One port whose cable the layout knows: say where it goes.
      const only = Array.isArray(body.ports) && body.ports.length === 1 ? (body.ports[0] as Record<string, unknown>) : null
      const link = only && typeof only.linkId === 'number' ? index?.links.get(only.linkId) : undefined
      const to = link && typeof only?.id === 'number' ? `, to ${describePort(index, otherEnd(link, only.id).portId)}` : ''
      return `${names[0].toUpperCase()}${names.slice(1)} ${several ? 'have cables' : `has a cable${to}`}. Remove ${several ? 'them' : 'it'} first.`
    }
    case 'infra_port_present':
      return 'The agent still reports this port, so it cannot be deleted. Hide it instead.'
    case 'infra_port_key_taken':
    case 'infra_port_key_duplicate': {
      const key = typeof body.key === 'string' ? body.key : null
      return key ? `A port named "${key}" already exists on this device.` : 'Port names must be unique on a device.'
    }
    case 'infra_port_key_immutable':
      return 'The agent names this port; only its label can change.'
    case 'infra_limit_reached': {
      const max = numberField(body, 'max')
      if (body.limit === 'nodes') return `The map holds at most ${max ?? 200} devices.`
      if (body.limit === 'ports') return `A device has at most ${max ?? 64} ports.`
      if (body.limit === 'links') return `The map holds at most ${max ?? 400} cables.`
      return serverMessage ?? 'The map is full.'
    }
    case 'admin_required':
      return 'Only admins can change the map.'
    default:
      break
  }
  if (error instanceof ApiError) {
    if (error.status === 403) return 'Only admins can change the map.'
    if (error.status === 422) return vineMessage(body) ?? serverMessage ?? fallback
    return serverMessage ?? error.message ?? fallback
  }
  return fallback
}
