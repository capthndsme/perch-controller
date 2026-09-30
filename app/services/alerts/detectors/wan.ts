import {
  normalizeInterfaces,
  normalizeMwan3,
  type Mwan3Observation,
  type ObservedInterface,
} from '#services/gateway_observation_parts'
import { STALE_OBSERVATION_SECONDS } from '#services/gateway_observation_read'
import type { ConditionInput, DetectorContext } from '#services/alerts/model'
import { registerDetector } from '#services/alerts/registry'
import {
  liveAlerts,
  liveCollectorIds,
  loadCollectorLiveness,
  rawRows,
  toNumberOrNull,
} from '#services/alerts/detectors/liveness'
import db from '@adonisjs/lucid/services/db'

/**
 * Detector `wan` (WP-A5b, events.md section 3.2), every 15 s, per gateway
 * whose collector is adopted, enabled and not silent (a silent collector
 * says nothing about the WAN; `collector.offline` covers it). Inputs: the
 * latest `interfaces` and `mwan3` observation parts, read like
 * `readWanStatus`.
 *
 * Remembered WANs (state `wans:<gatewayId>`): a network becomes a WAN the
 * first time it carries a default route, or while a running mwan3 lists it
 * in its config; it is forgotten after `forgetHours` absent from the report,
 * or when an admin resolves its `wan.down` by hand ("stop watching this
 * WAN"). Live: `wan` (wan0, metric 1) and `lan2` (wan2, metric 2) are WANs;
 * `globe` is down but never carried a route, and mwan3 is installed but not
 * running, so it is not one.
 */

export const DOWN_TYPE = 'wan.down'
export const FAILOVER_TYPE = 'wan.failover'
export const IP_TYPE = 'wan.public_ip_changed'

export const wanDownKey = (gatewayId: number, network: string) =>
  `${DOWN_TYPE}:network:${gatewayId}:${network}`
export const failoverKey = (gatewayId: number) => `${FAILOVER_TYPE}:gateway:${gatewayId}`

/** Timestamps in the memory move in steps of this, so the state is not rewritten every tick. */
const TOUCH_STEP_MS = 5 * 60_000

export type DownReason = 'link_down' | 'route_lost' | 'netifd_error' | 'mwan3_offline'

export type RememberedWan = {
  device: string | null
  metric: number | null
  /** ISO: last time it carried a default route (null: remembered from mwan3's config). */
  lastRouteAt: string | null
  /** ISO: last time the interfaces report listed it. */
  lastPresentAt: string
  /** First IPv4 address last seen on it (no prefix), for `wan.public_ip_changed`. */
  ipv4: string | null
  /** ISO: when it was first seen down in the current outage. */
  downSince: string | null
}

export type WanMemory = Record<string, RememberedWan>

export type WanState = {
  network: string
  device: string | null
  proto: string | null
  metric: number | null
  up: boolean
  reason: DownReason | null
  error: string | null
  since: string | null
  defaultRoute: boolean | null
}

export type WanRef = { network: string; device: string | null }

export type WanEvaluation = {
  memory: WanMemory
  /** Remembered WANs present in the report, lowest metric first. */
  wans: WanState[]
  allDown: boolean
  active: WanRef | null
  preferred: WanRef | null
  /** Holds when the active WAN is not the preferred one. */
  failover: { from: WanRef; to: WanRef; reason: DownReason | null } | null
  ipChanges: Array<{ network: string; from: string; to: string }>
}

function firstIpv4(iface: ObservedInterface): string | null {
  const first = iface.ipv4[0]
  return first ? first.split('/')[0] : null
}

function byMetric(a: { metric: number | null; network: string }, b: typeof a): number {
  const am = a.metric ?? Number.MAX_SAFE_INTEGER
  const bm = b.metric ?? Number.MAX_SAFE_INTEGER
  if (am !== bm) return am - bm
  return a.network < b.network ? -1 : a.network > b.network ? 1 : 0
}

/** Up/down of one remembered WAN present in the report (events.md section 3.2). */
export function wanUp(
  iface: ObservedInterface,
  mwan3: Mwan3Observation | null
): { up: boolean; reason: DownReason | null } {
  if (mwan3?.service?.running === true) {
    const status = mwan3.interfaces.find((m) => m.name === iface.network)?.status ?? null
    if (status === 'online') return { up: true, reason: null }
    if (status === 'offline') return { up: false, reason: 'mwan3_offline' }
  }
  if (iface.error) return { up: false, reason: 'netifd_error' }
  if (!iface.up) return { up: false, reason: 'link_down' }
  if (iface.defaultRoute === false) return { up: false, reason: 'route_lost' }
  return { up: true, reason: null }
}

