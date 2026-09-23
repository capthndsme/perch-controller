import db from '@adonisjs/lucid/services/db'
import type { StrictValues } from '@adonisjs/lucid/types/querybuilder'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'
import {
  fingerprintOf,
  forgetObservations,
  ipv4,
  ipv6,
  isObject,
  lastWritten,
  list,
  normalizeMac as normalizeMacCommon,
  parseJsonArray,
  parseJsonObject,
  rawRows,
  refreshObservedAt,
  remember,
  sqlTime,
  text,
  unixSeconds,
  writeObservationRow,
} from '#services/gateway_observation_common'

/**
 * The `dhcp` part of the Gateway agent's observation (docs/gateway/
 * observation.md section 3.1; first built as `observe.dhcp`,
 * docs/collector-agent.md section 4.3): perch-collector on the router reports
 * its leases and the static hosts of `/etc/config/dhcp` when they change, at
 * the start of each session and every refresh interval. The part is a full
 * snapshot of the leases and lands here: normalised, folded to one row per
 * MAC and mirrored into `gateway_hosts`, with the report's fingerprint and
 * time in `gateway_observations`.
 *
 * An absent part means "nothing new" and writes nothing. An unchanged report
 * (same fingerprint as the last one written, remembered per collector in a
 * bounded map and in `gateway_observations`) only refreshes `observed_at`, at
 * most once a minute. Inside the part, `hosts` absent means the static hosts
 * were not reported: the previous report's are kept.
 *
 * A MAC whose lease went away keeps its row, without the DHCP facts, while
 * the neighbour table lists it or while it has a sighting (presence reads
 * `dhcp_seen_at`/`neighbor_seen_at`); a row with neither goes at once, the
 * rest after `hostRetentionDays` (`gateway_observation_retention.ts`).
 *
 * The hostname lookup (`hostname_enrichment.ts`) reads the mirror of every
 * adopted, enabled collector that reported within `AGENT_FRESH_SECONDS`.
 */

export const OBSERVATION_KIND_DHCP = 'dhcp'

/** Most entries one report may carry per list; the rest are ignored. */
export const MAX_LEASES = 4096
export const MAX_STATIC_HOSTS = 1024
const MAX_V6_PER_MAC = 16
/**
 * A renewal dates a sighting from its lease time only when the lease is this
 * short: longer leases renew too rarely to say anything (the live gateway's
 * are 1200 days).
 */
export const MAX_SIGHTING_LEASE_SECONDS = 86_400

/**
 * A collector whose last DHCP report is older than this no longer counts as
 * a source: twice the longest resend interval the collector accepts
 * (`dhcp_leases_refresh` ≤ 3600 s), so only a gone agent crosses it. A
 * protocol bound, not a tunable.
 */
export const AGENT_FRESH_SECONDS = 7200

export { MAX_REMEMBERED_OBSERVATIONS } from '#services/gateway_observation_common'

export const normalizeMac = normalizeMacCommon

export type DhcpLease4 = {
  mac: string
  ip: string
  hostname: string | null
  /** Unix seconds; 0 = infinite. */
  expires: number
  /** Seconds, when the agent knows the lease time (sent, or its pool's); else null. */
  leaseTime: number | null
  /** The logical network whose subnet holds `ip`, when the agent knows it. */
  network: string | null
}

export type DhcpLease6 = {
  duid: string
  /** Sent by the agent, else from the DUID (types 1 and 3 with Ethernet hardware), else null. */
  mac: string | null
  addresses: string[]
  hostname: string | null
  validUntil: number
}

export type DhcpStaticHost = {
  name: string
  macs: string[]
  ip: string | null
}

/** One UCI `config dhcp` section as the agent reports it. */
export type DhcpPool = {
  network: string
  /** DHCP not served on it (`ignore '1'`). */
  ignore: boolean
  /** Seconds; 0 = infinite. */
  leaseTime: number
  start: number | null
  limit: number | null
}

export type DhcpObservation = {
  pools: DhcpPool[]
  leases4: DhcpLease4[]
  leases6: DhcpLease6[]
  /** Null: the report did not carry them (the previous report's apply). */
  hosts: DhcpStaticHost[] | null
}

