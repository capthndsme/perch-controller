import type { FeatureObservation } from '#services/gateway_config/domain'
import { parseJsonObject, rawRows } from '#services/gateway_observation_common'
import {
  normalizeInterfaces,
  normalizeMwan3,
  normalizeResolver,
  normalizeSystem,
  type Mwan3Observation,
  type ObservedInterface,
  type ResolverObservation,
  type SystemObservation,
} from '#services/gateway_observation_parts'
import db from '@adonisjs/lucid/services/db'

/**
 * The observed facts the config plane's native-sync domains need
 * (docs/gateway/native-sync.md): the resolver (dnsmasq's port, the front
 * resolver, how the router resolves the controller's name), the system part
 * (the host name the router runs with), the interfaces netifd knows and
 * mwan3's state. A part older than the observation channel's stale bound
 * (1800 s, `STALE_OBSERVATION_SECONDS`) reads null: a check never runs on a
 * stale fact. Kept apart from `gateway_observation_read.ts` so the config
 * plane's core can import it without that module's REST dependencies.
 */

const STALE_SECONDS = 1800

export type ObservedFacts = {
  resolver: ResolverObservation | null
  system: SystemObservation | null
  interfaces: ObservedInterface[] | null
  mwan3: Mwan3Observation | null
  observedAt: Partial<Record<'resolver' | 'system' | 'interfaces' | 'mwan3', string>>
}

export const NO_FACTS: ObservedFacts = Object.freeze({
  resolver: null,
  system: null,
  interfaces: null,
  mwan3: null,
  observedAt: {},
}) as ObservedFacts

export async function readObservedFacts(collectorId: number | null): Promise<ObservedFacts> {
  if (collectorId === null) return { ...NO_FACTS, observedAt: {} }
  const rows = rawRows<{ kind: string; payload: string | null; observedAt: string; age: number }>(
    await db.rawQuery(
      `SELECT kind, payload, DATE_FORMAT(observed_at, '%Y-%m-%dT%H:%i:%sZ') AS observedAt,
              TIMESTAMPDIFF(SECOND, observed_at, UTC_TIMESTAMP()) AS age
         FROM gateway_observations
        WHERE collector_id = ? AND kind IN ('resolver', 'system', 'interfaces', 'mwan3')`,
      [collectorId]
    )
  )
  const out: ObservedFacts = { ...NO_FACTS, observedAt: {} }
  for (const row of rows) {
    if (Number(row.age) > STALE_SECONDS || !row.payload) continue
    const kind = row.kind as keyof ObservedFacts['observedAt']
    if (kind === 'interfaces') {
      out.interfaces = normalizeInterfaces(parseJson(row.payload))
    } else {
      const payload = parseJsonObject(row.payload)
      if (!payload) continue
      if (kind === 'resolver') out.resolver = normalizeResolver(payload)
      if (kind === 'system') out.system = normalizeSystem(payload)
      if (kind === 'mwan3') out.mwan3 = normalizeMwan3(payload)
    }
    out.observedAt[kind] = String(row.observedAt)
  }
  return out
}

/** The facts as the domains' "in sync" checks take them. */
export function featureObservation(facts: ObservedFacts): FeatureObservation {
  return {
    hostname: facts.system?.hostname ?? null,
    resolver: facts.resolver
      ? {
          dnsmasqPort: facts.resolver.dnsmasqPort,
          controllerHost: facts.resolver.controllerHost
            ? {
                name: facts.resolver.controllerHost.name,
                addresses: facts.resolver.controllerHost.addresses,
                error: facts.resolver.controllerHost.error,
              }
            : null,
        }
      : null,
    interfaces: facts.interfaces
      ? facts.interfaces.map((i) => ({ network: i.network, up: i.up }))
      : null,
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