/**
 * The active WAN: mwan3's policy member with the largest share when mwan3
 * runs (among the up WANs), else the up WAN with the lowest metric that
 * carries its default route.
 */
function activeWan(wans: WanState[], mwan3: Mwan3Observation | null): WanState | null {
  const up = wans.filter((w) => w.up)
  if (mwan3?.service?.running === true) {
    let best: { wan: WanState; percent: number } | null = null
    for (const name of Object.keys(mwan3.policies).sort()) {
      for (const member of mwan3.policies[name]) {
        const wan = up.find((w) => w.network === member.interface)
        const percent = member.percent ?? 0
        if (wan && percent > 0 && (!best || percent > best.percent)) best = { wan, percent }
      }
    }
    if (best) return best.wan
  }
  return up.filter((w) => w.defaultRoute === true).sort(byMetric)[0] ?? null
}

/**
 * One gateway's evaluation, free of I/O. `memory` is not modified; the next
 * memory is returned. `forgotten` networks (an admin resolved their
 * `wan.down` by hand) are dropped before anything else.
 */
export function evaluateWan(input: {
  interfaces: ObservedInterface[]
  mwan3: Mwan3Observation | null
  memory: WanMemory
  now: Date
  forgetHours: number
  forgotten?: ReadonlySet<string>
}): WanEvaluation {
  const nowMs = input.now.getTime()
  const nowIso = input.now.toISOString()
  const touch = (previous: string | null) =>
    previous !== null && nowMs - Date.parse(previous) < TOUCH_STEP_MS ? previous : nowIso
  const memory: WanMemory = {}
  for (const [network, entry] of Object.entries(input.memory)) {
    if (!input.forgotten?.has(network)) memory[network] = { ...entry }
  }

  const mwan3Running = input.mwan3?.service?.running === true
  const mwan3Configured = new Set(
    mwan3Running
      ? (input.mwan3?.configInterfaces ?? []).filter((i) => i.enabled !== false).map((i) => i.name)
      : []
  )
  const present = new Map(input.interfaces.map((iface) => [iface.network, iface]))

  // Learn: a default route, or a running mwan3's config, makes a WAN.
  for (const iface of input.interfaces) {
    const route = iface.defaultRoute === true
    if (!route && !mwan3Configured.has(iface.network) && !memory[iface.network]) continue
    const entry: RememberedWan = memory[iface.network] ?? {
      device: iface.device,
      metric: iface.metric,
      lastRouteAt: null,
      lastPresentAt: nowIso,
      ipv4: null,
      downSince: null,
    }
    if (iface.device !== null) entry.device = iface.device
    if (iface.metric !== null && route) entry.metric = iface.metric
    if (route) entry.lastRouteAt = touch(entry.lastRouteAt)
    entry.lastPresentAt = touch(entry.lastPresentAt)
    memory[iface.network] = entry
  }
  // Forget what has been absent from the report for `forgetHours`.
  for (const [network, entry] of Object.entries(memory)) {
    if (present.has(network)) continue
    if (nowMs - Date.parse(entry.lastPresentAt) > input.forgetHours * 3_600_000) {
      delete memory[network]
    }
  }

  const wans: WanState[] = []
  const ipChanges: WanEvaluation['ipChanges'] = []
  for (const [network, entry] of Object.entries(memory)) {
    const iface = present.get(network)
    if (!iface) continue
    const { up, reason } = wanUp(iface, input.mwan3)
    entry.downSince = up ? null : (entry.downSince ?? nowIso)
    const address = firstIpv4(iface)
    if (address !== null) {
      if (entry.ipv4 !== null && entry.ipv4 !== address) {
        ipChanges.push({ network, from: entry.ipv4, to: address })
      }
      entry.ipv4 = address
    }
    wans.push({
      network,
      device: iface.device ?? entry.device,
      proto: iface.proto,
      metric: iface.metric ?? entry.metric,
      up,
      reason,
      error: iface.error,
      since: entry.downSince,
      defaultRoute: iface.defaultRoute,
    })
  }
  wans.sort(byMetric)

  const allDown = wans.length > 0 && wans.every((w) => !w.up)
  const active = activeWan(wans, input.mwan3)
  const preferredWan =
    [...wans].sort((a, b) =>
      byMetric(
        { metric: memory[a.network]?.metric ?? a.metric, network: a.network },
        { metric: memory[b.network]?.metric ?? b.metric, network: b.network }
      )
    )[0] ?? null
  const ref = (w: WanState): WanRef => ({ network: w.network, device: w.device })
  const failover =
    active && preferredWan && active.network !== preferredWan.network
      ? { from: ref(preferredWan), to: ref(active), reason: preferredWan.reason }
      : null
  return {
    memory,
    wans,
    allDown,
    active: active ? ref(active) : null,
    preferred: preferredWan ? ref(preferredWan) : null,
    failover,
    ipChanges,
  }
}

