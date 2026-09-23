import type Collector from '#models/collector'
import GatewayNetwork from '#models/gateway_network'
import {
  ensureGatewayForCollector,
  gatewayForCollector,
} from '#services/gateway_config/gateway_registry'
import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'

/**
 * Per-network accounting on the controller (plan 1 section 8.3, README 7.8
 * and 7.21; docs/gateway/networks.md section 4). Fed by every ingested
 * reading of a collector on the router:
 *
 * - `gateway.networks` → the live report per gateway (memory) and
 *   `gateway_network_samples` at most every 30 s, with the rate since the
 *   previous sample (like `router_samples`);
 * - the report's `capture.scope` → `gateway_scope_changes` when the scope
 *   rule changes (`routed`: routed LAN↔LAN and router-address traffic count
 *   as LAN; charts mark the date);
 * - `devices[].network` → `device_network_latest` and
 *   `device_network_history`, written on a change only (bounded fingerprint
 *   map, 4096 entries);
 * - the per-network capture flag (`gateway_networks.capture`): device rows
 *   attributed to a network whose capture is off are dropped before the
 *   traffic ingest, and `agent.configure` tells the collector to leave the
 *   network out (`capture.exclude`).
 *
 * Every in-process map here is bounded (CLAUDE.md cache rule).
 */

/** One row per gateway and network per this many ms, at most (the router_samples grid). */
export const NETWORK_SAMPLE_INTERVAL_MS = 30_000
const SAMPLE_SLACK_MS = 1500
/**
 * A rate needs two samples at most this far apart (like `qos_live.ts`): the
 * first sample after an outage would otherwise store the average over the
 * whole outage. Beyond it the rate is unknown (null), never an average.
 */
export const NETWORK_RATE_MAX_GAP_MS = 120_000
/** A live report (or the newest stored sample) older than this carries no current rate. */
export const LIVE_NETWORKS_MAX_AGE_MS = 90_000
const MAX_NETWORKS = 64
const MAX_NETWORK_NAME = 15
const MAX_GATEWAYS = 1024
export const DEVICE_FINGERPRINTS_MAX = 4096
const GATEWAY_CACHE_TTL_MS = 60_000

export type CaptureCounters = {
  bytesInWan: number
  bytesOutWan: number
  bytesInLan: number
  bytesOutLan: number
  packetsInWan: number
  packetsOutWan: number
  packetsInLan: number
  packetsOutLan: number
  scope: 'routed' | 'legacy' | null
  kernelDrops: number | null
}

/** One network of a `gateway.networks` report, cleaned. */
export type ReportedNetwork = {
  name: string
  device: string | null
  proto: string | null
  up: boolean
  ipv4: string[]
  ipv6: string[]
  /** Router-side `/proc/net/dev` counters (rx = received from the network). */
  rxBytes: number | null
  txBytes: number | null
  /** Bytes per second as the collector measured them. */
  rxRate: number | null
  txRate: number | null
  captured: boolean
  devices: number
  activeDevices: number
  capture: CaptureCounters | null
}

export type LiveNetworks = { reportedAt: string; networks: ReportedNetwork[] }

type WrittenSample = { at: number; counters: Map<string, { rx: number; tx: number }> }

// ── bounded state ────────────────────────────────────────────────────────

/** A Map that drops its oldest entry beyond `max` (insertion order; `touch` refreshes). */
class BoundedMap<K, V> extends Map<K, V> {
  constructor(readonly max: number) {
    super()
  }
  set(key: K, value: V): this {
    if (super.has(key)) super.delete(key)
    super.set(key, value)
    while (this.size > this.max) {
      const oldest = this.keys().next().value as K
      super.delete(oldest)
    }
    return this
  }
}

const live = new BoundedMap<number, LiveNetworks>(MAX_GATEWAYS)
const lastSample = new BoundedMap<number, WrittenSample>(MAX_GATEWAYS)
const lastScope = new BoundedMap<number, string>(MAX_GATEWAYS)
/** `${gatewayId}|${mac}` → network, the last one written. */
const deviceNetwork = new BoundedMap<string, string>(DEVICE_FINGERPRINTS_MAX)
/** collectorId → its gateway and the networks whose capture is off. */
type GatewayInfo = { gatewayId: number | null; excluded: string[]; at: number }
const gatewayInfo = new BoundedMap<number, GatewayInfo>(MAX_GATEWAYS)

