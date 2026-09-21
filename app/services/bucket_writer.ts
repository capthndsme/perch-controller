import env from '#start/env'
import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'

/**
 * Native-tier bucket writes for the collector poller. Every function here
 * writes exactly one table with one batched UPSERT; the coarser rollup tiers
 * (5 m / hourly / daily) are **not** maintained here any more — they are
 * recomputed from closed native buckets by `rollup_maintainer` once a minute.
 * That removed the per-tick fan-out (3 UPSERT statements per stream per
 * tick, each re-touching the same rollup row hundreds of times an hour).
 */

// Re-exported so existing importers of the tier constants keep working.
export {
  ROLLUP_TIERS,
  HOURLY_ROLLUP_SECONDS,
  FIVE_MIN_ROLLUP_SECONDS,
  DAILY_ROLLUP_SECONDS,
} from '#services/rollup_tiers'

/**
 * One pre-aggregated delta the writer turns into a bucket row. `bytesIn`
 * etc. are the SUMs of the per-packet counters between two consecutive
 * poller snapshots — never raw cumulative counters.
 *
 * The `*WAN` and `*LAN` counters are the per-scope splits the collector
 * exposes alongside the totals. They satisfy the invariant
 * `bytesIn == bytesInWan + bytesInLan` (and same for the rest) for
 * collectors >= the LAN-split release; for older collectors that don't
 * emit the splits, the writer accepts 0/0 here and the bucket row's
 * `_wan` / `_lan` columns simply lag behind `bytes_in` / `bytes_out`.
 */
export type BucketDelta = {
  mac: string
  bytesIn: number
  bytesOut: number
  packetsIn: number
  packetsOut: number
  bytesInWan?: number
  bytesOutWan?: number
  packetsInWan?: number
  packetsOutWan?: number
  bytesInLan?: number
  bytesOutLan?: number
  packetsInLan?: number
  packetsOutLan?: number
}

/**
 * One peer entry as the collector emits it. `scope` is added by the
 * caller (the collector exposes WAN peers under `top_peers` and LAN peers
 * under `top_lan_peers`); we don't try to infer it here.
 */
export type PeerEntry = {
  peerIp: string
  bytesIn: number
  bytesOut: number
}

export type PeerScope = 'wan' | 'lan'

/**
 * The latest peer heap for one (mac, scope). `replace` asks the writer to
 * also delete rows whose IP is no longer in the heap — the poller sets it
 * only when it saw the IP *set* change, so the common tick (same IPs, new
 * counters) is a pure UPSERT with no DELETE.
 */
export type PeerGroup = {
  mac: string
  scope: PeerScope
  peers: PeerEntry[]
  replace: boolean
}

/** One per-(mac, scope, peer) byte delta between two poller snapshots. */
export type PeerBucketDelta = {
  mac: string
  scope: PeerScope
  peerIp: string
  bytesIn: number
  bytesOut: number
}

/**
 * One per-(server MAC, server name, protocol) delta between two poller
 * snapshots: bytes the device *served* to clients and *received* from them
 * under that TLS SNI / HTTP Host / QUIC SNI.
 */
export type ServiceBucketDelta = {
  mac: string
  serverName: string
  protocol: string
  bytesServed: number
  bytesReceived: number
  packetsServed: number
  packetsReceived: number
}

/**
 * One per-(client MAC, destination name, protocol) delta between two poller
 * snapshots: bytes the device downloaded from / uploaded to that destination.
 * `serverName` is '' for the per-protocol unnamed pool.
 */
export type DestinationBucketDelta = {
  mac: string
  serverName: string
  /** Peer address for unnamed TLS/HTTP/QUIC rows; '' for named rows and the pool. */
  peerIp?: string
  protocol: string
  category: string
  bytesIn: number
  bytesOut: number
  packetsIn: number
  packetsOut: number
}

/** One per-(MAC, protocol) delta between two poller snapshots. */
export type ProtocolBucketDelta = {
  mac: string
  protocol: string
  bytesIn: number
  bytesOut: number
  packetsIn: number
  packetsOut: number
}

