import { formatBytes } from '@/lib/format-bytes'
import type { LayoutIndex } from '@/lib/infra'
import { formatBps } from '@/lib/networks'
import type { InfraLink, InfraLinkTraffic, InfraPortTraffic, InfraTrafficScope } from '@/types/api'

/**
 * Port and cable traffic on the map (docs/infrastructure-view.md A6): the live
 * rates `/infra/state` carries on ports and cables, and the accounting reads
 * behind the inspector. Rates are bits per second, totals bytes. Only type
 * imports from `lib/infra` (and its dagre): `hooks/use-infra` uses the window
 * helpers and is imported outside the infrastructure page.
 */

export { formatBps as formatTrafficRate }

export function formatTrafficBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—'
  return formatBytes(Math.max(0, bytes))
}

/** The accounting windows the inspector offers. */
export type TrafficSpan = '24h' | '7d' | '30d'

export const TRAFFIC_SPANS: Array<{ id: TrafficSpan; label: string; title: string; seconds: number }> = [
  { id: '24h', label: '24 h', title: 'The last 24 hours', seconds: 86_400 },
  { id: '7d', label: '7 d', title: 'The last 7 days', seconds: 7 * 86_400 },
  { id: '30d', label: '30 d', title: 'The last 30 days', seconds: 30 * 86_400 },
]

/** `from` / `to` of a span ending now, as the traffic reads take them. */
export function trafficWindowQuery(span: TrafficSpan): string {
  const seconds = TRAFFIC_SPANS.find((entry) => entry.id === span)?.seconds ?? 86_400
  const to = new Date()
  const from = new Date(to.getTime() - seconds * 1000)
  return new URLSearchParams({ from: from.toISOString(), to: to.toISOString() }).toString()
}

/** How often a span's accounting is read again while it is on screen. */
export function trafficRefetchMs(span: TrafficSpan): number {
  return span === '24h' ? 60_000 : 300_000
}

/** Below this a port or cable counts as quiet (ARP, mDNS and the agents' own chatter stay under it). */
export const ACTIVE_BPS = 2_000
/**
 * A port or cable that moves traffic goes quiet again only below this, so one
 * idling around 2 kbps does not switch its light or dashes on and off every poll.
 */
export const QUIET_BPS = 1_000

/** Whether a rate counts as traffic now, given whether it did at the last reading. */
export function trafficMoving(bps: number, wasMoving: boolean): boolean {
  return bps >= (wasMoving ? QUIET_BPS : ACTIVE_BPS)
}

export function portBps(traffic: InfraPortTraffic): number {
  return traffic.rxBps + traffic.txBps
}

/** The busier direction of a cable's rates. */
export function linkPeakBps(traffic: InfraLinkTraffic): number {
  return Math.max(traffic.aToBBps, traffic.bToABps)
}

/**
 * The step of a rate among ascending `bounds` (0 below the first). A step up
 * happens at its bound, a step down only 20 % under it, so a rate hovering at
 * a bound keeps its step instead of flipping every poll.
 */
export function rateStep(bps: number, bounds: readonly number[], previous: number | null): number {
  const count = (factor: number) => bounds.filter((bound) => bps >= bound * factor).length
  const step = count(1)
  if (previous === null || step >= previous) return step
  return Math.min(previous, count(0.8))
}

/** Cable stroke width steps: 2 px under 1 Mbps, then 3 / 4 / 5 / 6 px from 1 / 10 / 100 / 1000 Mbps. */
const WIDTH_BOUNDS_BPS = [1e6, 1e7, 1e8, 1e9] as const
/** Flow speed steps from 100 kbps, 10 Mbps and 100 Mbps. */
const FLOW_BOUNDS_BPS = [1e5, 1e7, 1e8] as const
/** One lap of the flow dots (two dot periods) per step: a trickle crawls, a busy link runs. */
export const FLOW_LAP_SECONDS = [2.4, 1.6, 1.0, 0.6] as const
/** Blink speed steps from 100 kbps and 10 Mbps. */
const BLINK_BOUNDS_BPS = [1e5, 1e7] as const
/** The port activity light's blink period per step. */
export const BLINK_SECONDS = [1.2, 0.6, 0.3] as const

export function strokeWidthForStep(step: number): number {
  return 2 + step
}

/**
 * What a cable's traffic shows, worked out from this reading and the last
 * state (hysteresis everywhere, so a 5 s poll rarely changes anything):
 * whether its dots run (on at 2 kbps, off under 1 kbps), which way (the busier
 * direction; turning needs the other one moving and 1.25× busier, so a
 * balanced link keeps its direction), and its speed and width steps. The same
 * reading gives the same state back, object for object.
 */
export type CableFlow = { moving: boolean; reverse: boolean; speed: number; width: number }