export function _resetNetworkAccountingState() {
  live.clear()
  lastSample.clear()
  lastScope.clear()
  deviceNetwork.clear()
  gatewayInfo.clear()
}

// ── parsing ──────────────────────────────────────────────────────────────

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function strings(value: unknown, max = 32): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64)
    .slice(0, max)
}

function captureOf(value: unknown): CaptureCounters | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const c = value as Record<string, unknown>
  const n = (key: string) => count(c[key]) ?? 0
  return {
    bytesInWan: n('bytesInWan'),
    bytesOutWan: n('bytesOutWan'),
    bytesInLan: n('bytesInLan'),
    bytesOutLan: n('bytesOutLan'),
    packetsInWan: n('packetsInWan'),
    packetsOutWan: n('packetsOutWan'),
    packetsInLan: n('packetsInLan'),
    packetsOutLan: n('packetsOutLan'),
    scope: c.scope === 'routed' || c.scope === 'legacy' ? c.scope : null,
    kernelDrops: count(c.kernelDrops),
  }
}

/**
 * `gateway.networks` of a report: null when absent (not reported, e.g. an
 * older collector: nothing is touched), `[]` when the router has none.
 * Untrusted: at most 64 networks, names ≤ 15 characters, one entry per name.
 */
export function parseNetworksReport(value: unknown): ReportedNetwork[] | null {
  if (!Array.isArray(value)) return null
  const out: ReportedNetwork[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (out.length >= MAX_NETWORKS) break
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const e = entry as Record<string, unknown>
    const name = typeof e.name === 'string' ? e.name.trim() : ''
    if (!name || name.length > MAX_NETWORK_NAME || seen.has(name)) continue
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) continue
    seen.add(name)
    out.push({
      name,
      device: typeof e.device === 'string' && e.device.length > 0 ? e.device.slice(0, 32) : null,
      proto: typeof e.proto === 'string' ? e.proto.slice(0, 32) : null,
      up: e.up === true,
      ipv4: strings(e.ipv4),
      ipv6: strings(e.ipv6),
      rxBytes: count(e.rxBytes),
      txBytes: count(e.txBytes),
      rxRate: count(e.rxRate),
      txRate: count(e.txRate),
      captured: e.captured === true,
      devices: count(e.devices) ?? 0,
      activeDevices: count(e.activeDevices) ?? 0,
      capture: captureOf(e.capture),
    })
  }
  return out
}

/** The gateway's accounting scope from a report: `routed` when any capture says so. */
export function reportScope(networks: ReportedNetwork[]): 'routed' | 'legacy' | null {
  const scopes = networks.map((n) => n.capture?.scope).filter((s) => s !== null && s !== undefined)
  if (scopes.includes('routed')) return 'routed'
  if (scopes.includes('legacy')) return 'legacy'
  return null
}

// ── gateway lookup + capture flags ───────────────────────────────────────

async function loadGatewayInfo(collector: Collector | number): Promise<GatewayInfo> {
  const collectorId = typeof collector === 'number' ? collector : collector.id
  let gateway = await gatewayForCollector(collectorId)
  if (!gateway && typeof collector !== 'number') {
    gateway = await ensureGatewayForCollector(collector)
  }
  const excluded = gateway ? await excludedNetworks(gateway.id) : []
  const info = { gatewayId: gateway?.id ?? null, excluded, at: Date.now() }
  gatewayInfo.set(collectorId, info)
  return info
}

async function infoFor(collector: Collector): Promise<GatewayInfo> {
  const cached = gatewayInfo.get(collector.id)
  if (cached && Date.now() - cached.at < GATEWAY_CACHE_TTL_MS) return cached
  return loadGatewayInfo(collector)
}

/** Names of the gateway's networks whose capture is off. */
export async function excludedNetworks(gatewayId: number): Promise<string[]> {
  const rows = await GatewayNetwork.query()
    .where('gateway_id', gatewayId)
    .where('capture', false)
    .whereNotNull('network')
  return rows.map((r) => r.network!).sort()
}

/**
 * Re-reads a collector's capture flags (after a toggle, at hello). The
 * result is what `agent.configure` carries as `capture.exclude`.
 */
export async function refreshCaptureExclusions(collectorId: number): Promise<string[]> {
  const info = await loadGatewayInfo(collectorId)
  return info.excluded
}

/**
 * `capture.exclude` for the collector's `agent.configure`: undefined while
 * unknown (no gateway row read yet), else the networks whose capture is off
 * (`[]` = capture everything again).
 */
