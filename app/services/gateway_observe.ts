import Collector from '#models/collector'
import collectorHub, {
  AgentOfflineError,
  AgentRpcError,
  AgentTimeoutError,
} from '#services/collector_agent_hub'
import {
  OBSERVATION_KIND_DHCP,
  bumpGatewayDhcpVersion,
  recordDhcpObservation,
} from '#services/gateway_dhcp'
import { OBSERVATION_KIND_NEIGHBORS, recordNeighborObservation } from '#services/gateway_neighbors'
import { OBSERVATION_KIND_UPNP, recordUpnpObservation } from '#services/gateway_upnp'
import {
  BLOB_PARTS,
  networkFor,
  normalizeInterfaces,
  type BlobKind,
  type ObservedInterface,
} from '#services/gateway_observation_parts'
import {
  fingerprintOf,
  isObject,
  lastWritten,
  rawRows,
  refreshObservedAt,
  remember,
  writeObservationRow,
} from '#services/gateway_observation_common'
import { recordWanTransitions } from '#services/gateway_config/gateway_wan_transitions'
import db from '@adonisjs/lucid/services/db'
import type { StrictValues } from '@adonisjs/lucid/types/querybuilder'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'

/**
 * The observation channel (docs/gateway/observation.md; plan-2-native-sync.md
 * section 3): runtime state of the router — leases, neighbours, UPnP
 * mappings, interfaces, multi-WAN status, resolver, system, WireGuard,
 * packages — reported by perch-collector on the router and mirrored here.
 * Never config: that is the config plane's.
 *
 * One observation object, three ways in, one ingest:
 * - `gateway.observed` (agent → server notification): the agent's own
 *   schedule (on change, at most every 5 s, neighbours every 60 s, a full
 *   resend every 600 s);
 * - `collector.push` params `observe` (the first form, `observe.dhcp`,
 *   docs/collector-agent.md 4.3) and a polled summary's `observe`;
 * - the result of `gateway.observe` (server → agent request, the dashboard's
 *   "refresh").
 *
 * Every part is optional: absent = not reported, never erase. Parts are
 * ingested in a fixed order (interfaces, neighbours, DHCP, UPnP, the blob
 * kinds) because later ones read earlier ones (DHCPv6 leases map to MACs
 * through the neighbour table, UPnP targets through both). One collector's
 * observations run one at a time; a failing part is logged and costs only
 * that part (non-fatal, beside the traffic ingest).
 */

export const OBSERVATION_PARTS = [
  'interfaces',
  'neighbors',
  'dhcp',
  'upnp',
  'mwan3',
  'resolver',
  'system',
  'wireguard',
  'packages',
] as const
export type ObservationPart = (typeof OBSERVATION_PARTS)[number]

/** The capability each part is announced with in `collector.hello`. */
export const PART_CAPABILITIES: Record<ObservationPart, string> = {
  interfaces: 'observe.interfaces',
  neighbors: 'observe.neighbors',
  dhcp: 'observe.dhcp',
  upnp: 'observe.upnp',
  mwan3: 'observe.mwan3',
  resolver: 'observe.resolver',
  system: 'observe.system',
  wireguard: 'observe.wireguard',
  packages: 'observe.packages',
}

export type PartOutcome = 'written' | 'unchanged' | 'invalid' | 'failed'
export type ObservationResult = { parts: Partial<Record<ObservationPart, PartOutcome>> }

/** The hello capability that allows the `gateway.observe` request. */
export const OBSERVE_CAPABILITY = 'gateway.observe'

/** How long `gateway.observe` may take (the agent may shell out to several tools). */
export const OBSERVE_REQUEST_TIMEOUT_MS = 20_000

// ── blob parts ─────────────────────────────────────────────────────────────

async function recordBlob(
  collectorId: number,
  kind: BlobKind,
  raw: unknown,
  now: DateTime
): Promise<'written' | 'unchanged' | 'invalid'> {
  const value = BLOB_PARTS[kind](raw)
  if (value === null) return 'invalid'
  const fingerprint = fingerprintOf(value)
  const last = await lastWritten(collectorId, kind)
  if (last && last.fingerprint === fingerprint) {
    await refreshObservedAt(collectorId, kind, last, now)
    return 'unchanged'
  }
  await writeObservationRow(db, collectorId, kind, value, fingerprint, now)
  remember(collectorId, kind, { fingerprint, observedWrittenAt: now.toMillis() })
  return 'written'
}

