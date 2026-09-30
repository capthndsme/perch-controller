import Collector from '#models/collector'
import type { FeatureObservation, ObservedInterfaceFact } from '#services/gateway_config/domain'
import type { SideFacts } from '#services/gateway_config/domains/side'
import { parseJsonObject, rawRows } from '#services/gateway_observation_common'
import {
  normalizeDdns,
  normalizeInterfaces,
  normalizeMwan3,
  normalizeResolver,
  normalizeSystem,
  normalizeWireguard,
  type DdnsObservation,
  type Mwan3Observation,
  type ObservedInterface,
  type ResolverObservation,
  type SystemObservation,
  type WireguardObservation,
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
  /** Gateway sync: ddns-scripts' state and the WireGuard peers (protocol.md 6.1). */
  ddns: DdnsObservation | null
  wireguard: WireguardObservation | null
  /** The `upnp` part's summary (the mappings live in their own table). */
  upnp: {
    installed: boolean
    enabled: boolean | null
    running: boolean | null
    secureMode: boolean | null
  } | null
  observedAt: Partial<
    Record<'resolver' | 'system' | 'interfaces' | 'mwan3' | 'ddns' | 'wireguard' | 'upnp', string>
  >
}

export const NO_FACTS: ObservedFacts = Object.freeze({
  resolver: null,
  system: null,
  interfaces: null,
  mwan3: null,
  ddns: null,
  wireguard: null,
  upnp: null,
  observedAt: {},
}) as ObservedFacts

export async function readObservedFacts(collectorId: number | null): Promise<ObservedFacts> {
  if (collectorId === null) return { ...NO_FACTS, observedAt: {} }
  const rows = rawRows<{ kind: string; payload: string | null; observedAt: string; age: number }>(
    await db.rawQuery(
      `SELECT kind, payload, DATE_FORMAT(observed_at, '%Y-%m-%dT%H:%i:%sZ') AS observedAt,
              TIMESTAMPDIFF(SECOND, observed_at, UTC_TIMESTAMP()) AS age
         FROM gateway_observations
        WHERE collector_id = ? AND kind IN ('resolver', 'system', 'interfaces', 'mwan3', 'ddns', 'wireguard', 'upnp')`,
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
      if (kind === 'ddns') out.ddns = normalizeDdns(payload)
      if (kind === 'wireguard') out.wireguard = normalizeWireguard(payload)
      if (kind === 'upnp') {
        const flag = (v: unknown) => (typeof v === 'boolean' ? v : null)
        out.upnp = {
          installed: payload.installed !== false,
          enabled: flag(payload.enabled),
          running: flag(payload.running),
          secureMode: flag(payload.secureMode),
        }
      }
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
      ? facts.interfaces.map((i) => ({
          network: i.network,
          up: i.up,
          proto: i.proto,
          defaultRoute: i.defaultRoute,
          metric: i.metric,
        }))
      : null,
    offloading: facts.system
      ? {
          flowOffloading: facts.system.flowOffloading,
          flowOffloadingHw: facts.system.flowOffloadingHw,
        }
      : null,
    upnp: facts.upnp ? { running: facts.upnp.running } : null,
    ddns: facts.ddns
      ? { services: facts.ddns.services.map((s) => ({ name: s.name, running: s.running })) }
      : null,
    wireguard: facts.wireguard
      ? {
          interfaces: facts.wireguard.interfaces.map((i) => ({
            name: i.name,
            network: i.network,
            peers: i.peers.map((p) => p.publicKey),
          })),
        }
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

/**
 * What the side rule reads beside UCI (`side.ts`, gateway sync domains.md 2):
 * the networks holding a default route and their L3 devices (the
 * `interfaces` observation, when fresh), and the collector's configured
 * `wan_interfaces` (its gateway report says `wanSource: configured`). Null
 * when nothing is known: the rule then works from UCI alone.
 */
export function sideFactsFrom(
  facts: ObservedFacts,
  gatewayStatus: { wanInterfaces?: unknown; wanSource?: unknown } | null | undefined
): SideFacts | null {
  const out: SideFacts = {}
  if (facts.interfaces) {
    out.defaultRoute = facts.interfaces.filter((i) => i.defaultRoute === true).map((i) => i.network)
    const l3: Record<string, string> = {}
    for (const i of facts.interfaces) if (i.device) l3[i.network] = i.device
    out.l3Devices = l3
  }
  if (gatewayStatus?.wanSource === 'configured' && Array.isArray(gatewayStatus.wanInterfaces)) {
    out.configuredWan = gatewayStatus.wanInterfaces.filter(
      (w): w is string => typeof w === 'string' && w.length > 0
    )
  }
  return Object.keys(out).length > 0 ? out : null
}

/** The side facts of a gateway's collector (DB). */
export async function readSideFacts(
  collectorId: number | null,
  facts?: ObservedFacts
): Promise<SideFacts | null> {
  if (collectorId === null) return null
  const observed = facts ?? (await readObservedFacts(collectorId))
  const collector = await Collector.find(collectorId)
  return sideFactsFrom(observed, collector?.lastStatus?.gateway ?? null)
}

/** The interfaces as the apply checks read them (`ChecksCtx.observed`). */
export function interfaceFacts(facts: ObservedFacts): ObservedInterfaceFact[] | null {
  return facts.interfaces
    ? facts.interfaces.map((i) => ({
        network: i.network,
        up: i.up,
        device: i.device,
        proto: i.proto,
        defaultRoute: i.defaultRoute,
        metric: i.metric,
        ipv4: i.ipv4,
        ipv6: i.ipv6,
        gateway4: i.gateway4,
      }))
    : null
}