export function captureExcludeFor(collectorId: number): string[] | undefined {
  const info = gatewayInfo.get(collectorId)
  if (!info || info.gatewayId === null) return undefined
  return info.excluded
}

type DeviceLike = { mac: string; network?: unknown; networks?: unknown }

/**
 * Drops device rows attributed to a network whose capture is off (README
 * 7.21): the controller stores nothing of them even when the collector (an
 * older one) still captures there. Never throws: on a lookup error the rows
 * pass unchanged.
 */
export async function withoutExcludedDevices<T extends DeviceLike>(
  collector: Collector,
  devices: T[]
): Promise<T[]> {
  if (devices.length === 0) return devices
  if (!devices.some((d) => typeof d.network === 'string')) return devices
  try {
    const info = await infoFor(collector)
    if (info.excluded.length === 0) return devices
    return devices.filter(
      (d) => typeof d.network !== 'string' || !info.excluded.includes(d.network)
    )
  } catch (error) {
    logger.warn(
      { collectorId: collector.id, error: String(error) },
      'network accounting: capture flags unavailable'
    )
    return devices
  }
}

// ── ingest ───────────────────────────────────────────────────────────────

function sqlTime(at: DateTime): string {
  return at.toUTC().startOf('second').toFormat('yyyy-MM-dd HH:mm:ss')
}

/**
 * Records one reading's `gateway.networks` (non-fatal for the caller: it
 * throws only on a database error). Absent = nothing happens.
 */
export async function recordGatewayNetworks(
  collector: Collector,
  report: unknown,
  receivedAt: DateTime
): Promise<void> {
  const networks = parseNetworksReport(report)
  if (networks === null) return
  const info = await infoFor(collector)
  if (info.gatewayId === null) return
  const gatewayId = info.gatewayId
  live.set(gatewayId, { reportedAt: receivedAt.toUTC().toISO()!, networks })

  const scope = reportScope(networks)
  if (scope) await noteScope(gatewayId, scope, receivedAt)

  const at = receivedAt.toMillis()
  const previous = lastSample.get(gatewayId)
  if (previous && at - previous.at < NETWORK_SAMPLE_INTERVAL_MS - SAMPLE_SLACK_MS) return
  const counted = networks.filter((n) => n.rxBytes !== null && n.txBytes !== null)
  lastSample.set(gatewayId, {
    at,
    counters: new Map(counted.map((n) => [n.name, { rx: n.rxBytes!, tx: n.txBytes! }])),
  })
  if (counted.length === 0) return
  const gapMs = previous ? at - previous.at : 0
  const seconds = previous && gapMs <= NETWORK_RATE_MAX_GAP_MS ? gapMs / 1000 : 0
  const recordedAt = sqlTime(receivedAt)
  const rows = counted.map((n) => {
    const before = previous?.counters.get(n.name)
    let rxBps: number | null = null
    let txBps: number | null = null
    // A counter that went backwards (the device was recreated) has no rate.
    if (before && seconds > 0 && n.rxBytes! >= before.rx && n.txBytes! >= before.tx) {
      rxBps = Math.round(((n.rxBytes! - before.rx) * 8) / seconds)
      txBps = Math.round(((n.txBytes! - before.tx) * 8) / seconds)
    }
    return {
      gateway_id: gatewayId,
      network: n.name,
      recorded_at: recordedAt,
      rx_bytes: n.rxBytes,
      tx_bytes: n.txBytes,
      rx_bps: rxBps,
      tx_bps: txBps,
    }
  })
  await db.table('gateway_network_samples').multiInsert(rows).onConflict().ignore()
}

async function noteScope(gatewayId: number, scope: string, at: DateTime): Promise<void> {
  let known = lastScope.get(gatewayId)
  if (known === undefined) {
    const row = await db
      .from('gateway_scope_changes')
      .where('gateway_id', gatewayId)
      .orderBy('changed_at', 'desc')
      .orderBy('id', 'desc')
      .first()
    known = row?.scope ?? ''
  }
  if (known === scope) {
    lastScope.set(gatewayId, scope)
    return
  }
  await db.table('gateway_scope_changes').insert({
    gateway_id: gatewayId,
    scope,
    changed_at: sqlTime(at),
  })
  lastScope.set(gatewayId, scope)
  logger.info(
    { gatewayId, scope, previous: known || null },
    'network accounting: scope rule changed'
  )
}

const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/

