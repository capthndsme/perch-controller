import { deltaBytesArePlausible } from '#services/bucket_writer'
import {
  MAX_REMEMBERED_REPORTS,
  extractPortCounters,
  type InfraTrafficScope,
  type PortCounters,
} from '#services/infra_ports'
import { FIVE_MIN_ROLLUP_SECONDS, HOURLY_ROLLUP_SECONDS, coveredFrom } from '#services/rollup_tiers'
import {
  apPollIntervalSeconds,
  denseSlots,
  planWindowSeries,
  pollIntervalSeconds,
  querySeriesKeyedSums,
  type SeriesPlan,
  type SeriesTier,
} from '#services/series_buckets'
import type { ChartSettings } from '#services/chart_settings'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * Port traffic of the infrastructure view (docs/infrastructure-view.md,
 * amendment A6): the agents' cumulative byte counters per port become a live
 * rate per port (in memory, served by `/infra/state`) and accounting rows
 * (`infra_port_buckets_5m` / `_hourly`, written here at ingest, no rollup
 * job). A cable's rate is the larger of what its two ends measured: one end
 * of a cable can under-count (A6, "Finding").
 *
 * Every in-process map here is bounded (CLAUDE.md cache rule). Samples live
 * in memory only, like the traffic poller's: the bytes between the last report
 * before a restart and the first after it are not counted.
 */

const SLOT_MS = FIVE_MIN_ROLLUP_SECONDS * 1000
const HOUR_MS = HOURLY_ROLLUP_SECONDS * 1000
/** A delta over at most this long is spread over the slots it spans; a longer one goes to the report's slot. */
export const SPLIT_MAX_MS = HOUR_MS
/** A rate needs two samples at most this far apart (as `gateway_network_accounting.ts`). */
export const PORT_RATE_MAX_GAP_MS = 120_000
/** Agent ports whose last sample and rate are kept; the least recently reported is evicted first. */
export const MAX_TRACKED_PORTS = 4096
/** A node's port name → id map is reloaded at most this often for a name it lacks. */
const PORT_ID_RELOAD_MS = 60_000
/** Window totals up to this long read the 5-minute rows (as the service lists). */
const TOTALS_FINE_MAX_SPAN_SECONDS = 2 * 86_400

export type { InfraTrafficScope }

/** A port's rate over its last two reports, in bits per second. */
export type PortRate = {
  rxBps: number
  txBps: number
  scope: InfraTrafficScope | null
  atMs: number
}

type Sample = { rx: number; tx: number; scope: InfraTrafficScope | null; atMs: number }

/** Bytes of one 5-minute slot. */
export type SlotPart = { slotMs: number; rx: number; tx: number }

// ── bounded map ──────────────────────────────────────────────────────────

/** A Map that keeps at most `limit` keys, the least recently written evicted first. */
class BoundedMap<K, V> {
  readonly #entries = new Map<K, V>()

  constructor(readonly limit: number) {}

  get(key: K): V | undefined {
    return this.#entries.get(key)
  }

  has(key: K): boolean {
    return this.#entries.has(key)
  }

  set(key: K, value: V): void {
    this.#entries.delete(key)
    this.#entries.set(key, value)
    while (this.#entries.size > this.limit) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      this.#entries.delete(oldest)
    }
  }

  delete(key: K): void {
    this.#entries.delete(key)
  }

  entries(): IterableIterator<[K, V]> {
    return this.#entries.entries()
  }

  clear(): void {
    this.#entries.clear()
  }

  get size(): number {
    return this.#entries.size
  }
}

// ── deltas ───────────────────────────────────────────────────────────────

/**
 * Spreads one delta over the 5-minute slots of the interval
 * `[fromMs, toMs)` in proportion to the time in each; the last slot takes the
 * rounding remainder, so the parts always add up to the delta. An interval
 * longer than `SPLIT_MAX_MS` (or an empty one) puts everything into the slot
 * of `toMs`. Pure, for tests.
 */
