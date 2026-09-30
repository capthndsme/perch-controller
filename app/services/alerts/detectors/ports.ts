import { getPresenceSettings } from '#services/presence_settings'
import type { ConditionInput, DetectorContext, ParamValue } from '#services/alerts/model'
import { registerDetector } from '#services/alerts/registry'
import {
  ISO_FORMAT,
  liveAlerts,
  liveApIds,
  liveCollectorIds,
  loadApLiveness,
  loadCollectorLiveness,
  parseJsonObject,
  rawRows,
  toNumberOrNull,
} from '#services/alerts/detectors/liveness'
import db from '@adonisjs/lucid/services/db'

/**
 * Detector `ports` (WP-A5b, events.md section 3.4), every 15 s, over agent
 * ports (`infra_ports.origin = 'agent'`, `present = 1`) of nodes bound to an
 * online agent: a silent agent's ports are unknown, not down (the map's rule),
 * and their live alerts are left as they are.
 *
 * - `port.down`: no carrier (or operstate `down` / `lowerlayerdown` when the
 *   agent does not report carrier) on a port in scope: `cabled` (a cable on
 *   the map, or the uplink role) by default, or `all`.
 * - `port.flapping`: the cumulative `carrier_changes` rose by `changes` or
 *   more within `windowMinutes`; clears once it has not moved for a window. A
 *   decrease is a counter reset (the agent rebooted): re-baseline, no event.
 *   The kernel counts flaps faster than any report, so this is its own
 *   condition, not the engine's flap damping.
 * - `port.speed_degraded` (off by default): a cabled port with link runs
 *   below the highest speed it had in the last 7 days (1000 → 100 Mb/s is
 *   usually a damaged pair).
 *
 * Baselines live in memory (at most `MAX_PORTS`), seeded at the first tick
 * from what was persisted, and persisted every 5 minutes to the detector's
 * state (`carrier:<portId>`) so a restart does not lose a window.
 */

export const DOWN_TYPE = 'port.down'
export const FLAP_TYPE = 'port.flapping'
export const SPEED_TYPE = 'port.speed_degraded'

export const MAX_PORTS = 4096
export const MAX_SAMPLES = 256
export const PERSIST_EVERY_MS = 5 * 60_000
export const SPEED_MEMORY_MS = 7 * 86_400_000
/** The highest speed's time is refreshed at most this often (keeps the baseline from changing every tick). */
const SPEED_REFRESH_MS = 3_600_000
const DETECTOR_ID = 'ports'
const SOURCE = 'detector:ports'

export const portKey = (type: string, portId: number) => `${type}:port:${portId}`

export type PortBaseline = {
  /** Last counter seen; null while the agent does not report one. */
  value: number | null
  /** [epoch ms, counter] at each rise (and the first observation), oldest first. */
  samples: Array<[number, number]>
  /** When the counter last rose, epoch ms; null since the last (re)baseline. */
  lastMoveAt: number | null
  /** Last speed reported with link, and the highest in the last 7 days. */
  lastSpeed: number | null
  maxSpeed: number | null
  maxSpeedAt: number | null
  /** The degraded speed already notified (null while at full speed). */
  notifiedSpeed: number | null
  /** When this baseline was last written to the state, epoch ms. */
  persistedAt: number | null
}

export function newBaseline(counter: number | null, nowMs: number): PortBaseline {
  return {
    value: counter,
    samples: counter === null ? [] : [[nowMs, counter]],
    lastMoveAt: null,
    lastSpeed: null,
    maxSpeed: null,
    maxSpeedAt: null,
    notifiedSpeed: null,
    persistedAt: null,
  }
}

/**
 * Records one reading of the cumulative counter and returns how much it rose
 * within the window. Mutates `baseline`.
 */
