import db from '@adonisjs/lucid/services/db'
import type { StrictValues } from '@adonisjs/lucid/types/querybuilder'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'
import { createHash } from 'node:crypto'
import { isIPv4, isIPv6 } from 'node:net'

/**
 * The Gateway agent's DHCP observation (docs/collector-agent.md section 4.3):
 * perch-collector on the router sends `observe.dhcp` — its leases and the
 * static hosts of `/etc/config/dhcp` — inside `collector.push` when they
 * change, at the start of each session and every `dhcp_leases_refresh`
 * (default 10 min, at most 1 h); a polled collector serves it with every
 * summary. The section is a full snapshot and lands here: normalised,
 * folded to one row per MAC and mirrored into `gateway_hosts`, with the
 * report's fingerprint and time in `gateway_observations`.
 *
 * An absent section means "nothing new" and writes nothing. An unchanged
 * report (same fingerprint as the last one written, remembered per collector
 * in a bounded map and in `gateway_observations`) only refreshes
 * `observed_at`, at most once a minute.
 *
 * The hostname lookup (`hostname_enrichment.ts`) reads the mirror of every
 * adopted, enabled collector that reported within `AGENT_FRESH_SECONDS`.
 */

export const OBSERVATION_KIND_DHCP = 'dhcp'

/** Most entries one report may carry per list; the rest are ignored. */
export const MAX_LEASES = 4096
export const MAX_STATIC_HOSTS = 1024
/** Entries looked at per list, junk included, so no report can make the server loop. */
const MAX_SCANNED = 8192
const MAX_TEXT = 253
const MAX_V6_PER_MAC = 16

/**
 * A collector whose last DHCP report is older than this no longer counts as
 * a source: twice the longest resend interval the collector accepts
 * (`dhcp_leases_refresh` ≤ 3600 s), so only a gone agent crosses it. A
 * protocol bound, not a tunable.
 */
export const AGENT_FRESH_SECONDS = 7200

/** Collectors whose last write is remembered; the least recently written is evicted first. */
export const MAX_REMEMBERED_OBSERVATIONS = 256
/** An unchanged report refreshes `observed_at` at most this often. */
const OBSERVED_AT_REFRESH_MS = 60_000

const MAC_REGEX = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

export type DhcpLease4 = {
  mac: string
  ip: string
  hostname: string | null
  /** Unix seconds; 0 = infinite. */
  expires: number
}

export type DhcpLease6 = {
  duid: string
  /** From the DUID (types 1 and 3 with Ethernet hardware), else null. */
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

export type DhcpObservation = {
  leases4: DhcpLease4[]
  leases6: DhcpLease6[]
  hosts: DhcpStaticHost[]
}

/** One `gateway_hosts` row as written. */
export type GatewayHostRow = {
  mac: string
  hostname: string | null
  staticName: string | null
  ipv4: string | null
  ipv6: string[]
  leaseExpiresAt: DateTime | null
  leaseInfinite: boolean
}

// ── normalisation ─────────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(CONTROL_CHARS, '').trim()
  if (!cleaned || cleaned === '*' || cleaned.length > MAX_TEXT) return null
  return cleaned
}

export function normalizeMac(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let cleaned = value.trim().toLowerCase().replace(/-/g, ':')
  if (/^[0-9a-f]{12}$/.test(cleaned)) cleaned = cleaned.match(/../g)!.join(':')
  return MAC_REGEX.test(cleaned) ? cleaned : null
}

function unixSeconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 2 ** 40
    ? value
    : null
}

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

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, MAX_SCANNED) : []
}

/**
 * The `dhcp` part of an `observe` section as the controller keeps it, or
 * null when it is not one (not an object). Missing lists read as empty: the
 * section is a full snapshot. Bad entries are dropped one by one.
 */
export function normalizeDhcpObservation(value: unknown): DhcpObservation | null {
  if (!isObject(value)) return null
  const out: DhcpObservation = { leases4: [], leases6: [], hosts: [] }

  for (const entry of list(value.leases4)) {
    if (out.leases4.length >= MAX_LEASES) break
    if (!isObject(entry)) continue
    const mac = normalizeMac(entry.mac)
    const ip = typeof entry.ip === 'string' && isIPv4(entry.ip.trim()) ? entry.ip.trim() : null
    const expires = unixSeconds(entry.expires)
    if (!mac || !ip || expires === null) continue
    out.leases4.push({ mac, ip, hostname: text(entry.hostname), expires })
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
      .filter((a): a is string => typeof a === 'string' && isIPv6(a.trim()))
      .map((a) => a.trim().toLowerCase())
      .slice(0, MAX_V6_PER_MAC)
    out.leases6.push({
      duid,
      mac: macFromDuid(duid),
      addresses,
      hostname: text(entry.hostname),
      validUntil,
    })
  }

  for (const entry of list(value.hosts)) {
    if (out.hosts.length >= MAX_STATIC_HOSTS) break
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
    const ip = typeof entry.ip === 'string' && isIPv4(entry.ip.trim()) ? entry.ip.trim() : null
    if (macs.length === 0 && !ip) continue
    out.hosts.push({ name, macs, ip })
  }

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
 * first, then DHCPv6), DHCPv6 addresses whose DUID carries the MAC are
 * collected, and the last static host naming the MAC gives `staticName`
 * (and the address when there is no lease). Sorted by MAC.
 */
