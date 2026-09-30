import GatewayWanTransition, { type WanTransitionEvent } from '#models/gateway_wan_transition'
import { alertIpv6PrefixChanged } from '#services/gateway_config/sync_alerts'
import { gatewayForCollector } from '#services/gateway_config/gateway_registry'
import { getGatewaySyncSettings } from '#services/gateway_config/gateway_sync_settings'
import { loadSections } from '#services/gateway_config/gateway_store'
import { isWanProto } from '#services/gateway_config/domains/side'
import { wanTopology } from '#services/gateway_config/domains/wan'
import { routerConfigSet } from '#services/gateway_config/sync_engine'
import type { ObservedInterface } from '#services/gateway_observation_parts'
import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'

/**
 * WAN transitions (docs/design/gateway-sync/README.md 7 and 14): what the
 * `interfaces` observation shows changing on the internet WANs, kept in
 * `gateway_wan_transitions` (the WAN page's history; the alerts area's
 * source for `gateway.wan.*`):
 *
 * - `down` / `up`: an uplink left or reached netifd's `up`;
 * - `failover`: the primary (the up uplink with a default route and the
 *   lowest metric) changed; `network` is the new one ('' = none left);
 * - `ip_changed`: an up uplink's IPv4 addresses changed;
 * - `prefix_changed`: an up IPv6 companion's (or uplink's) IPv6 addresses
 *   changed (the delegated prefixes when the agent reports them).
 *
 * The WANs are the gateway's uplinks by the side rule over the router's
 * config as the plane holds it; without rows (mode off), the interfaces
 * with a WAN proto or a default route. Pruned after Settings → Gateway sync
 * `transitionRetentionDays` (`gateway_wan_retention.task.ts`).
 */

export type TransitionDraft = {
  network: string
  device: string | null
  event: WanTransitionEvent
  detail: Record<string, unknown> | null
}

type Iface = Pick<
  ObservedInterface,
  'network' | 'device' | 'up' | 'ipv4' | 'ipv6' | 'defaultRoute' | 'metric' | 'proto'
>

const same = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i])

/** The primary uplink of an observation: up, a default route, the lowest metric. */
function primaryOf(list: Iface[], uplinks: Set<string>): string | null {
  const candidates = list
    .filter((i) => uplinks.has(i.network) && i.up && i.defaultRoute === true)
    .sort((a, b) => (a.metric ?? 0) - (b.metric ?? 0) || a.network.localeCompare(b.network))
  return candidates[0]?.network ?? null
}

/**
 * The transitions between two observations, pure. `uplinks` are the
 * internet WANs, `companions` their IPv6 companions.
 */
export function wanTransitionsBetween(
  before: Iface[] | null,
  after: Iface[],
  uplinks: Set<string>,
  companions: Set<string> = new Set()
): TransitionDraft[] {
  if (!before) return []
  const out: TransitionDraft[] = []
  const prev = new Map(before.map((i) => [i.network, i]))
  for (const now of after) {
    if (!uplinks.has(now.network) && !companions.has(now.network)) continue
    const was = prev.get(now.network)
    if (!was) continue
    if (uplinks.has(now.network)) {
      if (was.up && !now.up) {
        out.push({ network: now.network, device: was.device, event: 'down', detail: null })
        continue
      }
      if (!was.up && now.up) {
        out.push({ network: now.network, device: now.device, event: 'up', detail: null })
        continue
      }
      if (was.up && now.up && !same(was.ipv4, now.ipv4)) {
        out.push({
          network: now.network,
          device: now.device,
          event: 'ip_changed',
          detail: { before: was.ipv4, after: now.ipv4 },
        })
      }
    }
    if (
      was.up &&
      now.up &&
      !same(was.ipv6, now.ipv6) &&
      (companions.has(now.network) || now.ipv6.length > 0)
    ) {
      out.push({
        network: now.network,
        device: now.device,
        event: 'prefix_changed',
        detail: { before: was.ipv6, after: now.ipv6 },
      })
    }
  }
  // An uplink that vanished from the report while up is down.
  for (const was of before) {
    if (uplinks.has(was.network) && was.up && !after.some((i) => i.network === was.network)) {
      out.push({ network: was.network, device: was.device, event: 'down', detail: null })
    }
  }
  const from = primaryOf(before, uplinks)
  const to = primaryOf(after, uplinks)
  if (from !== to) {
    out.push({
      network: to ?? '',
      device: after.find((i) => i.network === to)?.device ?? null,
      event: 'failover',
      detail: { from, to },
    })
  }
  return out
}