export function observeCounter(
  baseline: PortBaseline,
  counter: number,
  nowMs: number,
  windowMs: number
): { rise: number; reset: boolean } {
  if (baseline.value === null) {
    // First counter (an agent that just started reporting it): a baseline, not a rise.
    baseline.value = counter
    baseline.samples = [[nowMs, counter]]
    return { rise: 0, reset: false }
  }
  if (counter < baseline.value) {
    // Counter reset: the agent (or its interface) restarted.
    baseline.value = counter
    baseline.samples = [[nowMs, counter]]
    baseline.lastMoveAt = null
    return { rise: 0, reset: true }
  }
  if (counter > baseline.value) {
    baseline.value = counter
    baseline.samples.push([nowMs, counter])
    baseline.lastMoveAt = nowMs
  }
  // Keep the samples inside the window plus the last one before it (the
  // counter's value when the window opened).
  const start = nowMs - windowMs
  let firstInside = baseline.samples.findIndex(([at]) => at > start)
  if (firstInside === -1) firstInside = baseline.samples.length
  if (firstInside > 1) baseline.samples = baseline.samples.slice(firstInside - 1)
  if (baseline.samples.length > MAX_SAMPLES) {
    baseline.samples = baseline.samples.slice(baseline.samples.length - MAX_SAMPLES)
  }
  const reference = baseline.samples[0][1]
  return { rise: counter - reference, reset: false }
}

/**
 * Flapping holds while the counter rose by `changes` within the window, and,
 * once raised, until it has not moved for a whole window.
 */
export function flappingHolds(input: {
  rise: number
  changes: number
  lastMoveAt: number | null
  nowMs: number
  windowMs: number
  wasHolding: boolean
}): boolean {
  if (input.rise >= input.changes) return true
  return (
    input.wasHolding && input.lastMoveAt !== null && input.nowMs - input.lastMoveAt < input.windowMs
  )
}

/** No link: carrier 0, or (carrier unknown) operstate down / lowerlayerdown. */
export function portIsDown(carrier: boolean | null, operstate: string | null): boolean {
  if (carrier !== null) return !carrier
  return operstate === 'down' || operstate === 'lowerlayerdown'
}

/**
 * Tracks the port's speed; returns the speed it degraded from when a notice
 * is due (once per degraded speed), else null. Mutates `baseline`.
 */
export function observeSpeed(
  baseline: PortBaseline,
  speed: number | null,
  linkUp: boolean,
  nowMs: number
): number | null {
  if (!linkUp || speed === null || speed <= 0) return null
  baseline.lastSpeed = speed
  if (
    baseline.maxSpeed === null ||
    baseline.maxSpeedAt === null ||
    nowMs - baseline.maxSpeedAt > SPEED_MEMORY_MS ||
    speed > baseline.maxSpeed
  ) {
    baseline.maxSpeed = speed
    baseline.maxSpeedAt = nowMs
    baseline.notifiedSpeed = null
    return null
  }
  if (speed === baseline.maxSpeed) {
    if (nowMs - baseline.maxSpeedAt > SPEED_REFRESH_MS) baseline.maxSpeedAt = nowMs
    baseline.notifiedSpeed = null
    return null
  }
  if (baseline.notifiedSpeed === speed) return null
  baseline.notifiedSpeed = speed
  return baseline.maxSpeed
}

// ── in-process state (bounded) ─────────────────────────────────────────────

const baselines = new Map<number, PortBaseline>()
/** What each baseline looked like when last persisted (only changed ones are written). */
const persistedSignatures = new Map<number, string>()
let seeded = false
let lastPersistMs = 0

/** Tests only. */
export function _resetPortsDetectorState(): void {
  baselines.clear()
  persistedSignatures.clear()
  seeded = false
  lastPersistMs = 0
}

function signature(b: PortBaseline): string {
  return [
    b.value,
    b.samples.length,
    b.samples.at(-1)?.[0],
    b.lastMoveAt,
    b.lastSpeed,
    b.maxSpeed,
    b.maxSpeedAt,
    b.notifiedSpeed,
  ].join('|')
}

/** Tests only: the in-memory baseline of a port. */
export function _portBaseline(portId: number): PortBaseline | undefined {
  return baselines.get(portId)
}

function remember(portId: number, baseline: PortBaseline) {
  baselines.delete(portId)
  baselines.set(portId, baseline)
  while (baselines.size > MAX_PORTS) {
    const oldest = baselines.keys().next().value as number
    baselines.delete(oldest)
    persistedSignatures.delete(oldest)
  }
}