/** One `gateway_hosts` row's DHCP facts as written. */
export type GatewayHostRow = {
  mac: string
  hostname: string | null
  staticName: string | null
  ipv4: string | null
  ipv6: string[]
  hasLease: boolean
  /** The lease's network as the agent reported it. */
  network: string | null
  leaseExpiresAt: DateTime | null
  leaseInfinite: boolean
  /** Latest expiry − lease time over the MAC's leases with a short known lease time. */
  renewedAt: DateTime | null
}

// ── normalisation ─────────────────────────────────────────────────────────

/**
 * The MAC a DHCPv6 DUID carries: DUID-LLT (type 1: hardware type, time,
 * link-layer address) and DUID-LL (type 3: hardware type, link-layer
 * address) with hardware type 1 (Ethernet). Null for every other DUID.
 */
export function macFromDuid(duid: string): string | null {
  const hex = duid.toLowerCase().replace(/[^0-9a-f]/g, '')
  const type = hex.slice(0, 4)
  const hwtype = hex.slice(4, 8)
  if (hwtype !== '0001') return null
  let lladdr: string
  if (type === '0001' && hex.length === 28) lladdr = hex.slice(16)
  else if (type === '0003' && hex.length === 20) lladdr = hex.slice(8)
  else return null
  return normalizeMac(lladdr)
}

function normalizeStaticHosts(value: unknown): DhcpStaticHost[] {
  const out: DhcpStaticHost[] = []
  for (const entry of list(value)) {
    if (out.length >= MAX_STATIC_HOSTS) break
    if (!isObject(entry)) continue
    const name = text(entry.name)
    if (!name) continue
    const macs = [
      ...new Set(
        list(entry.macs)
          .map(normalizeMac)
          .filter((m): m is string => m !== null)
      ),
    ].slice(0, 16)
    const ip = ipv4(entry.ip)
    if (macs.length === 0 && !ip) continue
    out.push({ name, macs, ip })
  }
  return out
}

/**
 * The `dhcp` part as the controller keeps it, or null when it is not one
 * (not an object). Missing lease lists read as empty (the part is a full
 * snapshot of the leases); a missing `hosts` reads as "not reported".
 * Bad entries are dropped one by one.
 */
export function normalizeDhcpObservation(value: unknown): DhcpObservation | null {
  if (!isObject(value)) return null
  const out: DhcpObservation = {
    pools: [],
    leases4: [],
    leases6: [],
    hosts: value.hosts === undefined || value.hosts === null ? null : [],
  }

  for (const entry of list(value.pools)) {
    if (out.pools.length >= 256) break
    if (!isObject(entry)) continue
    const network = text(entry.network, 32)
    const leaseTime = unixSeconds(entry.leaseTime)
    if (!network || leaseTime === null) continue
    out.pools.push({
      network,
      ignore: entry.ignore === true,
      leaseTime,
      start: unixSeconds(entry.start),
      limit: unixSeconds(entry.limit),
    })
  }
  const poolLeaseTime = new Map(out.pools.map((p) => [p.network, p.leaseTime]))

  for (const entry of list(value.leases4)) {
    if (out.leases4.length >= MAX_LEASES) break
    if (!isObject(entry)) continue
    const mac = normalizeMac(entry.mac)
    const ip = ipv4(entry.ip)
    const expires = unixSeconds(entry.expires)
    if (!mac || !ip || expires === null) continue
    const network = text(entry.network, 32)
    // The lease's own lease time, else its pool's (perch-collector sends `pools`).
    const leaseTime =
      unixSeconds(entry.leaseTime) ?? (network ? (poolLeaseTime.get(network) ?? null) : null)
    out.leases4.push({
      mac,
      ip,
      hostname: text(entry.hostname),
      expires,
      leaseTime: leaseTime && leaseTime > 0 ? leaseTime : null,
      network,
    })
  }

  for (const entry of list(value.leases6)) {
    if (out.leases6.length >= MAX_LEASES) break
    if (!isObject(entry)) continue
    const duid =
      typeof entry.duid === 'string' && /^[0-9a-fA-F:]{4,260}$/.test(entry.duid)
        ? entry.duid.toLowerCase().replace(/:/g, '')
        : null
    const validUntil = unixSeconds(entry.validUntil)
    if (!duid || validUntil === null) continue
    const addresses = list(entry.addresses)
      .map(ipv6)
      .filter((a): a is string => a !== null)
      .slice(0, MAX_V6_PER_MAC)
    out.leases6.push({
      duid,
      mac: normalizeMac(entry.mac) ?? macFromDuid(duid),
      addresses,
      hostname: text(entry.hostname),
      validUntil,
    })
  }

  if (out.hosts !== null) out.hosts = normalizeStaticHosts(value.hosts)
  return out
}