/** The latest `interfaces` report of a collector, or null when it never sent one. */
export async function readObservedInterfaces(
  collectorId: number
): Promise<ObservedInterface[] | null> {
  const rows = rawRows<{ payload: string | null }>(
    await db.rawQuery(
      `SELECT payload FROM gateway_observations WHERE collector_id = ? AND kind = 'interfaces'`,
      [collectorId]
    )
  )
  if (!rows[0]?.payload) return null
  try {
    return normalizeInterfaces(JSON.parse(rows[0].payload))
  } catch {
    return null
  }
}

/**
 * Sets `gateway_hosts.network` from the latest interfaces: the subnet
 * holding the lease (or neighbour) address, else the neighbour's device.
 * Writes only the rows whose network changed.
 */
export async function refreshHostNetworks(collectorId: number): Promise<number> {
  const interfaces = await readObservedInterfaces(collectorId)
  if (!interfaces) return 0
  const rows = rawRows<{
    id: number
    ipv4: string | null
    neighborIpv4: string | null
    neighborDevice: string | null
    network: string | null
  }>(
    await db.rawQuery(
      `SELECT id, ipv4, neighbor_ipv4 AS neighborIpv4, neighbor_device AS neighborDevice, network
         FROM gateway_hosts WHERE collector_id = ?`,
      [collectorId]
    )
  )
  const changed: [number, string | null][] = []
  for (const row of rows) {
    // The agent's own network for a lease or neighbour stays when the
    // interfaces cannot place the address.
    const network =
      networkFor(interfaces, row.ipv4) ??
      networkFor(interfaces, row.neighborIpv4, row.neighborDevice) ??
      row.network
    if (network !== row.network) changed.push([row.id, network])
  }
  for (let i = 0; i < changed.length; i += 500) {
    const chunk = changed.slice(i, i + 500)
    await db.rawQuery(
      `UPDATE gateway_hosts SET network = CASE id ${chunk.map(() => 'WHEN ? THEN ?').join(' ')} END
        WHERE id IN (${chunk.map(() => '?').join(',')})`,
      [...chunk.flat(), ...chunk.map(([id]) => id)] as StrictValues[]
    )
  }
  return changed.length
}

// ── the ingest ─────────────────────────────────────────────────────────────

async function recordPart(
  collectorId: number,
  part: ObservationPart,
  raw: unknown,
  now: DateTime
): Promise<PartOutcome> {
  switch (part) {
    case 'dhcp':
      return recordDhcpObservation(collectorId, raw, now)
    case 'neighbors':
      return recordNeighborObservation(collectorId, raw, now)
    case 'upnp':
      return recordUpnpObservation(collectorId, raw, now)
    default:
      return recordBlob(collectorId, part, raw, now)
  }
}

/**
 * Ingests one observation object (any subset of the parts). Not serialised:
 * use `recordGatewayObservationSerial`. Never throws for a bad part.
 */
export async function recordGatewayObservation(
  collectorId: number,
  raw: unknown,
  now: DateTime = DateTime.utc()
): Promise<ObservationResult> {
  const result: ObservationResult = { parts: {} }
  if (!isObject(raw)) return result
  // Gateway sync: WAN transitions compare the new interfaces with the last.
  const interfacesBefore =
    raw.interfaces !== undefined && raw.interfaces !== null
      ? await readObservedInterfaces(collectorId).catch(() => null)
      : null
  for (const part of OBSERVATION_PARTS) {
    if (raw[part] === undefined || raw[part] === null) continue
    try {
      result.parts[part] = await recordPart(collectorId, part, raw[part], now)
    } catch (error) {
      result.parts[part] = 'failed'
      logger.warn(
        { collectorId, part, error: String(error) },
        'gateway_observe: part write failed (non-fatal)'
      )
    }
  }
  const hostsMoved = (['interfaces', 'neighbors', 'dhcp'] as const).some(
    (part) => result.parts[part] === 'written'
  )
  if (hostsMoved) {
    try {
      await refreshHostNetworks(collectorId)
    } catch (error) {
      logger.warn(
        { collectorId, error: String(error) },
        'gateway_observe: network refresh failed (non-fatal)'
      )
    }
  }
  if (result.parts.neighbors === 'written') bumpGatewayDhcpVersion()
  if (result.parts.interfaces === 'written' && interfacesBefore) {
    await recordWanTransitions(
      collectorId,
      interfacesBefore,
      normalizeInterfaces(raw.interfaces),
      now
    )
  }
  return result
}

/**
 * One pending chain per collector: a push's observation runs beside its
 * traffic ingest (which may drop or coalesce pushes); this never drops a
 * changed report. The map holds at most one entry per collector with work in
 * flight.
 */