/** The gateway's internet uplinks and their companions (by the side rule), else by proto. */
async function wanNetworksOf(
  collectorId: number,
  observed: Iface[]
): Promise<{ gatewayId: number | null; uplinks: Set<string>; companions: Set<string> }> {
  const gateway = await gatewayForCollector(collectorId)
  if (gateway) {
    const { states } = await loadSections(gateway.id)
    if (states.some((s) => s.config === 'network')) {
      const topology = wanTopology(routerConfigSet(states))
      return {
        gatewayId: gateway.id,
        uplinks: new Set(topology.uplinks.map((u) => u.network)),
        companions: new Set(topology.companionOf.keys()),
      }
    }
  }
  const uplinks = new Set(
    observed
      .filter(
        (i) =>
          (i.proto !== null && isWanProto(i.proto) && i.proto !== 'dhcpv6') ||
          i.defaultRoute === true
      )
      .map((i) => i.network)
  )
  return { gatewayId: gateway?.id ?? null, uplinks, companions: new Set() }
}

/**
 * Records the transitions an `interfaces` report shows against the one
 * before it (called by the observation ingest after the part was written).
 * Never throws.
 */
export async function recordWanTransitions(
  collectorId: number,
  before: ObservedInterface[] | null,
  after: ObservedInterface[] | null,
  at: DateTime = DateTime.utc()
): Promise<number> {
  try {
    if (!before || !after) return 0
    const { gatewayId, uplinks, companions } = await wanNetworksOf(collectorId, after)
    if (gatewayId === null || uplinks.size === 0) return 0
    const drafts = wanTransitionsBetween(before, after, uplinks, companions)
    for (const d of drafts) {
      const row = new GatewayWanTransition()
      row.gatewayId = gatewayId
      row.network = d.network.slice(0, 32)
      row.device = d.device ? d.device.slice(0, 32) : null
      row.event = d.event
      row.detail = d.detail
      row.at = at.toUTC()
      await row.save()
      if (d.event === 'prefix_changed') {
        const detail = d.detail as { before: string[]; after: string[] }
        alertIpv6PrefixChanged(gatewayId, d.network, detail.before, detail.after)
      }
    }
    return drafts.length
  } catch (error) {
    logger.warn({ collectorId, error: String(error) }, 'gateway_wan_transitions: not recorded')
    return 0
  }
}

export type WanTransitionView = {
  network: string
  device: string | null
  event: WanTransitionEvent
  detail: Record<string, unknown> | null
  at: string
}

export function transitionView(row: GatewayWanTransition): WanTransitionView {
  return {
    network: row.network,
    device: row.device,
    event: row.event as WanTransitionEvent,
    detail: row.detail,
    at: row.at.toUTC().toISO()!,
  }
}

/** The newest transitions of a gateway (the overview's 50). */
export async function latestTransitions(gatewayId: number, limit = 50) {
  const rows = await GatewayWanTransition.query()
    .where('gateway_id', gatewayId)
    .orderBy('at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
  return rows.map(transitionView)
}

/** Transitions in a window, oldest first (`GET /wan/history`). */
export async function transitionsBetween(
  gatewayId: number,
  from: DateTime,
  to: DateTime,
  network: string | null
) {
  const query = GatewayWanTransition.query()
    .where('gateway_id', gatewayId)
    .where('at', '>=', from.toUTC().toSQL({ includeOffset: false })!)
    .where('at', '<=', to.toUTC().toSQL({ includeOffset: false })!)
    .orderBy('at', 'asc')
    .orderBy('id', 'asc')
    .limit(5000)
  if (network) query.where('network', network)
  const rows = await query
  return rows.map(transitionView)
}

// ── retention ──────────────────────────────────────────────────────────────

const BATCH = 5000

function affected(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result
  return Number((header as { affectedRows?: number })?.affectedRows ?? 0)
}

/**
 * Deletes transitions older than `transitionRetentionDays`, in batches;
 * ages against `UTC_TIMESTAMP()` (stored times are UTC).
 */
export async function pruneWanTransitions(): Promise<number> {
  const { transitionRetentionDays } = await getGatewaySyncSettings()
  let total = 0
  for (;;) {
    const deleted = affected(
      await db.rawQuery(
        `DELETE FROM gateway_wan_transitions WHERE at < UTC_TIMESTAMP() - INTERVAL ? DAY LIMIT ${BATCH}`,
        [transitionRetentionDays]
      )
    )
    total += deleted
    if (deleted < BATCH) return total
  }
}
