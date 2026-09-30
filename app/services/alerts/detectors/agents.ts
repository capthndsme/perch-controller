import apHub from '#services/ap_agent_hub'
import collectorHub from '#services/collector_agent_hub'
import { getPresenceSettings } from '#services/presence_settings'
import { CONNECTED_INACTIVE_MS } from '#services/wifi_presence'
import type { AlertsSettings, ConditionInput, DetectorContext } from '#services/alerts/model'
import { registerDetector } from '#services/alerts/registry'
import {
  liveAlerts,
  loadApLiveness,
  loadCollectorLiveness,
  monitoredAps,
  monitoredCollectors,
  rawRows,
  type ApLiveness,
} from '#services/alerts/detectors/liveness'
import db from '@adonisjs/lucid/services/db'

/**
 * Detector `agents` (WP-A5a, events.md section 3.1): `collector.offline`,
 * `ap.offline` and the mass-offline guard `system.agents_unreachable`
 * (README section 2.3 item 12). Level-triggered every 15 s from
 * `last_seen_at`, which every accepted poll, push or scrape writes, against
 * the controller's own silence bounds (`collectorStaleSeconds`,
 * `apStaleSeconds` + Settings → Presence).
 */

export const AGENT_TYPES = ['collector.offline', 'ap.offline'] as const
export const MASS_TYPE = 'system.agents_unreachable'
export const MASS_KEY = `${MASS_TYPE}:controller`

export const collectorOfflineKey = (id: number) => `collector.offline:collector:${id}`
export const apOfflineKey = (id: number) => `ap.offline:ap:${id}`

export type MassOfflineSettings = AlertsSettings['massOffline']

export const MASS_OFFLINE_DEFAULTS: MassOfflineSettings = {
  enabled: true,
  fractionPercent: 75,
  minAgents: 3,
}

/** One monitored agent (adopted/enabled, reported at least once). */
export type MonitoredAgent = { key: string; name: string; silent: boolean }

export type AgentVerdict = {
  /** Per-agent keys to pass to `reconcileConditions` (raised when new, kept when live). */
  hold: string[]
  /** The guard's facts when it holds and may be raised or kept, else null. */
  mass: { silent: number; monitored: number; names: string[] } | null
}

/**
 * The guard holds when at least `minAgents`, and at least `fractionPercent`
 * of the monitored agents, are silent; never with fewer than `minAgents`
 * monitored (events.md section 3.1).
 */
export function massOfflineHolds(
  silent: number,
  monitored: number,
  settings: MassOfflineSettings
): boolean {
  if (!settings.enabled || monitored < settings.minAgents) return false
  const needed = Math.max(
    settings.minAgents,
    Math.ceil((settings.fractionPercent / 100) * monitored)
  )
  return silent >= needed
}

/**
 * The decision, free of I/O. A key left out of `hold` clears, so recoveries
 * always go through.
 *
 * - While the guard holds, only per-agent alerts that are already `active`
 *   stay; a `pending` one (raised a tick earlier, while the agents were
 *   falling silent one by one, still inside its hold) is dropped and resolves
 *   as a blip, so the guard's one message is the only one.
 * - In boot grace nothing new is raised (agents reconnect within their 30 s
 *   backoff cap after a restart); live alerts keep their state. The engine
 *   applies the same rule (`bootGrace` in the catalogue); doing it here also
 *   keeps the event log free of a raise per tick.
 */
export function evaluateAgents(input: {
  agents: MonitoredAgent[]
  live: ReadonlyMap<string, 'pending' | 'active'>
  inBootGrace: boolean
  massOffline: MassOfflineSettings
}): AgentVerdict {
  const silent = input.agents.filter((agent) => agent.silent)
  const massHolds = massOfflineHolds(silent.length, input.agents.length, input.massOffline)
  const hold = silent
    .filter((agent) => {
      const state = input.live.get(agent.key)
      if (massHolds) return state === 'active'
      if (input.inBootGrace) return state !== undefined
      return true
    })
    .map((agent) => agent.key)
  const massMay = massHolds && (!input.inBootGrace || input.live.has(MASS_KEY))
  return {
    hold,
    mass: massMay
      ? {
          silent: silent.length,
          monitored: input.agents.length,
          names: silent.map((agent) => agent.name).slice(0, 20),
        }
      : null,
  }
}

async function gatewayIdsByCollector(): Promise<Map<number, number>> {
  const rows = (await db
    .from('gateways')
    .whereNotNull('collector_id')
    .select('id', 'collector_id')) as Array<{ id: number; collector_id: number }>
  return new Map(rows.map((row) => [Number(row.collector_id), Number(row.id)]))
}