export function splitDelta(rx: number, tx: number, fromMs: number, toMs: number): SlotPart[] {
  const span = toMs - fromMs
  if (span <= 0 || span > SPLIT_MAX_MS) {
    return [{ slotMs: Math.floor(toMs / SLOT_MS) * SLOT_MS, rx, tx }]
  }
  const first = Math.floor(fromMs / SLOT_MS)
  const last = Math.floor((toMs - 1) / SLOT_MS)
  const parts: SlotPart[] = []
  let restRx = rx
  let restTx = tx
  for (let slot = first; slot <= last; slot += 1) {
    const slotMs = slot * SLOT_MS
    if (slot === last) {
      parts.push({ slotMs, rx: restRx, tx: restTx })
      break
    }
    const overlap = Math.min(toMs, slotMs + SLOT_MS) - Math.max(fromMs, slotMs)
    const partRx = Math.floor((rx * overlap) / span)
    const partTx = Math.floor((tx * overlap) / span)
    restRx -= partRx
    restTx -= partTx
    parts.push({ slotMs, rx: partRx, tx: partTx })
  }
  return parts
}

/** What one report of one port adds: its accounted slot parts, if any. */
export type Observation = { parts: SlotPart[]; rate: PortRate | null }

/**
 * The per-port rules of amendment A6.2, in memory. `observe` takes one port
 * of one report; the caller writes the parts it returns.
 */
export class PortTrafficTracker {
  readonly #samples: BoundedMap<number, Sample>
  readonly #rates: BoundedMap<number, PortRate>

  constructor(limit: number = MAX_TRACKED_PORTS) {
    this.#samples = new BoundedMap(limit)
    this.#rates = new BoundedMap(limit)
  }

  /**
   * - no counters (carrier down): the rate goes, the sample stays;
   * - first sample, a counter that went backwards, or a scope change: the
   *   sample is replaced, nothing is accounted, no rate;
   * - a delta the `BUCKET_MAX_DELTA_BYTES` guard refuses: the same;
   * - otherwise the delta is accounted, and it gives a rate when the two
   *   samples are at most `PORT_RATE_MAX_GAP_MS` apart.
   * A report not later than the last sample changes nothing.
   */
  observe(portId: number, counters: PortCounters | null, atMs: number): Observation {
    if (counters === null) {
      this.#rates.delete(portId)
      return { parts: [], rate: null }
    }
    const previous = this.#samples.get(portId)
    if (previous && atMs <= previous.atMs) {
      return { parts: [], rate: this.#rates.get(portId) ?? null }
    }
    this.#samples.set(portId, {
      rx: counters.rxBytes,
      tx: counters.txBytes,
      scope: counters.scope,
      atMs,
    })
    const rx = previous ? counters.rxBytes - previous.rx : -1
    const tx = previous ? counters.txBytes - previous.tx : -1
    if (
      !previous ||
      previous.scope !== counters.scope ||
      rx < 0 ||
      tx < 0 ||
      !deltaBytesArePlausible(rx, tx)
    ) {
      this.#rates.delete(portId)
      return { parts: [], rate: null }
    }
    const gapMs = atMs - previous.atMs
    let rate: PortRate | null = null
    if (gapMs <= PORT_RATE_MAX_GAP_MS) {
      rate = {
        rxBps: Math.round((rx * 8) / (gapMs / 1000)),
        txBps: Math.round((tx * 8) / (gapMs / 1000)),
        scope: counters.scope,
        atMs,
      }
      this.#rates.set(portId, rate)
    } else {
      this.#rates.delete(portId)
    }
    const parts = rx > 0 || tx > 0 ? splitDelta(rx, tx, previous.atMs, atMs) : []
    return { parts, rate }
  }

  rate(portId: number): PortRate | null {
    return this.#rates.get(portId) ?? null
  }

  hasSample(portId: number): boolean {
    return this.#samples.has(portId)
  }

  rates(): ReadonlyMap<number, PortRate> {
    return new Map(this.#rates.entries())
  }

  clear(): void {
    this.#samples.clear()
    this.#rates.clear()
  }
}

const tracker = new PortTrafficTracker()

/** The live rate of every agent port that has one (`/infra/state`). */
export function livePortRates(): ReadonlyMap<number, PortRate> {
  return tracker.rates()
}