function laterExpiry(a: number, b: number): boolean {
  if (a === 0) return b !== 0
  if (b === 0) return false
  return a > b
}

/**
 * One row per MAC: the IPv4 lease that expires last gives the address and
 * the expiry, the hostname comes from the latest lease that has one (IPv4
 * first, then DHCPv6), DHCPv6 addresses of leases whose MAC is known (sent,
 * from the DUID, or `v6Macs`: the neighbour table's address → MAC) are
 * collected, and the last static host naming the MAC gives `staticName`
 * (and the address when there is no lease). Sorted by MAC.
 */
export function foldGatewayHosts(
  obs: DhcpObservation,
  v6Macs: ReadonlyMap<string, string> = new Map()
): GatewayHostRow[] {
  type Acc = {
    lease: DhcpLease4 | null
    named: DhcpLease4 | null
    v6Name: { hostname: string; validUntil: number } | null
    v6: Set<string>
    staticName: string | null
    staticIp: string | null
    renewed: number | null
  }
  const byMac = new Map<string, Acc>()
  const acc = (mac: string): Acc => {
    let a = byMac.get(mac)
    if (!a) {
      a = {
        lease: null,
        named: null,
        v6Name: null,
        v6: new Set(),
        staticName: null,
        staticIp: null,
        renewed: null,
      }
      byMac.set(mac, a)
    }
    return a
  }

  for (const lease of obs.leases4) {
    const a = acc(lease.mac)
    if (!a.lease || laterExpiry(lease.expires, a.lease.expires)) a.lease = lease
    if (lease.hostname && (!a.named || laterExpiry(lease.expires, a.named.expires))) {
      a.named = lease
    }
    if (lease.leaseTime && lease.leaseTime <= MAX_SIGHTING_LEASE_SECONDS && lease.expires > 0) {
      const renewed = lease.expires - lease.leaseTime
      if (a.renewed === null || renewed > a.renewed) a.renewed = renewed
    }
  }
  for (const lease of obs.leases6) {
    const mac =
      lease.mac ??
      lease.addresses.map((address) => v6Macs.get(address)).find((m) => m !== undefined) ??
      null
    if (!mac) continue
    const a = acc(mac)
    for (const address of lease.addresses) {
      if (a.v6.size < MAX_V6_PER_MAC) a.v6.add(address)
    }
    if (lease.hostname && (!a.v6Name || laterExpiry(lease.validUntil, a.v6Name.validUntil))) {
      a.v6Name = { hostname: lease.hostname, validUntil: lease.validUntil }
    }
  }
  for (const host of obs.hosts ?? []) {
    for (const mac of host.macs) {
      // The last section naming a MAC wins, as with dnsmasq's own reading.
      const a = acc(mac)
      a.staticName = host.name
      a.staticIp = host.ip
    }
  }

  return [...byMac.entries()]
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([mac, a]) => ({
      mac,
      hostname: a.named?.hostname ?? a.v6Name?.hostname ?? null,
      staticName: a.staticName,
      ipv4: a.lease?.ip ?? a.staticIp,
      ipv6: [...a.v6].sort(),
      hasLease: a.lease !== null,
      network: a.lease?.network ?? null,
      leaseExpiresAt:
        a.lease && a.lease.expires > 0
          ? DateTime.fromSeconds(a.lease.expires, { zone: 'utc' })
          : null,
      leaseInfinite: a.lease?.expires === 0,
      renewedAt: a.renewed === null ? null : DateTime.fromSeconds(a.renewed, { zone: 'utc' }),
    }))
}

/** Static hosts without a MAC: matched by address only. */
export function ipOnlyHosts(obs: DhcpObservation): { name: string; ip: string }[] {
  return (obs.hosts ?? [])
    .filter((h) => h.macs.length === 0 && h.ip)
    .map((h) => ({ name: h.name, ip: h.ip! }))
}

/** `gateway_observations.payload` of a `dhcp` row. */
export type ObservationPayload = {
  leases4: number
  leases6: number
  hosts: number
  rows: number
  named: number
  ipOnlyHosts: { name: string; ip: string }[]
  /** The static hosts in force, carried into a later report that leaves them out. */
  staticHosts: DhcpStaticHost[]
  /** The pools the agent reported (lease time per network). */
  pools: DhcpPool[]
}