/**
 * Clients each AP listed in its last report: its `wifi_station_latest` rows
 * recorded within the AP's silence bound of its own `last_seen_at` and idle
 * under the connected threshold (the `stationConnectedSql` rule anchored at
 * the last report, since the AP is silent). Computed once, at raise.
 */
async function clientsAtLastReport(aps: ApLiveness[]): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  for (const ap of aps) {
    const rows = rawRows<{ clients: number | string }>(
      await db.rawQuery(
        `SELECT COUNT(*) AS clients
           FROM wifi_station_latest s
           JOIN wifi_access_points ap ON ap.id = s.ap_id
          WHERE s.ap_id = ?
            AND s.inactive_ms < ?
            AND s.recorded_at >= ap.last_seen_at - INTERVAL ? SECOND`,
        [ap.id, CONNECTED_INACTIVE_MS, ap.boundSeconds]
      )
    )
    out.set(ap.id, Number(rows[0]?.clients ?? 0))
  }
  return out
}

export async function runAgentsDetector(ctx: DetectorContext): Promise<void> {
  const presence = await getPresenceSettings()
  const [collectorRows, apRows, live] = await Promise.all([
    loadCollectorLiveness(),
    loadApLiveness(presence),
    liveAlerts([...AGENT_TYPES, MASS_TYPE]),
  ])
  const collectors = monitoredCollectors(collectorRows)
  const aps = monitoredAps(apRows)

  const verdict = evaluateAgents({
    agents: [
      ...collectors.map((c) => ({
        key: collectorOfflineKey(c.id),
        name: c.name,
        silent: c.silent,
      })),
      ...aps.map((a) => ({ key: apOfflineKey(a.id), name: a.name, silent: a.silent })),
    ],
    live,
    inBootGrace: ctx.inBootGrace,
    massOffline: { ...MASS_OFFLINE_DEFAULTS, ...ctx.settings?.massOffline },
  })
  const holding = new Set(verdict.hold)
  // Payloads only for the keys raised now; a live alert keeps its own.
  const raising = (key: string) => holding.has(key) && !live.has(key)

  const gatewayIds = collectors.some((c) => raising(collectorOfflineKey(c.id)))
    ? await gatewayIdsByCollector()
    : new Map<number, number>()
  const clients = await clientsAtLastReport(aps.filter((a) => raising(apOfflineKey(a.id))))

  const current: ConditionInput[] = []
  for (const c of collectors) {
    const key = collectorOfflineKey(c.id)
    if (!holding.has(key)) continue
    current.push({
      type: 'collector.offline',
      subject: { kind: 'collector', id: c.id },
      dedupeKey: key,
      source: 'detector:agents',
      ...(raising(key) && {
        payload: {
          collectorId: c.id,
          name: c.name,
          transport: c.transport,
          connected: collectorHub.isOnline(c.id),
          lastSeenAt: c.lastSeenAt,
          silentSeconds: c.silentSeconds,
          boundSeconds: c.boundSeconds,
          lastError: typeof c.lastStatus?.error === 'string' ? c.lastStatus.error : null,
          gatewayId: gatewayIds.get(c.id) ?? null,
        },
      }),
    })
  }
  for (const a of aps) {
    const key = apOfflineKey(a.id)
    if (!holding.has(key)) continue
    current.push({
      type: 'ap.offline',
      subject: { kind: 'ap', id: a.id },
      dedupeKey: key,
      source: 'detector:agents',
      ...(raising(key) && {
        payload: {
          apId: a.id,
          name: a.name,
          model: a.model,
          transport: a.transport,
          agentConnected: a.transport === 'agent' ? apHub.isOnline(a.id) : null,
          lastSeenAt: a.lastSeenAt,
          silentSeconds: a.silentSeconds,
          boundSeconds: a.boundSeconds,
          clientsAtLastReport: clients.get(a.id) ?? 0,
        },
      }),
    })
  }

  // The guard first: the engine withholds new per-agent alerts while it is live.
  await ctx.reconcile(
    [MASS_TYPE],
    verdict.mass
      ? [
          {
            type: MASS_TYPE,
            subject: { kind: 'controller' },
            dedupeKey: MASS_KEY,
            source: 'detector:agents',
            payload: verdict.mass,
          },
        ]
      : []
  )
  await ctx.reconcile([...AGENT_TYPES], current)
}

registerDetector({
  id: 'agents',
  everySeconds: 15,
  types: [...AGENT_TYPES, MASS_TYPE],
  run: runAgentsDetector,
})