/**
 * Records `devices[].network` (README 7.8): `device_network_latest` per
 * (gateway, MAC) and an interval in `device_network_history`, only when a
 * MAC's network changed since the last write this process saw. Throws only
 * on a database error.
 */
export async function recordDeviceNetworks(
  collector: Collector,
  devices: DeviceLike[],
  receivedAt: DateTime
): Promise<number> {
  const tagged = devices.filter(
    (d) =>
      typeof d.network === 'string' && d.network.length > 0 && d.network.length <= MAX_NETWORK_NAME
  )
  if (tagged.length === 0) return 0
  const info = await infoFor(collector)
  if (info.gatewayId === null) return 0
  const gatewayId = info.gatewayId
  const changed: Array<{ mac: string; network: string }> = []
  const seen = new Set<string>()
  for (const d of tagged) {
    const mac = String(d.mac).toLowerCase()
    if (!MAC.test(mac) || seen.has(mac)) continue
    seen.add(mac)
    const network = d.network as string
    const key = `${gatewayId}|${mac}`
    const before = deviceNetwork.get(key)
    if (before === network) {
      deviceNetwork.set(key, network) // refresh its place in the bound
      continue
    }
    changed.push({ mac, network })
  }
  if (changed.length === 0) return 0
  const at = sqlTime(receivedAt)

  await db.transaction(async (trx) => {
    const macs = changed.map((c) => c.mac)
    const open = (await trx
      .from('device_network_history')
      .where('gateway_id', gatewayId)
      .whereIn('mac', macs)
      .whereNull('ended_at')
      .select('id', 'mac', 'network')) as Array<{ id: number; mac: string; network: string }>
    const openByMac = new Map<string, Array<{ id: number; network: string }>>()
    for (const row of open) {
      const list = openByMac.get(row.mac) ?? []
      list.push({ id: row.id, network: row.network })
      openByMac.set(row.mac, list)
    }
    const close: number[] = []
    const start: Array<Record<string, unknown>> = []
    for (const c of changed) {
      const rows = openByMac.get(c.mac) ?? []
      const same = rows.find((r) => r.network === c.network)
      for (const r of rows) if (r !== same) close.push(r.id)
      if (!same) {
        start.push({
          gateway_id: gatewayId,
          mac: c.mac,
          network: c.network,
          started_at: at,
          ended_at: null,
        })
      }
    }
    if (close.length > 0) {
      await trx.from('device_network_history').whereIn('id', close).update({ ended_at: at })
    }
    if (start.length > 0) await trx.table('device_network_history').multiInsert(start)
    await trx
      .table('device_network_latest')
      .multiInsert(
        changed.map((c) => ({ gateway_id: gatewayId, mac: c.mac, network: c.network, seen_at: at }))
      )
      .onConflict(['gateway_id', 'mac'])
      .merge(['network', 'seen_at'])
  })
  for (const c of changed) deviceNetwork.set(`${gatewayId}|${c.mac}`, c.network)
  return changed.length
}

// ── reads ────────────────────────────────────────────────────────────────

/**
 * The last `gateway.networks` report of a gateway (since this process
 * started), while it is current: a gateway that stopped reporting (offline,
 * collector stopped) has none after `LIVE_NETWORKS_MAX_AGE_MS`, so its last
 * rates are not shown as if they were still flowing.
 */
export function liveNetworks(gatewayId: number, now: number = Date.now()): LiveNetworks | null {
  const entry = live.get(gatewayId)
  if (!entry) return null
  const at = Date.parse(entry.reportedAt)
  if (!Number.isFinite(at) || now - at > LIVE_NETWORKS_MAX_AGE_MS) return null
  return entry
}

/**
 * DATETIME columns are UTC wall times; they are read as ISO text formatted
 * by the database, never through mysql2's Date parsing (which applies the
 * process zone; CLAUDE.md).
 */
const ISO = (column: string) => `DATE_FORMAT(${column}, '%Y-%m-%dT%H:%i:%sZ')`

function toIso(value: Date | string | null): string | null {
  if (value === null) return null
  if (value instanceof Date) return DateTime.fromJSDate(value, { zone: 'utc' }).toISO()
  const parsed = DateTime.fromISO(value, { zone: 'utc' })
  return parsed.isValid ? parsed.toUTC().toISO() : String(value)
}

function rawRows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result[0] : result) as T[]
}

export type ScopeChange = { gatewayId: number; scope: 'routed' | 'legacy'; changedAt: string }