export function nextCableFlow(traffic: InfraLinkTraffic | null, previous: CableFlow | null): CableFlow {
  const peak = traffic ? linkPeakBps(traffic) : 0
  const moving = trafficMoving(peak, previous?.moving ?? false)
  let reverse = previous?.reverse ?? false
  if (traffic && moving) {
    if (!previous?.moving) {
      // Nothing was running: start in the busier direction.
      reverse = traffic.bToABps > traffic.aToBBps
    } else {
      const current = reverse ? traffic.bToABps : traffic.aToBBps
      const other = reverse ? traffic.aToBBps : traffic.bToABps
      if (other >= ACTIVE_BPS && other >= current * 1.25) reverse = !reverse
    }
  }
  const next = {
    moving,
    reverse,
    speed: rateStep(peak, FLOW_BOUNDS_BPS, previous?.moving ? previous.speed : null),
    width: moving ? rateStep(peak, WIDTH_BOUNDS_BPS, previous?.moving ? previous.width : null) : 0,
  }
  if (
    previous &&
    previous.moving === next.moving &&
    previous.reverse === next.reverse &&
    previous.speed === next.speed &&
    previous.width === next.width
  ) {
    return previous
  }
  return next
}

/** A port's activity light: whether it blinks (the same hysteresis as a cable), and its speed step. */
export type PortBlink = { moving: boolean; speed: number }

export function nextPortBlink(traffic: InfraPortTraffic | null, previous: PortBlink | null): PortBlink {
  const bps = traffic ? portBps(traffic) : 0
  const moving = trafficMoving(bps, previous?.moving ?? false)
  const speed = rateStep(bps, BLINK_BOUNDS_BPS, previous?.moving ? previous.speed : null)
  if (previous && previous.moving === moving && previous.speed === speed) return previous
  return { moving, speed }
}

export const SCOPE_LABELS: Record<InfraTrafficScope, string> = {
  port: 'Port counters',
  cpu: 'CPU only',
}

/** Why a `cpu` reading or a `partial` cable may be low. */
export const CPU_ONLY_EXPLANATION =
  'This switch does not expose byte counters Perch can read, so only what the device itself sent or received is counted: frames its switch forwards between two of its ports are missing.'

/**
 * Node id → hops from the Gateway agent's box, over cables and "inside host"
 * frames. Nodes with no path to it are absent.
 */
export function nodeDepths(index: LayoutIndex): Map<number, number> {
  const depths = new Map<number, number>()
  const root = index.rootNodeId
  if (root === null || !index.nodes.has(root)) return depths
  const neighbours = new Map<number, number[]>()
  const join = (a: number, b: number) => {
    neighbours.set(a, [...(neighbours.get(a) ?? []), b])
    neighbours.set(b, [...(neighbours.get(b) ?? []), a])
  }
  for (const link of index.links.values()) join(link.a.nodeId, link.b.nodeId)
  for (const node of index.nodes.values()) if (node.parentId !== null) join(node.id, node.parentId)
  depths.set(root, 0)
  const queue = [root]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const next of neighbours.get(current) ?? []) {
      if (depths.has(next)) continue
      depths.set(next, depths.get(current)! + 1)
      queue.push(next)
    }
  }
  return depths
}

/**
 * A cable's two directions, ordered away from the gateway first ("down", drawn
 * in the download colour) and towards it second ("up"). When neither end is
 * nearer the gateway, a → b counts as down.
 */
export type CableDirections = {
  down: { from: InfraLink['a']; to: InfraLink['a']; key: 'aToB' | 'bToA' }
  up: { from: InfraLink['a']; to: InfraLink['a']; key: 'aToB' | 'bToA' }
}

export function cableDirections(link: InfraLink, depths: Map<number, number>): CableDirections {
  const da = depths.get(link.a.nodeId)
  const db = depths.get(link.b.nodeId)
  const bUpstream = da !== undefined && db !== undefined ? db < da : da === undefined && db !== undefined
  const aToB = { from: link.a, to: link.b, key: 'aToB' as const }
  const bToA = { from: link.b, to: link.a, key: 'bToA' as const }
  return bUpstream ? { down: bToA, up: aToB } : { down: aToB, up: bToA }
}

/** "RAX-1F" (a node's name), or a placeholder for one the layout lacks. */
export function endNodeName(index: LayoutIndex, end: InfraLink['a']): string {
  return index.nodes.get(end.nodeId)?.name ?? 'another device'
}

/** The rate of one direction of a cable. */
export function directionBps(traffic: InfraLinkTraffic, key: 'aToB' | 'bToA'): number {
  return key === 'aToB' ? traffic.aToBBps : traffic.bToABps
}

/** "RAX-1F → Garage AP 840 kbps · Garage AP → RAX-1F 1.50 Mbps", for titles and the table. */
export function linkTrafficText(index: LayoutIndex, link: InfraLink, traffic: InfraLinkTraffic | null | undefined): string {
  if (!traffic) return '—'
  const a = endNodeName(index, link.a)
  const b = endNodeName(index, link.b)
  const parts = [`${a} → ${b} ${formatBps(traffic.aToBBps)}`, `${b} → ${a} ${formatBps(traffic.bToABps)}`]
  return traffic.partial ? `${parts.join(' · ')} (CPU only)` : parts.join(' · ')
}

/** "↓ 1.50 Mbps received · ↑ 64 kbps sent", from the port's side. */
export function portTrafficText(traffic: InfraPortTraffic): string {
  return `↓ ${formatBps(traffic.rxBps)} received · ↑ ${formatBps(traffic.txBps)} sent`
}