function parsePayload(raw: string | null): ObservationPayload {
  const out: ObservationPayload = {
    leases4: 0,
    leases6: 0,
    hosts: 0,
    rows: 0,
    named: 0,
    ipOnlyHosts: [],
    staticHosts: [],
    pools: [],
  }
  const parsed = parseJsonObject(raw)
  if (!parsed) return out
  for (const key of ['leases4', 'leases6', 'hosts', 'rows', 'named'] as const) {
    if (typeof parsed[key] === 'number') out[key] = parsed[key] as number
  }
  if (Array.isArray(parsed.ipOnlyHosts)) {
    out.ipOnlyHosts = parsed.ipOnlyHosts.filter(
      (h): h is { name: string; ip: string } =>
        isObject(h) && typeof h.name === 'string' && typeof h.ip === 'string'
    )
  }
  out.staticHosts = normalizeStaticHosts(parsed.staticHosts)
  out.pools = normalizeDhcpObservation({ pools: parsed.pools })?.pools ?? []
  return out
}

export function observationFingerprint(obs: DhcpObservation): string {
  return fingerprintOf(obs)
}

/**
 * Bumped on every write that changes what the hostname lookup would read, so
 * its cache (one entry) knows to reload. In-process, like the scheduler: the
 * API is single-instance.
 */
let version = 0

export function gatewayDhcpVersion(): number {
  return version
}

/** Called by the other host writers (neighbours) when names may have moved. */
export function bumpGatewayDhcpVersion(): void {
  version++
}

/** Test-only: forget every per-collector memory of the observation channel. */
export function _resetGatewayDhcpState(): void {
  forgetObservations()
  version++
}

// ── writes ────────────────────────────────────────────────────────────────

export type DhcpRecordOutcome = 'written' | 'unchanged' | 'invalid'

/** IPv6 neighbour address → MAC from the host mirror, for DHCPv6 leases without one. */
async function v6NeighborMacs(collectorId: number): Promise<Map<string, string>> {
  const rows = rawRows<{ mac: string; neighborIpv6: string | null }>(
    await db.rawQuery(
      `SELECT mac, neighbor_ipv6 AS neighborIpv6 FROM gateway_hosts
        WHERE collector_id = ? AND neighbor_ipv6 IS NOT NULL`,
      [collectorId]
    )
  )
  const out = new Map<string, string>()
  for (const row of rows) {
    for (const address of parseJsonArray(row.neighborIpv6)) out.set(address, row.mac)
  }
  return out
}

/**
 * Mirrors one `dhcp` report of a collector. Absent/invalid input writes
 * nothing. Callers make it non-fatal (a failure costs one report); the
 * observation channel serialises it with the collector's other parts
 * (`gateway_observe.ts`).
 */