/** Baselines persisted before the restart, by port id (one read at the first tick). */
async function loadPersisted(): Promise<Map<number, PortBaseline>> {
  const rows = (await db
    .from('alert_detector_states')
    .where('detector', DETECTOR_ID)
    .where('state_key', 'like', 'carrier:%')
    .select('state_key', 'value')) as Array<{ state_key: string; value: string }>
  const out = new Map<number, PortBaseline>()
  for (const row of rows) {
    const id = Number(row.state_key.slice('carrier:'.length))
    const value = parseJsonObject(row.value) as PortBaseline | null
    if (
      Number.isInteger(id) &&
      value &&
      (typeof value.value === 'number' || value.value === null) &&
      Array.isArray(value.samples)
    ) {
      out.set(id, value)
    }
  }
  return out
}

/**
 * The baseline to continue from after a restart: the persisted one when it
 * still covers the window and the counter did not go backwards meanwhile;
 * else a fresh one at the current value (whatever moved while the controller
 * was down cannot be dated, so it is not counted).
 */
export function resumeBaseline(
  persisted: PortBaseline | undefined,
  counter: number | null,
  nowMs: number,
  windowMs: number
): PortBaseline {
  const fresh = newBaseline(counter, nowMs)
  if (!persisted || persisted.persistedAt === null) return fresh
  if (
    nowMs - persisted.persistedAt > windowMs ||
    counter === null ||
    persisted.value === null ||
    counter < persisted.value
  ) {
    return {
      ...fresh,
      lastSpeed: persisted.lastSpeed,
      maxSpeed: persisted.maxSpeed,
      maxSpeedAt: persisted.maxSpeedAt,
      notifiedSpeed: persisted.notifiedSpeed,
    }
  }
  return { ...persisted, samples: persisted.samples.slice(-MAX_SAMPLES) }
}

// ── I/O ────────────────────────────────────────────────────────────────────

type PortRow = {
  id: number
  nodeId: number
  nodeName: string | null
  apId: number | null
  collectorId: number | null
  portKey: string
  label: string | null
  role: string | null
  carrier: boolean | null
  operstate: string | null
  carrierChanges: number | null
  speedMbps: number | null
  since: string | null
}

async function loadAgentPorts(): Promise<PortRow[]> {
  const rows = rawRows<Record<string, unknown>>(
    await db.rawQuery(
      `SELECT p.id, p.node_id AS nodeId, n.name AS nodeName, n.ap_id AS apId,
              n.collector_id AS collectorId, p.port_key AS portKey,
              COALESCE(p.label, p.reported_label) AS label,
              COALESCE(p.role, p.reported_role) AS role,
              p.carrier, p.operstate, p.carrier_changes AS carrierChanges,
              p.speed_mbps AS speedMbps,
              DATE_FORMAT(p.state_changed_at, ${ISO_FORMAT}) AS since
         FROM infra_ports p
         JOIN infra_nodes n ON n.id = p.node_id
        WHERE p.origin = 'agent' AND p.present = 1
          AND (n.ap_id IS NOT NULL OR n.collector_id IS NOT NULL)
        ORDER BY p.id`
    )
  )
  return rows.map((row) => ({
    id: Number(row.id),
    nodeId: Number(row.nodeId),
    nodeName: (row.nodeName as string | null) ?? null,
    apId: toNumberOrNull(row.apId),
    collectorId: toNumberOrNull(row.collectorId),
    portKey: String(row.portKey),
    label: (row.label as string | null) ?? null,
    role: (row.role as string | null) ?? null,
    carrier: row.carrier === null || row.carrier === undefined ? null : Number(row.carrier) === 1,
    operstate: (row.operstate as string | null) ?? null,
    carrierChanges: toNumberOrNull(row.carrierChanges),
    speedMbps: toNumberOrNull(row.speedMbps),
    since: (row.since as string | null) ?? null,
  }))
}