// ── ingest ───────────────────────────────────────────────────────────────

type PortIds = { byKey: Map<string, number>; loadedAtMs: number }
const portIdsByNode = new BoundedMap<number, PortIds>(MAX_REMEMBERED_REPORTS)

async function loadPortIds(nodeId: number): Promise<PortIds> {
  const found = (await db
    .from('infra_ports')
    .where('node_id', nodeId)
    .where('origin', 'agent')
    .select('id', 'port_key')) as Array<{ id: number; port_key: string }>
  const entry = {
    byKey: new Map(found.map((row) => [row.port_key.toLowerCase(), Number(row.id)])),
    loadedAtMs: Date.now(),
  }
  portIdsByNode.set(nodeId, entry)
  return entry
}

/** The node's agent port ids for these keys, from the cache when it has them all. */
async function portIdsFor(
  nodeId: number,
  keys: string[],
  reload: boolean
): Promise<Map<string, number>> {
  let entry = portIdsByNode.get(nodeId)
  const missing = !entry || keys.some((key) => !entry!.byKey.has(key))
  if (!entry || reload || (missing && Date.now() - entry.loadedAtMs >= PORT_ID_RELOAD_MS)) {
    entry = await loadPortIds(nodeId)
  }
  return entry.byKey
}

function sqlTime(ms: number): string {
  return DateTime.fromMillis(ms, { zone: 'utc' }).toFormat('yyyy-MM-dd HH:mm:ss')
}

async function upsertParts(
  table: 'infra_port_buckets_5m' | 'infra_port_buckets_hourly',
  timeColumn: 'slot_start' | 'hour_start',
  parts: Array<{ portId: number; atMs: number; rx: number; tx: number }>
): Promise<void> {
  if (parts.length === 0) return
  const values = parts.map(() => '(?, ?, ?, ?)').join(', ')
  await db.rawQuery(
    `INSERT INTO ${table} (port_id, ${timeColumn}, rx_bytes, tx_bytes) VALUES ${values}
     ON DUPLICATE KEY UPDATE rx_bytes = rx_bytes + VALUES(rx_bytes), tx_bytes = tx_bytes + VALUES(tx_bytes)`,
    parts.flatMap((part) => [part.portId, sqlTime(part.atMs), part.rx, part.tx])
  )
}

/**
 * One report's counters (amendment A6.2), right after `recordAgentPorts`
 * wrote the node's ports. `ports` is the raw array; anything else (an agent
 * that does not report ports) does nothing, as does a report without
 * counters. `portsChanged`: that write changed rows, so the name → id map is
 * read again. Throws on a database error (the caller logs it and carries on).
 */
export async function recordPortTraffic(
  nodeId: number,
  ports: unknown,
  at: DateTime,
  opts: { portsChanged?: boolean } = {}
): Promise<void> {
  if (!Array.isArray(ports)) return
  const counters = extractPortCounters(ports)
  if (counters.size === 0) return
  // An agent older than A6 sends no counters at all: no query for it. A port
  // of a node seen before may still have a rate to drop.
  const counted = [...counters.values()].some((value) => value !== null)
  if (!counted && !portIdsByNode.has(nodeId)) return
  const ids = await portIdsFor(nodeId, [...counters.keys()], opts.portsChanged === true)

  const atMs = at.toMillis()
  const slots: Array<{ portId: number; atMs: number; rx: number; tx: number }> = []
  const hours = new Map<string, { portId: number; atMs: number; rx: number; tx: number }>()
  for (const [key, value] of counters) {
    const portId = ids.get(key)
    if (portId === undefined) continue
    for (const part of tracker.observe(portId, value, atMs).parts) {
      slots.push({ portId, atMs: part.slotMs, rx: part.rx, tx: part.tx })
      const hourMs = Math.floor(part.slotMs / HOUR_MS) * HOUR_MS
      const hourKey = `${portId}:${hourMs}`
      const hour = hours.get(hourKey)
      if (hour) {
        hour.rx += part.rx
        hour.tx += part.tx
      } else {
        hours.set(hourKey, { portId, atMs: hourMs, rx: part.rx, tx: part.tx })
      }
    }
  }
  try {
    await upsertParts('infra_port_buckets_5m', 'slot_start', slots)
    await upsertParts('infra_port_buckets_hourly', 'hour_start', [...hours.values()])
  } catch (error) {
    // A port deleted since the ids were read: read them again next time.
    portIdsByNode.delete(nodeId)
    throw error
  }
}