export async function recordDhcpObservation(
  collectorId: number,
  raw: unknown,
  now: DateTime = DateTime.utc()
): Promise<DhcpRecordOutcome> {
  const obs = normalizeDhcpObservation(raw)
  if (!obs) return 'invalid'

  const last = await lastWritten(collectorId, OBSERVATION_KIND_DHCP)
  if (obs.hosts === null) {
    // Not reported this time: the static hosts in force stay.
    const stored = rawRows<{ payload: string | null }>(
      await db.rawQuery(
        'SELECT payload FROM gateway_observations WHERE collector_id = ? AND kind = ?',
        [collectorId, OBSERVATION_KIND_DHCP]
      )
    )
    obs.hosts = stored[0] ? parsePayload(stored[0].payload).staticHosts : []
  }
  const fingerprint = observationFingerprint(obs)

  if (last && last.fingerprint === fingerprint) {
    if (await refreshObservedAt(collectorId, OBSERVATION_KIND_DHCP, last, now)) {
      if (last.observedWrittenAt === 0) version++ // first sight since start: freshness may change
    }
    return 'unchanged'
  }

  const rows = foldGatewayHosts(
    obs,
    obs.leases6.length > 0 ? await v6NeighborMacs(collectorId) : new Map()
  )
  const stamp = sqlTime(now)
  const nowSeconds = Math.floor(now.toSeconds())

  // A lease whose expiry moved forward was renewed since the last report: a
  // DHCP exchange, so a sighting now.
  const previous = new Map(
    rawRows<{ mac: string; expires: number | string | null }>(
      await db.rawQuery(
        `SELECT mac, TIMESTAMPDIFF(SECOND, '1970-01-01 00:00:00', lease_expires_at) AS expires
           FROM gateway_hosts WHERE collector_id = ? AND lease_expires_at IS NOT NULL`,
        [collectorId]
      )
    ).map((r) => [r.mac, r.expires === null ? null : Number(r.expires)])
  )
  const seenAt = (row: GatewayHostRow): string | null => {
    let seen: number | null = null
    const before = previous.get(row.mac)
    const expires = row.leaseExpiresAt ? Math.floor(row.leaseExpiresAt.toSeconds()) : null
    if (before !== undefined && before !== null && expires !== null && expires > before) {
      seen = nowSeconds
    }
    if (row.renewedAt) {
      const renewed = Math.min(Math.floor(row.renewedAt.toSeconds()), nowSeconds)
      if (seen === null || renewed > seen) seen = renewed
    }
    return seen === null ? null : sqlTime(DateTime.fromSeconds(seen, { zone: 'utc' }))
  }

  const payload = {
    leases4: obs.leases4.length,
    leases6: obs.leases6.length,
    hosts: obs.hosts.length,
    rows: rows.length,
    named: rows.filter((r) => r.hostname || r.staticName).length,
    // Static hosts with an address but no MAC have no row; the lookup
    // matches them by address, like the command path always did.
    ipOnlyHosts: ipOnlyHosts(obs),
    staticHosts: obs.hosts,
    pools: obs.pools,
  } satisfies ObservationPayload

  await db.transaction(async (trx) => {
    const macs = rows.map((r) => r.mac)
    // Rows this report no longer lists lose their DHCP facts.
    await trx.rawQuery(
      `UPDATE gateway_hosts
          SET dhcp_present = 0, has_lease = 0, hostname = NULL, static_name = NULL,
              ipv4 = NULL, ipv6 = NULL, lease_expires_at = NULL, lease_infinite = 0,
              last_reported_at = ?
        WHERE collector_id = ? AND dhcp_present = 1
          ${macs.length > 0 ? `AND mac NOT IN (${macs.map(() => '?').join(',')})` : ''}`,
      [stamp, collectorId, ...macs]
    )
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500)
      const values: (string | number | boolean | null)[] = []
      for (const r of chunk) {
        values.push(
          collectorId,
          r.mac,
          r.hostname,
          r.staticName,
          r.ipv4,
          r.ipv6.length > 0 ? JSON.stringify(r.ipv6) : null,
          r.hasLease,
          r.network,
          r.leaseExpiresAt ? sqlTime(r.leaseExpiresAt) : null,
          r.leaseInfinite,
          true,
          seenAt(r),
          stamp,
          stamp,
          stamp
        )
      }
      await trx.rawQuery(
        `INSERT INTO gateway_hosts
           (collector_id, mac, hostname, static_name, ipv4, ipv6, has_lease, network, lease_expires_at,
            lease_infinite, dhcp_present, dhcp_seen_at, last_reported_at, first_seen_at,
            updated_at)
         VALUES ${chunk.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}
         ON DUPLICATE KEY UPDATE
           hostname = VALUES(hostname), static_name = VALUES(static_name),
           ipv4 = VALUES(ipv4), ipv6 = VALUES(ipv6), has_lease = VALUES(has_lease),
           network = COALESCE(VALUES(network), network),
           lease_expires_at = VALUES(lease_expires_at),
           lease_infinite = VALUES(lease_infinite), dhcp_present = 1,
           dhcp_seen_at = CASE
             WHEN VALUES(dhcp_seen_at) IS NULL THEN dhcp_seen_at
             WHEN dhcp_seen_at IS NULL THEN VALUES(dhcp_seen_at)
             ELSE GREATEST(dhcp_seen_at, VALUES(dhcp_seen_at)) END,
           last_reported_at = VALUES(last_reported_at), updated_at = VALUES(updated_at)`,
        // NULL is a valid binding at runtime; Lucid's type leaves it out.
        values as StrictValues[]
      )
    }
    await deleteUnsightedOrphans(trx, collectorId)
    await writeObservationRow(trx, collectorId, OBSERVATION_KIND_DHCP, payload, fingerprint, now)
  })

  remember(collectorId, OBSERVATION_KIND_DHCP, { fingerprint, observedWrittenAt: now.toMillis() })
  version++
  logger.debug(
    { collectorId, leases4: obs.leases4.length, hosts: obs.hosts.length, rows: rows.length },
    'gateway_dhcp: observation written'
  )
  return 'written'
}