/** Far end of each cabled port: "<node> <port>". */
async function loadCables(portIds: number[]): Promise<Map<number, string>> {
  if (portIds.length === 0) return new Map()
  const rows = rawRows<Record<string, unknown>>(
    await db.rawQuery(
      `SELECT l.a_port_id AS aId, l.b_port_id AS bId,
              COALESCE(na.name, apa.friendly_name, apa.name, ca.name) AS aNode,
              COALESCE(pa.label, pa.reported_label, pa.port_key) AS aPort,
              COALESCE(nb.name, apb.friendly_name, apb.name, cb.name) AS bNode,
              COALESCE(pb.label, pb.reported_label, pb.port_key) AS bPort
         FROM infra_links l
         JOIN infra_ports pa ON pa.id = l.a_port_id
         JOIN infra_nodes na ON na.id = pa.node_id
         LEFT JOIN wifi_access_points apa ON apa.id = na.ap_id
         LEFT JOIN collectors ca ON ca.id = na.collector_id
         JOIN infra_ports pb ON pb.id = l.b_port_id
         JOIN infra_nodes nb ON nb.id = pb.node_id
         LEFT JOIN wifi_access_points apb ON apb.id = nb.ap_id
         LEFT JOIN collectors cb ON cb.id = nb.collector_id`
    )
  )
  const wanted = new Set(portIds)
  const out = new Map<number, string>()
  const label = (node: unknown, port: unknown) => [node, port].filter(Boolean).join(' ')
  for (const row of rows) {
    const a = Number(row.aId)
    const b = Number(row.bId)
    if (wanted.has(a)) out.set(a, label(row.bNode, row.bPort))
    if (wanted.has(b)) out.set(b, label(row.aNode, row.aPort))
  }
  return out
}

function params(ctx: DetectorContext, type: string): Record<string, ParamValue> {
  return ctx.rule(type).params ?? {}
}