/**
 * Floors `ts` to the nearest `intervalSec` boundary, anchored on epoch.
 * Two ticks of the same collector with the same interval that land in the
 * same wall-clock window will produce identical `bucket_start`s and
 * therefore SUM into the same bucket row via the unique index.
 *
 * Implementation note: we round in epoch seconds (not whatever the input
 * zone is) so DST transitions and timezone changes don't shift bucket
 * boundaries — the only thing that matters for time-series alignment is
 * a stable, monotonic discretisation.
 */
export function alignToBucket(ts: DateTime, intervalSec: number): DateTime {
  if (intervalSec <= 0) {
    throw new Error(`intervalSec must be positive, got ${intervalSec}`)
  }
  const epochSec = Math.floor(ts.toSeconds())
  const floored = epochSec - (epochSec % intervalSec)
  return DateTime.fromSeconds(floored, { zone: ts.zone })
}

/**
 * Implausibility guard against counter-reset glitches. When a source device's
 * cumulative counter resets (reboot, interface flap, a virtual interface's
 * counter wrapping), the collector can diff against a stale/zero baseline and
 * record the entire accumulated counter — or a monotonic ramp — as one bucket.
 * That is what produced the "1.1 TB in 15 minutes" spike and the month-boundary
 * 33 TB rows. We drop any single delta whose in/out bytes exceed a ceiling at
 * the one write chokepoint, so the glitch becomes a gap instead of a spike
 * across every tier. Observed real peak was ~1.8 GB/bucket; the glitches were
 * 4.7 GB–1.5 TB, so the default cleanly separates them.
 *
 * Configurable via `BUCKET_MAX_DELTA_BYTES` (bytes; default 5 GB ≈ 8 Gbps over
 * a 5 s bucket). Lower it to catch ramps sooner, raise it for 10GbE+ links, or
 * set 0 to disable.
 */
export const MAX_BUCKET_DELTA_BYTES = Math.max(
  0,
  Number(env.get('BUCKET_MAX_DELTA_BYTES', 5_000_000_000))
)

/** True if one delta's byte counters are within the plausible ceiling. */
export function deltaBytesArePlausible(bytesIn: number, bytesOut: number): boolean {
  if (MAX_BUCKET_DELTA_BYTES <= 0) return true // guard disabled
  return bytesIn <= MAX_BUCKET_DELTA_BYTES && bytesOut <= MAX_BUCKET_DELTA_BYTES
}

/**
 * Native grain for per-protocol buckets. Protocol rows are the highest-
 * cardinality stream (devices × protocols per tick); nothing in the UI
 * renders protocol data finer than one minute, so twelve 5 s ticks merge into
 * one row via the UPSERT instead of twelve rows. Protocol *identity* is
 * untouched — every classified protocol is still stored.
 */
export const PROTOCOL_NATIVE_GRAIN_SECONDS = 60

/** Peer history is kept at hourly grain. */
export const PEER_BUCKET_GRAIN_SECONDS = 3600

/** Served-bytes-per-server-name history is kept at hourly grain. */
export const SERVICE_BUCKET_GRAIN_SECONDS = 3600
/** Five-minute grain of the same history (`device_service_buckets_5m`), short retention. */
export const SERVICE_5M_GRAIN_SECONDS = 300
/** Hour grain for the per-destination history (`device_destination_buckets_hourly`). */
export const DESTINATION_BUCKET_GRAIN_SECONDS = 3600
const MAX_CATEGORY_LENGTH = 40

/** Longest server name the table stores; nDPI caps SNI at 79 chars anyway. */
const MAX_SERVER_NAME_LENGTH = 255

/** Rows per multi-row statement; keeps packets well under max_allowed_packet. */
const INSERT_CHUNK = 1000