/** Scope rule changes, oldest first (README 7.8: charts mark them). */
export async function scopeChanges(
  opts: {
    gatewayId?: number
    since?: DateTime
    until?: DateTime
    /** Only the newest this many (still returned oldest first), e.g. 1 for "the scope in force". */
    newest?: number
  } = {}
): Promise<ScopeChange[]> {
  const direction = opts.newest ? 'desc' : 'asc'
  const query = db
    .from('gateway_scope_changes')
    .select('gateway_id', 'scope', db.raw(`${ISO('changed_at')} AS changed_at`))
    .orderBy('changed_at', direction)
    .orderBy('id', direction)
  if (opts.gatewayId !== undefined) query.where('gateway_id', opts.gatewayId)
  if (opts.since) query.where('changed_at', '>=', sqlTime(opts.since))
  if (opts.until) query.where('changed_at', '<', sqlTime(opts.until))
  const fetched = (await query.limit(opts.newest ? Math.min(opts.newest, 1000) : 1000)) as Array<{
    gateway_id: number
    scope: string
    changed_at: Date | string
  }>
  const rows = opts.newest ? [...fetched].reverse() : fetched
  return rows.map((r) => ({
    gatewayId: r.gateway_id,
    scope: r.scope === 'routed' ? 'routed' : 'legacy',
    changedAt: toIso(r.changed_at)!,
  }))
}

export type NetworkPoint = {
  bucketStart: string
  ts: number
  /** Router-side: received from the network (its devices' upload + what is routed out of it). */
  rxBps: number | null
  /** Router-side: sent into the network (its devices' download). */
  txBps: number | null
  rxPeakBps: number | null
  txPeakBps: number | null
}

export type NetworkSeries = { network: string; points: NetworkPoint[] }

/** Rates per network and bucket from `gateway_network_samples` (averages and peaks of the 30 s rates). */
export async function queryNetworkHistory(opts: {
  gatewayId: number
  since: DateTime
  until: DateTime
  resolutionSeconds: number
  network?: string
}): Promise<NetworkSeries[]> {
  const bindings: unknown[] = [
    opts.resolutionSeconds,
    opts.resolutionSeconds,
    opts.gatewayId,
    sqlTime(opts.since),
    sqlTime(opts.until),
  ]
  let filter = ''
  if (opts.network) {
    filter = 'AND network = ?'
    bindings.push(opts.network)
  }
  const rows = rawRows<{
    network: string
    bucketTs: number | string
    rxBps: number | string | null
    txBps: number | string | null
    rxPeak: number | string | null
    txPeak: number | string | null
  }>(
    await db.rawQuery(
      `
      SELECT network,
             FLOOR(UNIX_TIMESTAMP(recorded_at) / ?) * ? AS bucketTs,
             AVG(rx_bps) AS rxBps, AVG(tx_bps) AS txBps,
             MAX(rx_bps) AS rxPeak, MAX(tx_bps) AS txPeak
      FROM gateway_network_samples
      WHERE gateway_id = ? AND recorded_at >= ? AND recorded_at < ? ${filter}
      GROUP BY network, bucketTs
      ORDER BY network ASC, bucketTs ASC
      `,
      bindings
    )
  )
  const n = (v: number | string | null) => {
    if (v === null) return null
    const x = Number(v)
    return Number.isFinite(x) ? Math.round(x) : null
  }
  const found = new Map<string, Map<number, Omit<NetworkPoint, 'bucketStart' | 'ts'>>>()
  for (const r of rows) {
    const ts = Number(r.bucketTs) * 1000
    const byTs = found.get(r.network) ?? new Map()
    byTs.set(ts, {
      rxBps: n(r.rxBps),
      txBps: n(r.txBps),
      rxPeakBps: n(r.rxPeak),
      txPeakBps: n(r.txPeak),
    })
    found.set(r.network, byTs)
  }
  // Every bucket of the window, in order: one without samples is unknown
  // (null), never 0, so a chart breaks there instead of bridging the gap.
  const grid = networkBucketGrid(opts.since, opts.until, opts.resolutionSeconds)
  return [...found.entries()].map(([network, byTs]) => ({
    network,
    points: grid.map((ts) => ({
      bucketStart: DateTime.fromMillis(ts, { zone: 'utc' }).toISO()!,
      ts,
      ...(byTs.get(ts) ?? { rxBps: null, txBps: null, rxPeakBps: null, txPeakBps: null }),
    })),
  }))
}

/** Upper bound of the dense grid (a year of hourly buckets); a longer window is cut at its end. */
const MAX_HISTORY_BUCKETS = 9000