function intParam(p: Record<string, ParamValue>, key: string, fallback: number): number {
  const value = p[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function scopeParam(p: Record<string, ParamValue>, fallback: 'cabled' | 'all') {
  return p.scope === 'all' || p.scope === 'cabled' ? p.scope : fallback
}

export type PortsTickResult = {
  down: number[]
  flapping: Array<{ portId: number; rise: number }>
  degraded: number[]
}

export async function runPortsDetector(ctx: DetectorContext): Promise<PortsTickResult> {
  const nowMs = ctx.now.toMillis()
  const downParams = params(ctx, DOWN_TYPE)
  const flapParams = params(ctx, FLAP_TYPE)
  const downScope = scopeParam(downParams, 'cabled')
  const flapScope = scopeParam(flapParams, 'all')
  const changes = intParam(flapParams, 'changes', 6)
  const windowMs = intParam(flapParams, 'windowMinutes', 15) * 60_000
  const speedEnabled = ctx.rule(SPEED_TYPE).enabled

  const presence = await getPresenceSettings()
  const [ports, collectors, aps, live] = await Promise.all([
    loadAgentPorts(),
    loadCollectorLiveness(),
    loadApLiveness(presence),
    liveAlerts([DOWN_TYPE, FLAP_TYPE]),
  ])
  const onlineCollectors = liveCollectorIds(collectors)
  const onlineAps = liveApIds(aps)
  const agentName = new Map<string, string>([
    ...collectors.map((c) => [`c:${c.id}`, c.name] as const),
    ...aps.map((a) => [`a:${a.id}`, a.name] as const),
  ])
  const cables = await loadCables(ports.map((p) => p.id))
  const persisted = seeded ? new Map<number, PortBaseline>() : await loadPersisted()
  seeded = true

  const downCurrent: ConditionInput[] = []
  const flapCurrent: ConditionInput[] = []
  const result: PortsTickResult = { down: [], flapping: [], degraded: [] }
  const seen = new Set<number>()

  for (const port of ports) {
    seen.add(port.id)
    const online =
      port.apId !== null ? onlineAps.has(port.apId) : onlineCollectors.has(port.collectorId ?? -1)
    const node =
      port.nodeName ??
      (port.apId !== null
        ? agentName.get(`a:${port.apId}`)
        : agentName.get(`c:${port.collectorId}`)) ??
      `Node ${port.nodeId}`
    const portLabel = port.label ?? port.portKey
    const cabled = cables.has(port.id) || port.role === 'uplink'
    const downKey = portKey(DOWN_TYPE, port.id)
    const flapKey = portKey(FLAP_TYPE, port.id)
    const subject = { kind: 'port', id: port.id } as const

    if (!online) {
      // Unknown, not down: keep whatever is live, raise nothing.
      if (live.has(downKey)) {
        downCurrent.push({ type: DOWN_TYPE, subject, dedupeKey: downKey, source: SOURCE })
      }
      if (live.has(flapKey)) {
        flapCurrent.push({ type: FLAP_TYPE, subject, dedupeKey: flapKey, source: SOURCE })
      }
      continue
    }

    const baseline =
      baselines.get(port.id) ??
      resumeBaseline(persisted.get(port.id), port.carrierChanges, nowMs, windowMs)
    const linkUp = !portIsDown(port.carrier, port.operstate)

    if ((downScope === 'all' || cabled) && !linkUp) {
      result.down.push(port.id)
      downCurrent.push({
        type: DOWN_TYPE,
        subject,
        dedupeKey: downKey,
        source: SOURCE,
        payload: {
          portId: port.id,
          nodeId: port.nodeId,
          node,
          port: portLabel,
          role: port.role,
          farEnd: cables.get(port.id) ?? null,
          speedMbps: baseline.lastSpeed,
          since: port.since,
        },
      })
    }

    if (port.carrierChanges !== null) {
      const { rise } = observeCounter(baseline, port.carrierChanges, nowMs, windowMs)
      const holds =
        (flapScope === 'all' || cabled) &&
        flappingHolds({
          rise,
          changes,
          lastMoveAt: baseline.lastMoveAt,
          nowMs,
          windowMs,
          wasHolding: live.has(flapKey),
        })
      if (holds) {
        result.flapping.push({ portId: port.id, rise })
        flapCurrent.push({
          type: FLAP_TYPE,
          subject,
          dedupeKey: flapKey,
          source: SOURCE,
          payload: {
            portId: port.id,
            nodeId: port.nodeId,
            node,
            port: portLabel,
            changes: rise,
            windowMinutes: windowMs / 60_000,
            carrier: port.carrier,
            speedMbps: port.speedMbps,
          },
        })
      }
    }

    const degradedFrom = observeSpeed(baseline, port.speedMbps, linkUp, nowMs)
    if (degradedFrom !== null && cabled && speedEnabled) {
      result.degraded.push(port.id)
      ctx.emit({
        type: SPEED_TYPE,
        phase: 'instant',
        subject,
        dedupeKey: portKey(SPEED_TYPE, port.id),
        source: SOURCE,
        payload: {
          portId: port.id,
          nodeId: port.nodeId,
          node,
          port: portLabel,
          speedMbps: port.speedMbps,
          previousMbps: degradedFrom,
          farEnd: cables.get(port.id) ?? null,
        },
      })
    }
    remember(port.id, baseline)
  }

  await ctx.reconcile([DOWN_TYPE], downCurrent)
  await ctx.reconcile([FLAP_TYPE], flapCurrent)

  if (nowMs - lastPersistMs >= PERSIST_EVERY_MS) {
    lastPersistMs = nowMs
    for (const [portId, baseline] of [...baselines]) {
      if (!seen.has(portId)) {
        baselines.delete(portId)
        persistedSignatures.delete(portId)
        await ctx.state.delete(`carrier:${portId}`)
        continue
      }
      const sig = signature(baseline)
      if (persistedSignatures.get(portId) === sig) continue
      baseline.persistedAt = nowMs
      await ctx.state.set(`carrier:${portId}`, baseline)
      persistedSignatures.set(portId, sig)
    }
  }
  return result
}

registerDetector({
  id: DETECTOR_ID,
  everySeconds: 15,
  types: [DOWN_TYPE, FLAP_TYPE, SPEED_TYPE],
  run: async (ctx) => {
    await runPortsDetector(ctx)
  },
})