function chunk<T>(rows: T[], size = INSERT_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

/** Native traffic counter columns for one delta (totals + WAN/LAN splits). */
function trafficCounterColumns(d: BucketDelta) {
  return {
    bytes_in: d.bytesIn,
    bytes_out: d.bytesOut,
    packets_in: d.packetsIn,
    packets_out: d.packetsOut,
    bytes_in_wan: d.bytesInWan ?? 0,
    bytes_out_wan: d.bytesOutWan ?? 0,
    packets_in_wan: d.packetsInWan ?? 0,
    packets_out_wan: d.packetsOutWan ?? 0,
    bytes_in_lan: d.bytesInLan ?? 0,
    bytes_out_lan: d.bytesOutLan ?? 0,
    packets_in_lan: d.packetsInLan ?? 0,
    packets_out_lan: d.packetsOutLan ?? 0,
  }
}

/** ON DUPLICATE KEY UPDATE merge that SUMs every traffic counter. */
function trafficSumMerge(nowSql: string) {
  const sum = (col: string) => db.raw('?? + VALUES(??)', [col, col])
  return {
    bytes_in: sum('bytes_in'),
    bytes_out: sum('bytes_out'),
    packets_in: sum('packets_in'),
    packets_out: sum('packets_out'),
    bytes_in_wan: sum('bytes_in_wan'),
    bytes_out_wan: sum('bytes_out_wan'),
    packets_in_wan: sum('packets_in_wan'),
    packets_out_wan: sum('packets_out_wan'),
    bytes_in_lan: sum('bytes_in_lan'),
    bytes_out_lan: sum('bytes_out_lan'),
    packets_in_lan: sum('packets_in_lan'),
    packets_out_lan: sum('packets_out_lan'),
    updated_at: nowSql,
  }
}

/** SUM merge for the four plain counters (protocol + peer tables). */
function plainSumMerge(nowSql: string, cols: string[]) {
  const merge: Record<string, unknown> = { updated_at: nowSql }
  for (const col of cols) merge[col] = db.raw('?? + VALUES(??)', [col, col])
  return merge
}

/**
 * Batched UPSERT of native bucket rows. Identical (collector_id, mac,
 * bucket_start) triples collapse into ON DUPLICATE KEY UPDATE that SUMs deltas
 * so two ticks landing in the same window add their values instead of
 * clobbering each other. Returns the number of input rows actually sent to
 * the DB (after filtering zero-delta noise and implausible glitches).
 *
 * NOTE: This relies on MySQL/MariaDB `VALUES(col)` semantics inside
 * ON DUPLICATE KEY UPDATE. If we ever swap dialects, the merge expression
 * is the only thing that needs to change.
 */
export async function writeBuckets(
  collectorId: number,
  intervalSec: number,
  pollAt: DateTime,
  deltas: BucketDelta[]
): Promise<number> {
  const nonZero = deltas.filter(
    (d) => d.bytesIn > 0 || d.bytesOut > 0 || d.packetsIn > 0 || d.packetsOut > 0
  )
  const sane = nonZero.filter((d) => {
    if (deltaBytesArePlausible(d.bytesIn, d.bytesOut)) return true
    logger.warn(
      { collectorId, mac: d.mac, bytesIn: d.bytesIn, bytesOut: d.bytesOut, intervalSec },
      'bucket_writer: dropping implausible traffic delta (counter reset?)'
    )
    return false
  })
  if (sane.length === 0) return 0

  // MySQL's DATETIME has 1 s granularity by default; the migration uses
  // plain `datetime()` so seconds is enough. Format explicitly to dodge
  // any luxon ↔ knex marshalling differences across drivers.
  const bucketStartSql = alignToBucket(pollAt, intervalSec).toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
  const nowSql = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')

  const rows = sane.map((d) => ({
    collector_id: collectorId,
    mac: d.mac,
    bucket_start: bucketStartSql,
    ...trafficCounterColumns(d),
    created_at: nowSql,
    updated_at: nowSql,
  }))

  for (const part of chunk(rows)) {
    await db
      .insertQuery()
      .table('device_traffic_buckets')
      .multiInsert(part)
      .onConflict(['collector_id', 'mac', 'bucket_start'])
      .merge(trafficSumMerge(nowSql))
  }

  return rows.length
}

/**
 * Batched UPSERT of per-protocol bucket rows at the protocol native grain
 * (`PROTOCOL_NATIVE_GRAIN_SECONDS`, or the poll interval if that is coarser).
 * Same merge semantics as `writeBuckets`, keyed on
 * (collector_id, mac, protocol, bucket_start).
 */
export async function writeProtocolBuckets(
  collectorId: number,
  intervalSec: number,
  pollAt: DateTime,
  deltas: ProtocolBucketDelta[]
): Promise<number> {
  const nonZero = deltas.filter(
    (d) => d.bytesIn > 0 || d.bytesOut > 0 || d.packetsIn > 0 || d.packetsOut > 0
  )
  const sane = nonZero.filter((d) => {
    if (deltaBytesArePlausible(d.bytesIn, d.bytesOut)) return true
    logger.warn(
      { collectorId, mac: d.mac, protocol: d.protocol, bytesIn: d.bytesIn, bytesOut: d.bytesOut },
      'bucket_writer: dropping implausible protocol delta (counter reset?)'
    )
    return false
  })
  if (sane.length === 0) return 0

  const grain = Math.max(intervalSec, PROTOCOL_NATIVE_GRAIN_SECONDS)
  const bucketStartSql = alignToBucket(pollAt, grain).toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
  const nowSql = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')

  const rows = sane.map((d) => ({
    collector_id: collectorId,
    mac: d.mac,
    protocol: d.protocol,
    bucket_start: bucketStartSql,
    bytes_in: d.bytesIn,
    bytes_out: d.bytesOut,
    packets_in: d.packetsIn,
    packets_out: d.packetsOut,
    created_at: nowSql,
    updated_at: nowSql,
  }))

  for (const part of chunk(rows)) {
    await db
      .insertQuery()
      .table('device_protocol_buckets')
      .multiInsert(part)
      .onConflict(['collector_id', 'mac', 'protocol', 'bucket_start'])
      .merge(plainSumMerge(nowSql, ['bytes_in', 'bytes_out', 'packets_in', 'packets_out']))
  }

  return rows.length
}

/**
 * Batched UPSERT of per-peer byte deltas into the hourly peer history table.
 * Keyed on (collector_id, mac, scope, peer_ip, hour_start); deltas SUM into
 * the hour. Zero and implausible deltas are dropped like every other stream.
 */
export async function writePeerBuckets(
  collectorId: number,
  pollAt: DateTime,
  deltas: PeerBucketDelta[]
): Promise<number> {
  const sane = deltas.filter((d) => {
    if (d.bytesIn <= 0 && d.bytesOut <= 0) return false
    if (deltaBytesArePlausible(d.bytesIn, d.bytesOut)) return true
    logger.warn(
      { collectorId, mac: d.mac, peerIp: d.peerIp, bytesIn: d.bytesIn, bytesOut: d.bytesOut },
      'bucket_writer: dropping implausible peer delta (counter reset?)'
    )
    return false
  })
  if (sane.length === 0) return 0

  const hourStartSql = alignToBucket(pollAt, PEER_BUCKET_GRAIN_SECONDS)
    .toUTC()
    .toFormat('yyyy-MM-dd HH:mm:ss')
  const nowSql = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')

  const rows = sane.map((d) => ({
    collector_id: collectorId,
    mac: d.mac,
    scope: d.scope,
    peer_ip: d.peerIp,
    hour_start: hourStartSql,
    bytes_in: d.bytesIn,
    bytes_out: d.bytesOut,
    updated_at: nowSql,
  }))

  for (const part of chunk(rows)) {
    await db
      .insertQuery()
      .table('device_peer_buckets_hourly')
      .multiInsert(part)
      .onConflict(['collector_id', 'mac', 'scope', 'peer_ip', 'hour_start'])
      .merge(plainSumMerge(nowSql, ['bytes_in', 'bytes_out']))
  }

  return rows.length
}

/**
 * Batched UPSERT of per-server-name deltas into the hourly service history.
 * Keyed on (collector_id, mac, server_name, protocol, hour_start); deltas SUM
 * into the hour. Zero and implausible deltas are dropped like every stream.
 */
export async function writeServiceBuckets(
  collectorId: number,
  pollAt: DateTime,
  deltas: ServiceBucketDelta[]
): Promise<number> {
  const sane = deltas.filter((d) => {
    if (!d.serverName) return false
    if (d.bytesServed <= 0 && d.bytesReceived <= 0) return false
    if (deltaBytesArePlausible(d.bytesServed, d.bytesReceived)) return true
    logger.warn(
      {
        collectorId,
        mac: d.mac,
        serverName: d.serverName,
        bytesServed: d.bytesServed,
        bytesReceived: d.bytesReceived,
      },
      'bucket_writer: dropping implausible service delta (counter reset?)'
    )
    return false
  })
  if (sane.length === 0) return 0

  const hourStartSql = alignToBucket(pollAt, SERVICE_BUCKET_GRAIN_SECONDS)
    .toUTC()
    .toFormat('yyyy-MM-dd HH:mm:ss')
  const slotStartSql = alignToBucket(pollAt, SERVICE_5M_GRAIN_SECONDS)
    .toUTC()
    .toFormat('yyyy-MM-dd HH:mm:ss')
  const nowSql = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')

  const counters = (d: ServiceBucketDelta) => ({
    collector_id: collectorId,
    mac: d.mac,
    server_name: d.serverName.slice(0, MAX_SERVER_NAME_LENGTH),
    protocol: d.protocol,
    bytes_served: d.bytesServed,
    bytes_received: d.bytesReceived,
    packets_served: d.packetsServed,
    packets_received: d.packetsReceived,
    updated_at: nowSql,
  })
  const merge = plainSumMerge(nowSql, [
    'bytes_served',
    'bytes_received',
    'packets_served',
    'packets_received',
  ])

  // Same deltas into both grains: the hour for totals, the 5-minute slot so
  // the per-name chart can show when a server actually spiked.
  const hourly = sane.map((d) => ({ ...counters(d), hour_start: hourStartSql }))
  for (const part of chunk(hourly)) {
    await db
      .insertQuery()
      .table('device_service_buckets_hourly')
      .multiInsert(part)
      .onConflict(['collector_id', 'mac', 'server_name', 'protocol', 'hour_start'])
      .merge(merge)
  }
  const fiveMin = sane.map((d) => ({ ...counters(d), slot_start: slotStartSql }))
  for (const part of chunk(fiveMin)) {
    await db
      .insertQuery()
      .table('device_service_buckets_5m')
      .multiInsert(part)
      .onConflict(['collector_id', 'mac', 'server_name', 'protocol', 'slot_start'])
      .merge(merge)
  }

  return hourly.length
}

/**
 * Batched UPSERT of destination deltas into the hourly table. Same contract
 * as writeServiceBuckets; an empty name is legal (the per-protocol pool).
 * The category is overwritten by the latest non-empty value so a flow nDPI
 * refined later settles on the refined answer.
 */
export async function writeDestinationBuckets(
  collectorId: number,
  pollAt: DateTime,
  deltas: DestinationBucketDelta[]
): Promise<number> {
  const sane = deltas.filter((d) => {
    if (d.bytesIn <= 0 && d.bytesOut <= 0) return false
    if (deltaBytesArePlausible(d.bytesIn, d.bytesOut)) return true
    logger.warn(
      {
        collectorId,
        mac: d.mac,
        serverName: d.serverName,
        protocol: d.protocol,
        bytesIn: d.bytesIn,
        bytesOut: d.bytesOut,
      },
      'bucket_writer: dropping implausible destination delta (counter reset?)'
    )
    return false
  })
  if (sane.length === 0) return 0

  const hourStartSql = alignToBucket(pollAt, DESTINATION_BUCKET_GRAIN_SECONDS)
    .toUTC()
    .toFormat('yyyy-MM-dd HH:mm:ss')
  const nowSql = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')

  const rows = sane.map((d) => ({
    collector_id: collectorId,
    mac: d.mac,
    server_name: (d.serverName ?? '').slice(0, MAX_SERVER_NAME_LENGTH),
    peer_ip: (d.peerIp ?? '').slice(0, 45),
    protocol: d.protocol,
    category: (d.category ?? '').slice(0, MAX_CATEGORY_LENGTH),
    hour_start: hourStartSql,
    bytes_in: d.bytesIn,
    bytes_out: d.bytesOut,
    packets_in: d.packetsIn,
    packets_out: d.packetsOut,
    updated_at: nowSql,
  }))

  for (const part of chunk(rows)) {
    await db
      .insertQuery()
      .table('device_destination_buckets_hourly')
      .multiInsert(part)
      .onConflict(['collector_id', 'mac', 'server_name', 'peer_ip', 'protocol', 'hour_start'])
      .merge({
        ...plainSumMerge(nowSql, ['bytes_in', 'bytes_out', 'packets_in', 'packets_out']),
        category: db.raw("IF(VALUES(??) = '', ??, VALUES(??))", [
          'category',
          'category',
          'category',
        ]),
      })
  }

  return rows.length
}

/**
 * Refresh the latest-peer mirror (`device_top_peers`) for many devices in one
 * go: a single multi-row UPSERT for every peer of every group, plus one
 * DELETE per group flagged `replace` to drop IPs that left that device's
 * heap. Returns the number of peer rows upserted.
 *
 * Why not DELETE + INSERT per device (the previous design): with ~150 known
 * devices × 2 scopes that was ~300 fsynced transactions rewriting ~6.5 k rows
 * every 5 s tick, for a table that only ever holds ~6.5 k rows — and it was
 * the source of the gap-lock deadlocks. The poller now skips idle devices
 * entirely and only asks for `replace` when the IP set actually changed, so
 * the steady-state tick is one statement.
 */
export async function writeTopPeersBatch(
  collectorId: number,
  groups: PeerGroup[],
  now: DateTime = DateTime.utc()
): Promise<number> {
  if (groups.length === 0) return 0
  const nowSql = now.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')

  const rows: Array<Record<string, string | number>> = []
  for (const group of groups) {
    for (const p of group.peers) {
      rows.push({
        collector_id: collectorId,
        mac: group.mac,
        peer_ip: p.peerIp,
        scope: group.scope,
        bytes_in: p.bytesIn,
        bytes_out: p.bytesOut,
        updated_at: nowSql,
      })
    }
  }

  await db.transaction(async (trx) => {
    for (const part of chunk(rows)) {
      await trx
        .insertQuery()
        .table('device_top_peers')
        .multiInsert(part)
        .onConflict(['collector_id', 'mac', 'peer_ip', 'scope'])
        .merge({
          bytes_in: db.raw('VALUES(??)', ['bytes_in']),
          bytes_out: db.raw('VALUES(??)', ['bytes_out']),
          updated_at: nowSql,
        })
    }

    for (const group of groups) {
      if (!group.replace) continue
      const query = trx
        .from('device_top_peers')
        .where({ collector_id: collectorId, mac: group.mac, scope: group.scope })
      if (group.peers.length > 0) {
        query.whereNotIn(
          'peer_ip',
          group.peers.map((p) => p.peerIp)
        )
      }
      await query.delete()
    }
  })

  return rows.length
}

/**
 * Replaces the top-peer entries for a single (collector, mac, scope) with
 * the supplied list. Thin wrapper over `writeTopPeersBatch` kept for callers
 * (and tests) that deal with one device at a time.
 */
export async function upsertTopPeers(
  collectorId: number,
  mac: string,
  scope: PeerScope,
  peers: PeerEntry[],
  now: DateTime = DateTime.utc()
): Promise<number> {
  await writeTopPeersBatch(collectorId, [{ mac, scope, peers, replace: true }], now)
  return peers.length
}