// ── I/O ────────────────────────────────────────────────────────────────────

type GatewayRow = { id: number; collectorId: number }

async function loadGateways(): Promise<GatewayRow[]> {
  const rows = (await db
    .from('gateways')
    .whereNotNull('collector_id')
    .select('id', 'collector_id')) as Array<{ id: number; collector_id: number }>
  return rows.map((row) => ({ id: Number(row.id), collectorId: Number(row.collector_id) }))
}

type Parts = { interfaces: ObservedInterface[] | null; mwan3: Mwan3Observation | null }

/** The `interfaces` and `mwan3` parts, or null when interfaces are missing or stale. */
async function readParts(collectorId: number): Promise<Parts | null> {
  const rows = rawRows<{ kind: string; payload: string | null; age: unknown }>(
    await db.rawQuery(
      `SELECT kind, payload, TIMESTAMPDIFF(SECOND, observed_at, UTC_TIMESTAMP()) AS age
         FROM gateway_observations
        WHERE collector_id = ? AND kind IN ('interfaces', 'mwan3')`,
      [collectorId]
    )
  )
  const parse = (raw: string | null): unknown => {
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
  const byKind = new Map(rows.map((row) => [row.kind, row]))
  const interfacesRow = byKind.get('interfaces')
  const age = toNumberOrNull(interfacesRow?.age)
  if (!interfacesRow || age === null || age > STALE_OBSERVATION_SECONDS) return null
  const interfaces = normalizeInterfaces(parse(interfacesRow.payload))
  if (!interfaces) return null
  const mwan3Row = byKind.get('mwan3')
  const mwan3Age = toNumberOrNull(mwan3Row?.age)
  const mwan3 =
    mwan3Row && mwan3Age !== null && mwan3Age <= STALE_OBSERVATION_SECONDS
      ? normalizeMwan3(parse(mwan3Row.payload))
      : null
  return { interfaces, mwan3 }
}

/**
 * Networks whose `wan.down` an admin resolved by hand during the current
 * outage (after it went down): "stop watching this WAN".
 */
async function resolvedByAdmin(gatewayId: number, memory: WanMemory): Promise<Set<string>> {
  const down = Object.entries(memory).filter(([, entry]) => entry.downSince !== null)
  if (down.length === 0) return new Set()
  const rows = rawRows<{ dedupe_key: string; resolvedAt: string }>(
    await db.rawQuery(
      `SELECT dedupe_key, DATE_FORMAT(MAX(resolved_at), '%Y-%m-%dT%H:%i:%sZ') AS resolvedAt
         FROM alerts
        WHERE type = ? AND resolved_by_user_id IS NOT NULL
          AND dedupe_key IN (${down.map(() => '?').join(', ')})
        GROUP BY dedupe_key`,
      [DOWN_TYPE, ...down.map(([network]) => wanDownKey(gatewayId, network))]
    )
  )
  const out = new Set<string>()
  for (const [network, entry] of down) {
    const row = rows.find((r) => r.dedupe_key === wanDownKey(gatewayId, network))
    if (row && Date.parse(row.resolvedAt) >= Date.parse(entry.downSince!)) out.add(network)
  }
  return out
}

/** Subject of a live key this tick cannot judge, rebuilt from the key. */
function heldDown(key: string): ConditionInput | null {
  const match = /^wan\.down:network:(\d+):(.+)$/.exec(key)
  if (!match) return null
  return {
    type: DOWN_TYPE,
    subject: { kind: 'network', gatewayId: Number(match[1]), name: match[2] },
    dedupeKey: key,
    source: 'detector:wan',
  }
}

function heldFailover(key: string): ConditionInput | null {
  const match = /^wan\.failover:gateway:(\d+)$/.exec(key)
  if (!match) return null
  return {
    type: FAILOVER_TYPE,
    subject: { kind: 'gateway', id: Number(match[1]) },
    dedupeKey: key,
    source: 'detector:wan',
  }
}

function forgetHoursParam(ctx: DetectorContext): number {
  const value = ctx.rule(DOWN_TYPE).params?.forgetHours
  return typeof value === 'number' && value >= 1 ? value : 24
}

export async function runWanDetector(ctx: DetectorContext): Promise<Map<number, WanEvaluation>> {
  const [gateways, collectors, live] = await Promise.all([
    loadGateways(),
    loadCollectorLiveness(),
    liveAlerts([DOWN_TYPE, FAILOVER_TYPE]),
  ])
  const liveCollectors = liveCollectorIds(collectors)
  const forgetHours = forgetHoursParam(ctx)
  const ipRuleEnabled = ctx.rule(IP_TYPE).enabled
  const now = ctx.now.toJSDate()

  const downCurrent: ConditionInput[] = []
  const failoverCurrent: ConditionInput[] = []
  const evaluations = new Map<number, WanEvaluation>()
  const judged = new Set<number>()

  for (const gateway of gateways) {
    if (!liveCollectors.has(gateway.collectorId)) continue
    const parts = await readParts(gateway.collectorId)
    if (!parts?.interfaces) continue
    judged.add(gateway.id)

    const stateKey = `wans:${gateway.id}`
    const memory = (await ctx.state.get<WanMemory>(stateKey)) ?? {}
    const forgotten = await resolvedByAdmin(gateway.id, memory)
    const evaluation = evaluateWan({
      interfaces: parts.interfaces,
      mwan3: parts.mwan3,
      memory,
      now,
      forgetHours,
      forgotten,
    })
    evaluations.set(gateway.id, evaluation)
    if (JSON.stringify(evaluation.memory) !== JSON.stringify(memory)) {
      await ctx.state.set(stateKey, evaluation.memory)
    }

    for (const wan of evaluation.wans) {
      if (wan.up) continue
      downCurrent.push({
        type: DOWN_TYPE,
        subject: { kind: 'network', gatewayId: gateway.id, name: wan.network },
        dedupeKey: wanDownKey(gateway.id, wan.network),
        severity: evaluation.allDown ? 'critical' : 'warning',
        source: 'detector:wan',
        payload: {
          gatewayId: gateway.id,
          network: wan.network,
          device: wan.device,
          proto: wan.proto,
          reason: wan.reason,
          error: wan.error,
          since: wan.since,
          allDown: evaluation.allDown,
          activeWan: evaluation.active,
          metric: wan.metric,
        },
      })
    }
    if (evaluation.failover) {
      failoverCurrent.push({
        type: FAILOVER_TYPE,
        subject: { kind: 'gateway', id: gateway.id },
        dedupeKey: failoverKey(gateway.id),
        source: 'detector:wan',
        payload: { gatewayId: gateway.id, ...evaluation.failover },
      })
    } else if (evaluation.active === null) {
      // No active WAN: failover is not evaluated (`wan.down` covers it).
      const held = live.has(failoverKey(gateway.id)) ? heldFailover(failoverKey(gateway.id)) : null
      if (held) failoverCurrent.push(held)
    }
    if (ipRuleEnabled) {
      for (const change of evaluation.ipChanges) {
        ctx.emit({
          type: IP_TYPE,
          phase: 'instant',
          subject: { kind: 'network', gatewayId: gateway.id, name: change.network },
          source: 'detector:wan',
          payload: { gatewayId: gateway.id, ...change },
        })
      }
    }
  }

  // A gateway this tick could not judge (collector silent, report stale)
  // keeps its live alerts; one that is gone (row deleted) has them cleared.
  const existing = new Set(gateways.map((g) => g.id))
  for (const key of live.keys()) {
    const held = key.startsWith(`${DOWN_TYPE}:`) ? heldDown(key) : heldFailover(key)
    if (!held) continue
    const gatewayId =
      held.subject.kind === 'network'
        ? held.subject.gatewayId
        : held.subject.kind === 'gateway'
          ? held.subject.id
          : -1
    if (judged.has(gatewayId) || !existing.has(gatewayId)) continue
    if (held.type === DOWN_TYPE) downCurrent.push(held)
    else failoverCurrent.push(held)
  }

  await ctx.reconcile([DOWN_TYPE], downCurrent)
  await ctx.reconcile([FAILOVER_TYPE], failoverCurrent)
  return evaluations
}

registerDetector({
  id: 'wan',
  everySeconds: 15,
  types: [DOWN_TYPE, FAILOVER_TYPE, IP_TYPE],
  run: async (ctx) => {
    await runWanDetector(ctx)
  },
})