/** Test-only: forget samples, rates and the port id maps. */
export function _resetPortTrafficState(): void {
  tracker.clear()
  portIdsByNode.clear()
}

// ── accounting reads (amendment A6.4) ─────────────────────────────────────

export const PORT_SERIES_TIERS: readonly SeriesTier[] = [
  {
    source: '5m',
    grainSeconds: FIVE_MIN_ROLLUP_SECONDS,
    table: 'infra_port_buckets_5m',
    timeColumn: 'slot_start',
    freshness: 'poll',
  },
  {
    source: '1h',
    grainSeconds: HOURLY_ROLLUP_SECONDS,
    table: 'infra_port_buckets_hourly',
    timeColumn: 'hour_start',
  },
]

export type TrafficWindow = { since: DateTime; until: DateTime }

type PortRow = { id: number; nodeId: number; origin: string }

/** The agent port whose counters answer for a port: itself, or its cable's far end. */
type Measurer = { portId: number; linkId: number | null }

function rows<T>(result: unknown): T[] {
  return ((Array.isArray(result) ? result[0] : result) ?? []) as T[]
}

function num(value: unknown): number {
  if (value === null || value === undefined) return 0
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

function bps(bytes: number, seconds: number): number {
  return seconds > 0 ? Math.round(((bytes * 8) / seconds) * 1000) / 1000 : 0
}

function iso(sec: number): string {
  return DateTime.fromSeconds(sec, { zone: 'utc' }).toISO()!
}

function sqlDateTime(at: DateTime): string {
  return at.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
}

async function selectPorts(filter: { ids?: number[]; nodeId?: number }): Promise<PortRow[]> {
  if (filter.ids?.length === 0) return []
  const query = db
    .from('infra_ports')
    .select('id', 'node_id as nodeId', 'origin')
    .orderBy('position', 'asc')
    .orderBy('id', 'asc')
  if (filter.ids) query.whereIn('id', filter.ids)
  if (filter.nodeId !== undefined) query.where('node_id', filter.nodeId)
  return ((await query) as PortRow[]).map((row) => ({
    id: Number(row.id),
    nodeId: Number(row.nodeId),
    origin: row.origin,
  }))
}

/** For each port: the cable on it and the far port. */
async function farEnds(portIds: number[]): Promise<Map<number, { linkId: number; farId: number }>> {
  const out = new Map<number, { linkId: number; farId: number }>()
  if (portIds.length === 0) return out
  const links = (await db
    .from('infra_links')
    .where((q) => q.whereIn('a_port_id', portIds).orWhereIn('b_port_id', portIds))
    .select('id', 'a_port_id as a', 'b_port_id as b')) as Array<{
    id: number
    a: number
    b: number
  }>
  const wanted = new Set(portIds)
  for (const link of links) {
    const a = Number(link.a)
    const b = Number(link.b)
    if (wanted.has(a)) out.set(a, { linkId: Number(link.id), farId: b })
    if (wanted.has(b)) out.set(b, { linkId: Number(link.id), farId: a })
  }
  return out
}

/**
 * The first stored bucket of each port (epoch seconds): its first 5-minute
 * slot, unless the hourly rows reach further back (a shorter 5-minute
 * retention). An hour row alone starts at the top of its hour, before the
 * first byte, so it only counts when it ends before the first slot.
 */
async function firstBuckets(portIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (portIds.length === 0) return out
  const oldest = async (table: string, column: string) => {
    const found = rows<{ portId: number; first: number | string | null }>(
      await db.rawQuery(
        `SELECT port_id AS portId,
                TIMESTAMPDIFF(SECOND, '1970-01-01 00:00:00', MIN(${column})) AS first
         FROM ${table} WHERE port_id IN (${portIds.map(() => '?').join(', ')})
         GROUP BY port_id`,
        portIds
      )
    )
    return new Map(
      found
        .filter((row) => row.first !== null)
        .map((row) => [Number(row.portId), Number(row.first)])
    )
  }
  const [slots, hours] = await Promise.all([
    oldest('infra_port_buckets_5m', 'slot_start'),
    oldest('infra_port_buckets_hourly', 'hour_start'),
  ])
  for (const id of portIds) {
    const slot = slots.get(id)
    const hour = hours.get(id)
    if (slot === undefined && hour === undefined) continue
    out.set(
      id,
      slot === undefined || (hour !== undefined && hour + HOURLY_ROLLUP_SECONDS <= slot)
        ? hour!
        : slot
    )
  }
  return out
}

/**
 * Whether an agent port measures: it has accounting rows or a live sample
 * (an agent older than A6 reports ports but no counters, and measures
 * nothing).
 */
function measures(port: PortRow | undefined, first: Map<number, number>): boolean {
  return (
    port !== undefined &&
    port.origin === 'agent' &&
    (first.has(port.id) || tracker.hasSample(port.id))
  )
}

/** The measurer of each port (manual ports: a measuring agent port at the far end of their cable). */
async function measurersOf(
  ports: PortRow[]
): Promise<{ measurers: Map<number, Measurer | null>; first: Map<number, number> }> {
  const manual = ports.filter((port) => port.origin !== 'agent').map((port) => port.id)
  const far = await farEnds(manual)
  const farRows = await selectPorts({
    ids: [...new Set([...far.values()].map((end) => end.farId))],
  })
  const farPorts = new Map(farRows.map((port) => [port.id, port]))
  const candidates = new Map<number, Measurer>()
  for (const port of ports) {
    if (port.origin === 'agent') {
      candidates.set(port.id, { portId: port.id, linkId: null })
      continue
    }
    const end = far.get(port.id)
    if (end && farPorts.get(end.farId)?.origin === 'agent') {
      candidates.set(port.id, { portId: end.farId, linkId: end.linkId })
    }
  }
  const first = await firstBuckets([...new Set([...candidates.values()].map((m) => m.portId))])
  const measurers = new Map<number, Measurer | null>()
  for (const port of ports) {
    const candidate = candidates.get(port.id)
    const measuring =
      candidate &&
      measures(candidate.linkId === null ? port : farPorts.get(candidate.portId), first)
    measurers.set(port.id, measuring ? candidate : null)
  }
  return { measurers, first }
}

/** The polling grain the live bucket is complete to: the longest agent interval. */
async function agentPollSeconds(): Promise<number> {
  const [ap, collector] = await Promise.all([apPollIntervalSeconds(), pollIntervalSeconds()])
  return Math.max(ap, collector)
}

async function planFor(
  window: TrafficWindow,
  settings: ChartSettings,
  requestedSeconds: number | undefined
): Promise<SeriesPlan> {
  const pollSeconds = await agentPollSeconds()
  return planWindowSeries({
    sinceSec: Math.floor(window.since.toSeconds()),
    untilSec: Math.floor(window.until.toSeconds()),
    nowSec: Math.floor(Date.now() / 1000),
    tiers: PORT_SERIES_TIERS,
    pollSeconds,
    // An explicit resolution wins over the Settings → Charts floor.
    floorSeconds: requestedSeconds ?? settings.minBucketSeconds,
    maxPoints: settings.maxPoints,
  })
}

/** Sums of rx/tx per bucket index and port id. */
async function seriesSums(
  plan: SeriesPlan,
  window: TrafficWindow,
  portIds: number[]
): Promise<Map<number, Map<string, number[]>>> {
  if (portIds.length === 0) return new Map()
  return querySeriesKeyedSums({
    plan,
    sinceSql: sqlDateTime(window.since),
    untilSql: sqlDateTime(window.until),
    columns: ['rx_bytes', 'tx_bytes'],
    keyExpr: 't.port_id',
    where: [`t.port_id IN (${portIds.map(() => '?').join(', ')})`],
    bindings: portIds,
  })
}

function sinceOf(first: Map<number, number>, portIds: number[]): string | null {
  const known = portIds.map((id) => first.get(id)).filter((sec): sec is number => sec !== undefined)
  return known.length > 0 ? iso(Math.min(...known)) : null
}

function windowOf(window: TrafficWindow) {
  return { from: window.since.toUTC().toISO()!, to: window.until.toUTC().toISO()! }
}

export type PortTrafficPoint = {
  bucketStart: string
  seconds: number
  rxBytes: number
  txBytes: number
  rxBps: number
  txBps: number
}

export type PortTrafficSeries = {
  portId: number
  nodeId: number
  measuredBy: Measurer | null
  window: { from: string; to: string }
  bucketSeconds: number
  source: string
  since: string | null
  totals: { rxBytes: number; txBytes: number }
  points: PortTrafficPoint[]
}

/**
 * `GET /infra/ports/:id/traffic`: a port's accounting over the window, seen
 * from the port (a manual port's far end is turned around). Null when the
 * port does not exist.
 */
export async function queryPortTraffic(
  portId: number,
  window: TrafficWindow,
  settings: ChartSettings,
  requestedSeconds?: number
): Promise<PortTrafficSeries | null> {
  const [port] = await selectPorts({ ids: [portId] })
  if (!port) return null
  const [{ measurers, first }, plan] = await Promise.all([
    measurersOf([port]),
    planFor(window, settings, requestedSeconds),
  ])
  const measuredBy = measurers.get(port.id) ?? null
  const sums = measuredBy ? await seriesSums(plan, window, [measuredBy.portId]) : new Map()
  const turned = measuredBy !== null && measuredBy.linkId !== null
  const totals = { rxBytes: 0, txBytes: 0 }
  const points = denseSlots(plan).map((slot): PortTrafficPoint => {
    const own = sums.get(slot.index)?.get(String(measuredBy?.portId)) ?? [0, 0]
    const [rx, tx] = turned ? [own[1], own[0]] : [own[0], own[1]]
    totals.rxBytes += rx
    totals.txBytes += tx
    return {
      bucketStart: slot.bucketStart,
      seconds: slot.seconds,
      rxBytes: rx,
      txBytes: tx,
      rxBps: bps(rx, slot.seconds),
      txBps: bps(tx, slot.seconds),
    }
  })
  return {
    portId: port.id,
    nodeId: port.nodeId,
    measuredBy,
    window: windowOf(window),
    bucketSeconds: plan.bucketSeconds,
    source: plan.tier.source,
    since: measuredBy ? sinceOf(first, [measuredBy.portId]) : null,
    totals,
    points,
  }
}

export type LinkTrafficPoint = {
  bucketStart: string
  seconds: number
  aToBBytes: number
  bToABytes: number
  aToBBps: number
  bToABps: number
}

export type LinkTrafficSeries = {
  linkId: number
  measuredBy: { a: number | null; b: number | null }
  window: { from: string; to: string }
  bucketSeconds: number
  source: string
  since: string | null
  totals: { aToBBytes: number; bToABytes: number }
  points: LinkTrafficPoint[]
}

/**
 * `GET /infra/links/:id/traffic`: per bucket and direction the larger of the
 * two ends (a's sent vs b's received; b's sent vs a's received), over the
 * ends that measure. Null when the cable does not exist.
 */
export async function queryLinkTraffic(
  linkId: number,
  window: TrafficWindow,
  settings: ChartSettings,
  requestedSeconds?: number
): Promise<LinkTrafficSeries | null> {
  const link = (await db
    .from('infra_links')
    .where('id', linkId)
    .select('id', 'a_port_id as a', 'b_port_id as b')
    .first()) as { id: number; a: number; b: number } | null
  if (!link) return null
  const aId = Number(link.a)
  const bId = Number(link.b)
  const [ends, plan] = await Promise.all([
    selectPorts({ ids: [aId, bId] }),
    planFor(window, settings, requestedSeconds),
  ])
  const byId = new Map(ends.map((port) => [port.id, port]))
  const first = await firstBuckets([aId, bId])
  const a = measures(byId.get(aId), first) ? aId : null
  const b = measures(byId.get(bId), first) ? bId : null
  const measuring = [a, b].filter((id): id is number => id !== null)
  const sums = await seriesSums(plan, window, measuring)

  const totals = { aToBBytes: 0, bToABytes: 0 }
  const points = denseSlots(plan).map((slot): LinkTrafficPoint => {
    const inBucket = sums.get(slot.index)
    const aSums = a === null ? null : (inBucket?.get(String(a)) ?? [0, 0])
    const bSums = b === null ? null : (inBucket?.get(String(b)) ?? [0, 0])
    // [rx, tx] per end.
    const aToB = Math.max(aSums ? aSums[1] : 0, bSums ? bSums[0] : 0)
    const bToA = Math.max(bSums ? bSums[1] : 0, aSums ? aSums[0] : 0)
    totals.aToBBytes += aToB
    totals.bToABytes += bToA
    return {
      bucketStart: slot.bucketStart,
      seconds: slot.seconds,
      aToBBytes: aToB,
      bToABytes: bToA,
      aToBBps: bps(aToB, slot.seconds),
      bToABps: bps(bToA, slot.seconds),
    }
  })
  return {
    linkId: Number(link.id),
    measuredBy: { a, b },
    window: windowOf(window),
    bucketSeconds: plan.bucketSeconds,
    source: plan.tier.source,
    since: sinceOf(first, measuring),
    totals,
    points,
  }
}

export type NodeTrafficTotals = {
  nodeId: number
  window: { from: string; to: string }
  /** Start of the rows read: the slot or hour holding the window start (`coveredFrom`). */
  coveredFrom: string
  ports: Array<{ portId: number; measuredBy: Measurer | null; rxBytes: number; txBytes: number }>
}

/**
 * `GET /infra/nodes/:id/traffic`: per-port totals of one node over the
 * window, every port in display order. Windows up to two days read the
 * 5-minute rows, longer ones the hourly rows, from the row that holds the
 * window start. Null when the node does not exist.
 */
export async function queryNodeTraffic(
  nodeId: number,
  window: TrafficWindow
): Promise<NodeTrafficTotals | null> {
  const node = await db.from('infra_nodes').where('id', nodeId).select('id').first()
  if (!node) return null
  const ports = await selectPorts({ nodeId })
  const { measurers } = await measurersOf(ports)
  const span = window.until.toSeconds() - window.since.toSeconds()
  const [table, column, grain] =
    span <= TOTALS_FINE_MAX_SPAN_SECONDS
      ? (['infra_port_buckets_5m', 'slot_start', FIVE_MIN_ROLLUP_SECONDS] as const)
      : (['infra_port_buckets_hourly', 'hour_start', HOURLY_ROLLUP_SECONDS] as const)
  const from = coveredFrom(window.since.toUTC(), grain)

  const measuring = [
    ...new Set(
      [...measurers.values()].filter((m): m is Measurer => m !== null).map((m) => m.portId)
    ),
  ]
  const sums = new Map<number, [number, number]>()
  if (measuring.length > 0) {
    const found = rows<{ portId: number; rx: unknown; tx: unknown }>(
      await db.rawQuery(
        `SELECT port_id AS portId, SUM(rx_bytes) AS rx, SUM(tx_bytes) AS tx
         FROM ${table}
         WHERE port_id IN (${measuring.map(() => '?').join(', ')})
           AND ${column} >= ? AND ${column} < ?
         GROUP BY port_id`,
        [...measuring, sqlDateTime(from), sqlDateTime(window.until)]
      )
    )
    for (const row of found) sums.set(Number(row.portId), [num(row.rx), num(row.tx)])
  }

  return {
    nodeId,
    window: windowOf(window),
    coveredFrom: from.toISO()!,
    ports: ports.map((port) => {
      const measuredBy = measurers.get(port.id) ?? null
      const own = measuredBy ? (sums.get(measuredBy.portId) ?? [0, 0]) : [0, 0]
      const [rxBytes, txBytes] = measuredBy?.linkId ? [own[1], own[0]] : [own[0], own[1]]
      return { portId: port.id, measuredBy, rxBytes, txBytes }
    }),
  }
}