export function foldGatewayHosts(obs: DhcpObservation): GatewayHostRow[] {
  type Acc = {
    lease: DhcpLease4 | null
    named: DhcpLease4 | null
    v6Name: { hostname: string; validUntil: number } | null
    v6: Set<string>
    staticName: string | null
    staticIp: string | null
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
  }
  for (const lease of obs.leases6) {
    if (!lease.mac) continue
    const a = acc(lease.mac)
    for (const address of lease.addresses) {
      if (a.v6.size < MAX_V6_PER_MAC) a.v6.add(address)
    }
    if (lease.hostname && (!a.v6Name || laterExpiry(lease.validUntil, a.v6Name.validUntil))) {
      a.v6Name = { hostname: lease.hostname, validUntil: lease.validUntil }
    }
  }
  for (const host of obs.hosts) {
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
      leaseExpiresAt:
        a.lease && a.lease.expires > 0
          ? DateTime.fromSeconds(a.lease.expires, { zone: 'utc' })
          : null,
      leaseInfinite: a.lease?.expires === 0,
    }))
}

/** Static hosts without a MAC: matched by address only. */
export function ipOnlyHosts(obs: DhcpObservation): { name: string; ip: string }[] {
  return obs.hosts
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
}

function parsePayload(raw: string | null): ObservationPayload {
  const out: ObservationPayload = {
    leases4: 0,
    leases6: 0,
    hosts: 0,
    rows: 0,
    named: 0,
    ipOnlyHosts: [],
  }
  try {
    const parsed = raw ? JSON.parse(raw) : null
    if (!isObject(parsed)) return out
    for (const key of ['leases4', 'leases6', 'hosts', 'rows', 'named'] as const) {
      if (typeof parsed[key] === 'number') out[key] = parsed[key] as number
    }
    if (Array.isArray(parsed.ipOnlyHosts)) {
      out.ipOnlyHosts = parsed.ipOnlyHosts.filter(
        (h): h is { name: string; ip: string } =>
          isObject(h) && typeof h.name === 'string' && typeof h.ip === 'string'
      )
    }
  } catch {}
  return out
}

export function observationFingerprint(obs: DhcpObservation): string {
  return createHash('sha256').update(JSON.stringify(obs)).digest('hex')
}

// ── the last write per collector ──────────────────────────────────────────

type Remembered = { fingerprint: string; observedWrittenAt: number }

/** Bounded: at most `MAX_REMEMBERED_OBSERVATIONS` collectors, least recently written evicted. */
const remembered = new Map<number, Remembered>()

function remember(collectorId: number, entry: Remembered) {
  remembered.delete(collectorId)
  remembered.set(collectorId, entry)
  while (remembered.size > MAX_REMEMBERED_OBSERVATIONS) {
    const oldest = remembered.keys().next().value
    if (oldest === undefined) break
    remembered.delete(oldest)
  }
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

/** Test-only: forget the per-collector cache. */
export function _resetGatewayDhcpState(): void {
  remembered.clear()
  version++
}

// ── writes ────────────────────────────────────────────────────────────────

const SQL_DATETIME = 'yyyy-MM-dd HH:mm:ss'

function sqlTime(value: DateTime): string {
  return value.toUTC().toFormat(SQL_DATETIME)
}

function rawRows<T>(result: unknown): T[] {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0] as T[]
  return []
}

export type DhcpRecordOutcome = 'written' | 'unchanged' | 'invalid'

/**
 * Mirrors one `observe.dhcp` report of a collector. Absent/invalid input
 * writes nothing. Callers make it non-fatal (a failure costs one report).
 */