const chains = new Map<number, Promise<unknown>>()

export function recordGatewayObservationSerial(
  collectorId: number,
  raw: unknown,
  now: DateTime = DateTime.utc()
): Promise<ObservationResult> {
  const previous = chains.get(collectorId) ?? Promise.resolve()
  const run = previous
    .catch(() => {})
    .then(() => recordGatewayObservation(collectorId, raw, now))
    .catch((error) => {
      logger.warn(
        { collectorId, error: String(error) },
        'gateway_observe: observation write failed (non-fatal)'
      )
      return { parts: {} } as ObservationResult
    })
  chains.set(collectorId, run)
  void run.finally(() => {
    if (chains.get(collectorId) === run) chains.delete(collectorId)
  })
  return run
}

/** Adopted, enabled and on the socket: the rows whose agent observations are kept. */
export async function acceptsAgentObservations(collectorId: number): Promise<boolean> {
  const collector = await Collector.find(collectorId)
  return Boolean(
    collector &&
    collector.lifecycle === 'adopted' &&
    collector.enabled &&
    collector.transport === 'agent'
  )
}

/**
 * An observation that came over the socket (`gateway.observed`, or a push's
 * `observe`). Dropped for a row that is not adopted, enabled and `agent`.
 * Never throws.
 */
export async function handleAgentObservation(
  collectorId: number,
  raw: unknown,
  receivedAt: DateTime = DateTime.utc()
): Promise<ObservationResult | null> {
  try {
    if (!isObject(raw)) return null
    if (!(await acceptsAgentObservations(collectorId))) return null
    return await recordGatewayObservationSerial(collectorId, raw, receivedAt)
  } catch (error) {
    logger.warn({ collectorId, error: String(error) }, 'gateway_observe: observation dropped')
    return null
  }
}

// ── on demand ──────────────────────────────────────────────────────────────

export class ObserveRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'ObserveRequestError'
  }
}

/**
 * Asks the agent for a fresh observation (`gateway.observe {parts?}`) and
 * ingests the answer. Throws `ObserveRequestError` (409 `gateway_offline`,
 * 409 `gateway_capability_missing`, 504 `agent_timeout`, 502
 * `observe_failed`).
 */
export async function requestGatewayObservation(
  collectorId: number,
  parts: ObservationPart[] | undefined,
  capabilities: string[] | null
): Promise<{ observedAt: string; parts: ObservationResult['parts'] }> {
  if (!collectorHub.isOnline(collectorId) || capabilities === null) {
    throw new ObserveRequestError(409, 'gateway_offline', 'The gateway agent is not connected.')
  }
  const wanted = parts ?? []
  const missing = (wanted.length > 0 ? wanted : OBSERVATION_PARTS)
    .map((part) => PART_CAPABILITIES[part])
    .filter((capability) => !capabilities.includes(capability))
  // perch-collector announces `gateway.observe` for the request and
  // `observe.<part>` per part it reports.
  if (!capabilities.includes(OBSERVE_CAPABILITY)) {
    throw new ObserveRequestError(
      409,
      'gateway_capability_missing',
      'The gateway agent cannot be asked for observations.',
      { capability: OBSERVE_CAPABILITY }
    )
  }
  if (wanted.length > 0 && missing.length > 0) {
    throw new ObserveRequestError(
      409,
      'gateway_capability_missing',
      'The gateway agent does not report this observation.',
      { capability: missing[0] }
    )
  }
  let answer: unknown
  try {
    answer = await collectorHub.request(
      collectorId,
      'gateway.observe',
      wanted.length > 0 ? { parts: wanted } : {},
      { timeoutMs: OBSERVE_REQUEST_TIMEOUT_MS }
    )
  } catch (error) {
    if (error instanceof AgentOfflineError) {
      throw new ObserveRequestError(409, 'gateway_offline', 'The gateway agent is not connected.')
    }
    if (error instanceof AgentTimeoutError) {
      throw new ObserveRequestError(
        504,
        'agent_timeout',
        'The gateway agent did not answer in time.'
      )
    }
    if (error instanceof AgentRpcError) {
      throw new ObserveRequestError(502, 'observe_failed', error.message)
    }
    throw error
  }
  const receivedAt = DateTime.utc().startOf('second')
  const result = await recordGatewayObservationSerial(collectorId, answer, receivedAt)
  return { observedAt: receivedAt.toISO({ suppressMilliseconds: true })!, parts: result.parts }
}

export { OBSERVATION_KIND_DHCP, OBSERVATION_KIND_NEIGHBORS, OBSERVATION_KIND_UPNP }