/**
 * Drops rows no report lists and that never had a sighting: nothing about
 * them is worth keeping. Rows with a sighting stay for the retention task.
 */
export async function deleteUnsightedOrphans(
  client: { rawQuery: (sql: string, bindings: StrictValues[]) => Promise<unknown> },
  collectorId: number
): Promise<void> {
  await client.rawQuery(
    `DELETE FROM gateway_hosts
      WHERE collector_id = ? AND dhcp_present = 0 AND neighbor_present = 0
        AND dhcp_seen_at IS NULL AND neighbor_seen_at IS NULL`,
    [collectorId]
  )
}

// ── reads ─────────────────────────────────────────────────────────────────

export type DhcpAgentSource = {
  collectorId: number
  name: string
  /** Adopted, enabled and reported within `AGENT_FRESH_SECONDS`. */
  active: boolean
  observedAt: string
  changedAt: string
  secondsSinceReport: number
  counts: { leases4: number; leases6: number; hosts: number; rows: number; named: number }
  /** Static hosts without a MAC (matched by address). */
  ipOnlyHosts: { name: string; ip: string }[]
}

/** Every collector that has ever reported `dhcp`, newest report first. */
export async function listDhcpAgentSources(): Promise<DhcpAgentSource[]> {
  const rows = rawRows<{
    collectorId: number
    name: string
    lifecycle: string
    enabled: number | boolean
    payload: string | null
    observedAt: string | Date
    changedAt: string | Date
    age: number | string
  }>(
    await db.rawQuery(
      `SELECT o.collector_id AS collectorId, c.name AS name, c.lifecycle AS lifecycle,
              c.enabled AS enabled, o.payload AS payload,
              DATE_FORMAT(o.observed_at, '%Y-%m-%dT%H:%i:%sZ') AS observedAt,
              DATE_FORMAT(o.changed_at, '%Y-%m-%dT%H:%i:%sZ') AS changedAt,
              TIMESTAMPDIFF(SECOND, o.observed_at, UTC_TIMESTAMP()) AS age
         FROM gateway_observations o
         JOIN collectors c ON c.id = o.collector_id
        WHERE o.kind = ?
        ORDER BY o.observed_at DESC`,
      [OBSERVATION_KIND_DHCP]
    )
  )
  return rows.map((row) => {
    const payload = parsePayload(row.payload)
    const counts = {
      leases4: payload.leases4,
      leases6: payload.leases6,
      hosts: payload.hosts,
      rows: payload.rows,
      named: payload.named,
    }
    const ipOnly = payload.ipOnlyHosts
    const age = Math.max(0, Number(row.age))
    return {
      collectorId: Number(row.collectorId),
      name: row.name,
      active:
        row.lifecycle === 'adopted' && Boolean(Number(row.enabled)) && age <= AGENT_FRESH_SECONDS,
      observedAt: String(row.observedAt),
      changedAt: String(row.changedAt),
      secondsSinceReport: age,
      counts,
      ipOnlyHosts: ipOnly,
    }
  })
}

export type GatewayHostRecord = {
  collectorId: number
  mac: string
  hostname: string | null
  staticName: string | null
  ipv4: string | null
  ipv6: string[]
}

/** The DHCP mirror of the given collectors (rows the latest DHCP report lists). */
export async function readGatewayHosts(collectorIds: number[]): Promise<GatewayHostRecord[]> {
  if (collectorIds.length === 0) return []
  const rows = rawRows<{
    collectorId: number
    mac: string
    hostname: string | null
    staticName: string | null
    ipv4: string | null
    ipv6: string | null
  }>(
    await db.rawQuery(
      `SELECT collector_id AS collectorId, mac, hostname, static_name AS staticName, ipv4, ipv6
         FROM gateway_hosts
        WHERE collector_id IN (${collectorIds.map(() => '?').join(',')}) AND dhcp_present = 1
        ORDER BY collector_id, mac`,
      collectorIds
    )
  )
  return rows.map((row) => ({
    collectorId: Number(row.collectorId),
    mac: row.mac,
    hostname: row.hostname,
    staticName: row.staticName,
    ipv4: row.ipv4,
    ipv6: parseJsonArray(row.ipv6),
  }))
}