export async function recordDhcpObservation(
  collectorId: number,
  raw: unknown,
  now: DateTime = DateTime.utc()
): Promise<DhcpRecordOutcome> {
  const obs = normalizeDhcpObservation(raw)
  if (!obs) return 'invalid'
  const fingerprint = observationFingerprint(obs)
  const nowMs = now.toMillis()

  let last = remembered.get(collectorId)
  if (!last) {
    const rows = rawRows<{ fingerprint: string }>(
      await db.rawQuery(
        'SELECT fingerprint FROM gateway_observations WHERE collector_id = ? AND kind = ?',
        [collectorId, OBSERVATION_KIND_DHCP]
      )
    )
    if (rows[0]) last = { fingerprint: rows[0].fingerprint, observedWrittenAt: 0 }
  }

  if (last && last.fingerprint === fingerprint) {
    if (nowMs - last.observedWrittenAt >= OBSERVED_AT_REFRESH_MS) {
      await db.rawQuery(
        'UPDATE gateway_observations SET observed_at = ? WHERE collector_id = ? AND kind = ?',
        [sqlTime(now), collectorId, OBSERVATION_KIND_DHCP]
      )
      if (last.observedWrittenAt === 0) version++ // first sight since start: freshness may change
      remember(collectorId, { fingerprint, observedWrittenAt: nowMs })
    }
    return 'unchanged'
  }

  const rows = foldGatewayHosts(obs)
  const stamp = sqlTime(now)
  const payload = JSON.stringify({
    leases4: obs.leases4.length,
    leases6: obs.leases6.length,
    hosts: obs.hosts.length,
    rows: rows.length,
    named: rows.filter((r) => r.hostname || r.staticName).length,
    // Static hosts with an address but no MAC have no row; the lookup
    // matches them by address, like the command path always did.
    ipOnlyHosts: ipOnlyHosts(obs),
  } satisfies ObservationPayload)

  await db.transaction(async (trx) => {
    if (rows.length === 0) {
      await trx.rawQuery('DELETE FROM gateway_hosts WHERE collector_id = ?', [collectorId])
    } else {
      const macs = rows.map((r) => r.mac)
      await trx.rawQuery(
        `DELETE FROM gateway_hosts WHERE collector_id = ? AND mac NOT IN (${macs.map(() => '?').join(',')})`,
        [collectorId, ...macs]
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
            r.leaseExpiresAt ? sqlTime(r.leaseExpiresAt) : null,
            r.leaseInfinite,
            stamp,
            stamp
          )
        }
        await trx.rawQuery(
          `INSERT INTO gateway_hosts
             (collector_id, mac, hostname, static_name, ipv4, ipv6, lease_expires_at,
              lease_infinite, first_seen_at, updated_at)
           VALUES ${chunk.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',')}
           ON DUPLICATE KEY UPDATE
             hostname = VALUES(hostname), static_name = VALUES(static_name),
             ipv4 = VALUES(ipv4), ipv6 = VALUES(ipv6),
             lease_expires_at = VALUES(lease_expires_at),
             lease_infinite = VALUES(lease_infinite), updated_at = VALUES(updated_at)`,
          // NULL is a valid binding at runtime; Lucid's type leaves it out.
          values as StrictValues[]
        )
      }
    }
    await trx.rawQuery(
      `INSERT INTO gateway_observations
         (collector_id, kind, payload, fingerprint, observed_at, changed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE payload = VALUES(payload), fingerprint = VALUES(fingerprint),
         observed_at = VALUES(observed_at), changed_at = VALUES(changed_at)`,
      [collectorId, OBSERVATION_KIND_DHCP, payload, fingerprint, stamp, stamp]
    )
  })

  remember(collectorId, { fingerprint, observedWrittenAt: nowMs })
  version++
  logger.debug(
    { collectorId, leases4: obs.leases4.length, hosts: obs.hosts.length, rows: rows.length },
    'gateway_dhcp: observation written'
  )
  return 'written'
}

/**
 * Serialises the reports of one collector (a push's observation is handled
 * beside its traffic ingest, which may drop or coalesce pushes; this one
 * never drops a changed report). One pending promise per collector at most.
 */
const chains = new Map<number, Promise<unknown>>()

export function recordDhcpObservationSerial(
  collectorId: number,
  raw: unknown,
  now: DateTime = DateTime.utc()
): Promise<DhcpRecordOutcome | 'failed'> {
  const previous = chains.get(collectorId) ?? Promise.resolve()
  const run = previous
    .catch(() => {})
    .then(() => recordDhcpObservation(collectorId, raw, now))
    .catch((error) => {
      logger.warn(
        { collectorId, error: String(error) },
        'gateway_dhcp: observation write failed (non-fatal)'
      )
      return 'failed' as const
    })
  chains.set(collectorId, run)
  void run.finally(() => {
    if (chains.get(collectorId) === run) chains.delete(collectorId)
  })
  return run
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

/** Every collector that has ever reported `observe.dhcp`, newest report first. */
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
    const { ipOnlyHosts: ipOnly, ...counts } = parsePayload(row.payload)
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

/** The mirror of the given collectors. */
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
        WHERE collector_id IN (${collectorIds.map(() => '?').join(',')})
        ORDER BY collector_id, mac`,
      collectorIds
    )
  )
  return rows.map((row) => {
    let ipv6: string[] = []
    try {
      const parsed = row.ipv6 ? JSON.parse(row.ipv6) : []
      if (Array.isArray(parsed)) ipv6 = parsed.filter((a) => typeof a === 'string')
    } catch {}
    return {
      collectorId: Number(row.collectorId),
      mac: row.mac,
      hostname: row.hostname,
      staticName: row.staticName,
      ipv4: row.ipv4,
      ipv6,
    }
  })
}