/**
 * Bucket starts (epoch ms) covering `[since, until)` on the query's grid
 * (`FLOOR(UNIX_TIMESTAMP(t) / res) * res`): the first holds `since`.
 */
export function networkBucketGrid(
  since: DateTime,
  until: DateTime,
  resolutionSeconds: number
): number[] {
  const step = resolutionSeconds * 1000
  if (!(step > 0)) return []
  const end = until.toMillis()
  let ts = Math.floor(since.toMillis() / step) * step
  const out: number[] = []
  while (ts < end && out.length < MAX_HISTORY_BUCKETS) {
    out.push(ts)
    ts += step
  }
  return out
}

/** The newest sample per network of a gateway (rates when no live report is at hand). */
export async function latestNetworkSamples(
  gatewayId: number
): Promise<Map<string, { recordedAt: string; rxBps: number | null; txBps: number | null }>> {
  const rows = rawRows<{
    network: string
    recorded_at: Date | string
    rx_bps: number | string | null
    tx_bps: number | string | null
  }>(
    await db.rawQuery(
      `
      SELECT s.network, ${ISO('s.recorded_at')} AS recorded_at, s.rx_bps, s.tx_bps
      FROM gateway_network_samples s
      JOIN (
        SELECT network, MAX(recorded_at) AS latest
        FROM gateway_network_samples
        WHERE gateway_id = ? AND recorded_at >= UTC_TIMESTAMP() - INTERVAL 1 DAY
        GROUP BY network
      ) l ON l.network = s.network AND l.latest = s.recorded_at
      WHERE s.gateway_id = ?
      `,
      [gatewayId, gatewayId]
    )
  )
  const out = new Map<string, { recordedAt: string; rxBps: number | null; txBps: number | null }>()
  for (const r of rows) {
    out.set(r.network, {
      recordedAt: toIso(r.recorded_at)!,
      rxBps: r.rx_bps === null ? null : Number(r.rx_bps),
      txBps: r.tx_bps === null ? null : Number(r.tx_bps),
    })
  }
  return out
}

export type DeviceNetworkLatest = { gatewayId: number; network: string; seenAt: string }

/** The newest network per MAC (over all gateways), for device rows. */
export async function deviceNetworksFor(macs: string[]): Promise<Map<string, DeviceNetworkLatest>> {
  const out = new Map<string, DeviceNetworkLatest>()
  const wanted = [...new Set(macs.map((m) => m.toLowerCase()))]
  if (wanted.length === 0) return out
  for (let i = 0; i < wanted.length; i += 1000) {
    const rows = (await db
      .from('device_network_latest')
      .whereIn('mac', wanted.slice(i, i + 1000))
      .select('gateway_id', 'mac', 'network', db.raw(`${ISO('seen_at')} AS seen_at`))) as Array<{
      gateway_id: number
      mac: string
      network: string
      seen_at: Date | string
    }>
    for (const r of rows) {
      const seenAt = toIso(r.seen_at)!
      const mac = r.mac.toLowerCase()
      const current = out.get(mac)
      if (current && current.seenAt >= seenAt) continue
      out.set(mac, { gatewayId: r.gateway_id, network: r.network, seenAt })
    }
  }
  return out
}

export type DeviceNetworkInterval = {
  gatewayId: number
  network: string
  startedAt: string
  endedAt: string | null
}

/** A MAC's network intervals, newest first. */
export async function deviceNetworkHistory(
  mac: string,
  opts: { since?: DateTime; limit?: number } = {}
): Promise<DeviceNetworkInterval[]> {
  const query = db
    .from('device_network_history')
    .select(
      'gateway_id',
      'network',
      db.raw(`${ISO('started_at')} AS started_at`),
      db.raw(`${ISO('ended_at')} AS ended_at`)
    )
    .where('mac', mac.toLowerCase())
    .orderBy('started_at', 'desc')
    .orderBy('id', 'desc')
    .limit(opts.limit ?? 200)
  if (opts.since) {
    const since = sqlTime(opts.since)
    query.where((q) => q.whereNull('ended_at').orWhere('ended_at', '>=', since))
  }
  const rows = (await query) as Array<{
    gateway_id: number
    network: string
    started_at: Date | string
    ended_at: Date | string | null
  }>
  return rows.map((r) => ({
    gatewayId: r.gateway_id,
    network: r.network,
    startedAt: toIso(r.started_at)!,
    endedAt: toIso(r.ended_at),
  }))
}
