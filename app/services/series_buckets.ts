import {
  DAILY_ROLLUP_SECONDS,
  FIVE_MIN_ROLLUP_SECONDS,
  HOURLY_ROLLUP_SECONDS,
} from '#services/rollup_tiers'
import { _resetQueryCache, cacheKey, cachedQuery } from '#services/query_cache'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * Dense, rate-accurate time series for one name's traffic chart (services on
 * the Servers page, destinations). Shared by `service_history.ts` and
 * `destination_history.ts`.
 *
 * The bucket tables only hold rows for polls / slots / hours that moved
 * bytes. Charting those rows directly bridged every quiet period with a line
 * and squeezed the time axis. Here the read picks one bucket width, reads the
 * sums per bucket, and returns **every** bucket of the window, empty ones as
 * zero, each with the seconds it really covers so a rate is
 * bytes × 8 ÷ seconds even for the partial first and last bucket.
 *
 * Width: the smallest step of `SERIES_WIDTH_LADDER` that is at least the
 * admin floor (Settings → Charts, default 15 s), keeps the series within the
 * point cap (default 1500), and is a whole multiple of the grain of a stored
 * tier that covers the window. The floor therefore only bites where per-poll
 * rows exist (native, `BUCKET_RETENTION_DAYS`); older windows fall to the
 * 5-minute or hourly tier at their own grain. Among the tiers that can serve
 * the width the coarsest is read (fewest rows), like `pickSeriesTier`.
 *
 * Since the Protocol mix / Top talkers fix (2026-09-24) the device series
 * read here too: `trafficSeriesTiers` (Top talkers) and `protocolSeriesTiers`
 * (Protocol mix), keyed per MAC or protocol with `querySeriesKeyedSums`.
 */

/** Which stored table a series was read from. */
export type SeriesSource = 'native' | '5m' | '1h' | '1d'

/**
 * How current a tier's newest rows are. `poll`: written by the poller as each
 * poll lands, so complete up to the previous poll. `rollup`: rebuilt by the
 * once-a-minute rollup pass, so complete up to that pass. Unset: treated as
 * current to now (hourly destination rows).
 */
export type SeriesFreshness = 'poll' | 'rollup'

export type SeriesTier = {
  source: SeriesSource
  /** Seconds one stored row covers (native: the poll interval). */
  grainSeconds: number
  table: string
  timeColumn: string
  /**
   * Widest bucket this tier serves. The per-poll table only serves buckets
   * finer than 5 minutes (windows up to ~2 days at the default cap); from
   * 5 minutes up the rollups answer, as `pickSeriesTier` does for devices.
   */
  maxBucketSeconds?: number
  /**
   * Longest window this tier may serve (seconds). The per-minute protocol
   * rows are the highest-cardinality stream: over more than two days their
   * sums are a temp+filesort, so wider windows go to the hourly tier.
   */
  maxSpanSeconds?: number
  freshness?: SeriesFreshness
}

/** A tier and whether it holds rows back to the window's start. */
export type SeriesTierCandidate = SeriesTier & {
  covers: boolean
  /**
   * Where the tier's data ends (epoch seconds), when that is before now: the
   * live bucket is read and rated only up to here, so it neither dips while
   * its poll or rollup is outstanding nor counts rows past its seconds.
   */
  dataUntilSec?: number
}

/** Bucket widths a chart may use, finest first (the floor is added to it). */
export const SERIES_WIDTH_LADDER: readonly number[] = [
  5,
  10,
  15,
  20,
  30,
  60,
  120,
  FIVE_MIN_ROLLUP_SECONDS,
  600,
  900,
  1800,
  HOURLY_ROLLUP_SECONDS,
  7200,
  10_800,
  21_600,
  43_200,
  86_400,
  2 * 86_400,
  7 * 86_400,
]

export type SeriesPlan = {
  tier: SeriesTierCandidate
  bucketSeconds: number
  /** First second with data in the window (window start, up to the tier grain). */
  effSinceSec: number
  /** End of the data: the window end up to the tier grain, never past now. */
  effUntilSec: number
  firstIndex: number
  /** Inclusive; `lastIndex < firstIndex` = empty series (window in the future). */
  lastIndex: number
}

export type DenseBucket = {
  bucketStart: string
  bucketEnd: string
  /** Seconds of this bucket inside the window and not in the future. */
  seconds: number
  a: number
  b: number
}

function ceilTo(sec: number, grain: number): number {
  return Math.ceil(sec / grain) * grain
}

/** Buckets of width `w` between `sinceSec` (inclusive) and `untilSec` (exclusive). */
function bucketCount(sinceSec: number, untilSec: number, w: number): number {
  if (untilSec <= sinceSec) return 0
  return Math.floor((untilSec - 1) / w) - Math.floor(sinceSec / w) + 1
}

function planFor(
  tier: SeriesTierCandidate,
  w: number,
  sinceSec: number,
  untilSec: number,
  nowSec: number
): SeriesPlan {
  const effSinceSec = ceilTo(sinceSec, tier.grainSeconds)
  const effUntilSec = Math.min(
    ceilTo(untilSec, tier.grainSeconds),
    nowSec,
    tier.dataUntilSec ?? Number.POSITIVE_INFINITY
  )
  const firstIndex = Math.floor(effSinceSec / w)
  const lastIndex = effUntilSec > effSinceSec ? Math.floor((effUntilSec - 1) / w) : firstIndex - 1
  return { tier, bucketSeconds: w, effSinceSec, effUntilSec, firstIndex, lastIndex }
}

/**
 * Choose the tier and bucket width for a window. `tiers` are finest first;
 * the last one is the fallback that always serves (the long-lived hourly
 * table). Pure, for tests.
 */
export function planSeries(opts: {
  sinceSec: number
  untilSec: number
  nowSec: number
  floorSeconds: number
  maxPoints: number
  /** The caller's finest acceptable width (`resolution=`), if any. */
  requestedSeconds?: number
  tiers: readonly SeriesTierCandidate[]
}): SeriesPlan {
  const { sinceSec, untilSec, nowSec, maxPoints, tiers } = opts
  const fallback = tiers[tiers.length - 1]
  const minWidth = Math.max(1, opts.floorSeconds, opts.requestedSeconds ?? 0)
  const widths = [...new Set([...SERIES_WIDTH_LADDER, minWidth])]
    .filter((w) => w >= minWidth)
    .sort((a, b) => a - b)

  const spanSec = Math.max(0, untilSec - sinceSec)
  for (const w of widths) {
    if (bucketCount(sinceSec, untilSec, w) > maxPoints) continue
    // Coarsest covering tier whose rows fit whole into a bucket of width w;
    // the fallback (last) tier always counts as covering.
    for (let i = tiers.length - 1; i >= 0; i -= 1) {
      const tier = tiers[i]
      const fallbackTier = i === tiers.length - 1
      if (w % tier.grainSeconds !== 0) continue
      if (tier.maxBucketSeconds !== undefined && w > tier.maxBucketSeconds) continue
      if (!fallbackTier && tier.maxSpanSeconds !== undefined && spanSec > tier.maxSpanSeconds)
        continue
      if (!tier.covers && !fallbackTier) continue
      return planFor(tier, w, sinceSec, untilSec, nowSec)
    }
  }

  // Nothing fits (an absurd window): the fallback tier at the widest step,
  // or wider still so the cap holds.
  let w = Math.max(minWidth, SERIES_WIDTH_LADDER[SERIES_WIDTH_LADDER.length - 1])
  w = ceilTo(w, fallback.grainSeconds)
  while (bucketCount(sinceSec, untilSec, w) > maxPoints) w *= 2
  return planFor(fallback, w, sinceSec, untilSec, nowSec)
}

/** One bucket of a plan, without values. */
export type SeriesSlot = {
  /** Bucket index (`epoch seconds DIV width`), the key of the query's rows. */
  index: number
  bucketStart: string
  bucketEnd: string
  /** Seconds of this bucket inside the window and not in the future. */
  seconds: number
}

/** Every bucket of the plan, first to last, quiet or not. */
export function denseSlots(plan: SeriesPlan): SeriesSlot[] {
  const w = plan.bucketSeconds
  const out: SeriesSlot[] = []
  for (let i = plan.firstIndex; i <= plan.lastIndex; i += 1) {
    const start = i * w
    const end = start + w
    const seconds = Math.min(end, plan.effUntilSec) - Math.max(start, plan.effSinceSec)
    out.push({
      index: i,
      bucketStart: DateTime.fromSeconds(start, { zone: 'utc' }).toISO()!,
      bucketEnd: DateTime.fromSeconds(end, { zone: 'utc' }).toISO()!,
      seconds: Math.max(1, seconds),
    })
  }
  return out
}

/**
 * Every bucket of the plan, the rows' sums where the query found any and zero
 * elsewhere. Rows are keyed by bucket index (`epoch seconds DIV width`).
 */
export function denseBuckets(
  plan: SeriesPlan,
  rows: ReadonlyMap<number, readonly [number, number]>
): DenseBucket[] {
  return denseSlots(plan).map((slot) => {
    const sums = rows.get(slot.index)
    return {
      bucketStart: slot.bucketStart,
      bucketEnd: slot.bucketEnd,
      seconds: slot.seconds,
      a: sums?.[0] ?? 0,
      b: sums?.[1] ?? 0,
    }
  })
}

/** `15s`, `1m`, `5m`, `1h`, `1d`, `7d`: the label of a bucket width. */
export function bucketLabel(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

/** `15s` → 15. Labels come from the validator, so a bad one is a programming error. */
export function parseBucketLabel(label: string): number {
  const m = /^(\d+)([smhd])$/.exec(label)
  if (!m) throw new Error(`series_buckets: bad bucket label "${label}"`)
  const unit: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 }
  return Number(m[1]) * unit[m[2]]
}

/** Resolution label for `windowCache`'s TTL: finer charts refresh sooner. */
export function cacheResolutionFor(bucketSeconds: number): string | null {
  if (bucketSeconds < 60) return '15s'
  if (bucketSeconds < FIVE_MIN_ROLLUP_SECONDS) return '1m'
  if (bucketSeconds < HOURLY_ROLLUP_SECONDS) return '5m'
  return null
}

/** A guess of the width before the plan exists, for the cache TTL only. */
export function estimateBucketSeconds(
  spanSeconds: number,
  floorSeconds: number,
  maxPoints: number
): number {
  return Math.max(floorSeconds, spanSeconds / Math.max(1, maxPoints))
}

// ── coverage ─────────────────────────────────────────────────────────────

/**
 * How long an oldest-row lookup is reused; the answer only moves with
 * retention. Kept in the bounded query cache (`query_cache.ts`), so a test's
 * `_resetQueryCache()` clears it too.
 */
const COVERAGE_TTL_MS = 60_000

/** Test hook (kept for callers; the query cache reset clears the same entries). */
export function _resetSeriesCoverage(): void {
  _resetQueryCache()
}

async function oldestRowSec(table: string, timeColumn: string): Promise<number | null> {
  return cachedQuery(cacheKey(['series:oldest', table, timeColumn]), COVERAGE_TTL_MS, async () => {
    // Tables and columns are code constants, never request input. The
    // TIMESTAMPDIFF keeps it free of the session / process time zone.
    const result = await db.rawQuery(
      `SELECT TIMESTAMPDIFF(SECOND, '1970-01-01 00:00:00', MIN(${timeColumn})) AS oldest FROM ${table}`
    )
    const row = rawRows<{ oldest: number | string | null }>(result)[0]
    return row?.oldest === null || row?.oldest === undefined ? null : Number(row.oldest)
  })
}

/**
 * Whether each tier holds rows back to the start of the window, judged by
 * its oldest row (retention and a table's first write both show there). A
 * tier covers when its oldest row is at or before the window start, or when
 * it started together with all history (within one fallback grain of the
 * oldest row of any tier: a fresh install, where every tier begins at once,
 * or rollups that have not run yet). So after the release that added the
 * per-poll service table, that table only serves windows that start after
 * its first row, and an older window falls to the 5-minute or hourly detail.
 * An empty tier covers only while every tier is empty.
 */
export async function tierCoverage(
  tiers: readonly SeriesTier[],
  sinceSec: number
): Promise<SeriesTierCandidate[]> {
  const oldest = await Promise.all(tiers.map((t) => oldestRowSec(t.table, t.timeColumn)))
  const fallback = tiers[tiers.length - 1]
  const present = oldest.filter((sec): sec is number => sec !== null)
  const historyStart = present.length > 0 ? Math.min(...present) : null
  return tiers.map((tier, i) => {
    const own = oldest[i]
    let covers: boolean
    if (own === null) covers = historyStart === null
    else if (own <= sinceSec + Math.max(tier.grainSeconds, 60)) covers = true
    else covers = historyStart !== null && own <= historyStart + fallback.grainSeconds
    return { ...tier, covers }
  })
}

// ── device tiers ─────────────────────────────────────────────────────────

/** Widest bucket the per-poll / per-minute device rows serve (as for services). */
const NATIVE_MAX_BUCKET_SECONDS = FIVE_MIN_ROLLUP_SECONDS - 1

/**
 * Device traffic (`device_traffic_buckets*`): per-poll rows for buckets under
 * five minutes, then the 5-minute, hourly and daily rollups.
 */
export function trafficSeriesTiers(pollSeconds: number): SeriesTier[] {
  return [
    {
      source: 'native',
      grainSeconds: pollSeconds,
      table: 'device_traffic_buckets',
      timeColumn: 'bucket_start',
      maxBucketSeconds: NATIVE_MAX_BUCKET_SECONDS,
      freshness: 'poll',
    },
    {
      source: '5m',
      grainSeconds: FIVE_MIN_ROLLUP_SECONDS,
      table: 'device_traffic_buckets_5m',
      timeColumn: 'slot_start',
      freshness: 'rollup',
    },
    {
      source: '1h',
      grainSeconds: HOURLY_ROLLUP_SECONDS,
      table: 'device_traffic_buckets_hourly',
      timeColumn: 'hour_start',
      freshness: 'rollup',
    },
    {
      source: '1d',
      grainSeconds: DAILY_ROLLUP_SECONDS,
      table: 'device_traffic_buckets_daily',
      timeColumn: 'day_start',
      freshness: 'rollup',
    },
  ]
}

/** Windows longer than this read protocols from the hourly tier or coarser. */
export const PROTOCOL_FINE_MAX_SPAN_SECONDS = 2 * 86_400

/**
 * Device protocols (`device_protocol_buckets*`): per-minute rows (the poll
 * interval if coarser) and the 5-minute rollup only for windows up to two
 * days, as before (a week on the 5-minute tier was a 17 s temp+filesort);
 * hourly and daily beyond.
 */
export function protocolSeriesTiers(nativeGrainSeconds: number): SeriesTier[] {
  return [
    {
      source: 'native',
      grainSeconds: nativeGrainSeconds,
      table: 'device_protocol_buckets',
      timeColumn: 'bucket_start',
      maxBucketSeconds: NATIVE_MAX_BUCKET_SECONDS,
      maxSpanSeconds: PROTOCOL_FINE_MAX_SPAN_SECONDS,
      freshness: 'poll',
    },
    {
      source: '5m',
      grainSeconds: FIVE_MIN_ROLLUP_SECONDS,
      table: 'device_protocol_buckets_5m',
      timeColumn: 'slot_start',
      maxSpanSeconds: PROTOCOL_FINE_MAX_SPAN_SECONDS,
      freshness: 'rollup',
    },
    {
      source: '1h',
      grainSeconds: HOURLY_ROLLUP_SECONDS,
      table: 'device_protocol_buckets_hourly',
      timeColumn: 'hour_start',
      freshness: 'rollup',
    },
    {
      source: '1d',
      grainSeconds: DAILY_ROLLUP_SECONDS,
      table: 'device_protocol_buckets_daily',
      timeColumn: 'day_start',
      freshness: 'rollup',
    },
  ]
}

/**
 * Wi-Fi interface counters (`wifi_interface_buckets*`): per-push rows under
 * five minutes, then the rollups. Same ladder as device traffic.
 */
export function wifiSeriesTiers(pushSeconds: number): SeriesTier[] {
  return [
    {
      source: 'native',
      grainSeconds: pushSeconds,
      table: 'wifi_interface_buckets',
      timeColumn: 'bucket_start',
      maxBucketSeconds: NATIVE_MAX_BUCKET_SECONDS,
      freshness: 'poll',
    },
    {
      source: '5m',
      grainSeconds: FIVE_MIN_ROLLUP_SECONDS,
      table: 'wifi_interface_buckets_5m',
      timeColumn: 'slot_start',
      freshness: 'rollup',
    },
    {
      source: '1h',
      grainSeconds: HOURLY_ROLLUP_SECONDS,
      table: 'wifi_interface_buckets_hourly',
      timeColumn: 'hour_start',
      freshness: 'rollup',
    },
    {
      source: '1d',
      grainSeconds: DAILY_ROLLUP_SECONDS,
      table: 'wifi_interface_buckets_daily',
      timeColumn: 'day_start',
      freshness: 'rollup',
    },
  ]
}

/** Push / scrape interval of the access points (the longest, 5 s when none). */
export async function apPollIntervalSeconds(apId?: number): Promise<number> {
  const query = db.from('wifi_access_points').max('poll_interval_seconds as grain')
  if (apId) query.where('id', apId)
  const rows = (await query) as Array<{ grain: number | string | null }>
  const grain = Number(rows[0]?.grain ?? 0)
  return Number.isFinite(grain) && grain >= 1 ? Math.floor(grain) : 5
}

/**
 * Poll interval of the collector asked about, or the longest of all of them
 * (a bucket must hold whole polls of every collector it sums). 5 s when no
 * collector exists yet.
 */
export async function pollIntervalSeconds(collectorId?: number): Promise<number> {
  const query = db.from('collectors').max('poll_interval_seconds as grain')
  if (collectorId) query.where('id', collectorId)
  const rows = (await query) as Array<{ grain: number | string | null }>
  const grain = Number(rows[0]?.grain ?? 0)
  return Number.isFinite(grain) && grain >= 1 ? Math.floor(grain) : 5
}

/**
 * Coverage, freshness and plan in one: what a dense series endpoint calls
 * before `querySeriesKeyedSums`.
 */
export async function planWindowSeries(opts: {
  sinceSec: number
  untilSec: number
  nowSec: number
  tiers: readonly SeriesTier[]
  pollSeconds: number
  floorSeconds: number
  maxPoints: number
  requestedSeconds?: number
}): Promise<SeriesPlan> {
  const covered = await tierCoverage(opts.tiers, opts.sinceSec)
  return planSeries({
    sinceSec: opts.sinceSec,
    untilSec: opts.untilSec,
    nowSec: opts.nowSec,
    floorSeconds: opts.floorSeconds,
    maxPoints: opts.maxPoints,
    requestedSeconds: opts.requestedSeconds,
    tiers: withFreshness(covered, { nowSec: opts.nowSec, pollSeconds: opts.pollSeconds }),
  })
}

/**
 * Lower time bound of a plan's rows: the window start up to the tier grain,
 * so a row that belongs to the bucket before the first one (a stray,
 * unaligned row) never lands outside the series.
 */
export function seriesSinceSql(plan: SeriesPlan, sinceSql: string): string {
  return [sinceSql, sqlSeconds(plan.effSinceSec)].sort()[1]
}

/** Upper time bound of a plan's rows: the window end or where its data ends. */
export function seriesUntilSql(plan: SeriesPlan, untilSql: string): string {
  return [untilSql, sqlSeconds(plan.effUntilSec)].sort()[0]
}

// ── freshness ────────────────────────────────────────────────────────────

let lastRollupPassSec: number | null = null

/**
 * Called by the once-a-minute rollup pass when it finished: every rollup row
 * then holds its source rows up to `nowSec`.
 */
export function noteRollupPass(nowSec: number): void {
  lastRollupPassSec = Math.floor(nowSec)
}

/** Test hook. */
export function _resetRollupPass(): void {
  lastRollupPassSec = null
}

/**
 * Where each tier's data ends. `poll` tiers are complete up to the start of
 * the previous poll interval (the current interval's rows land when its poll
 * does); `rollup` tiers up to the last rollup pass (now, before the first pass
 * since start, which takes a minute at most).
 */
export function withFreshness(
  tiers: readonly SeriesTierCandidate[],
  opts: { nowSec: number; pollSeconds: number }
): SeriesTierCandidate[] {
  const poll = Math.max(1, Math.floor(opts.pollSeconds))
  const pollUntil = Math.floor(opts.nowSec / poll) * poll - poll
  return tiers.map((tier) => {
    if (tier.freshness === 'poll') return { ...tier, dataUntilSec: pollUntil }
    if (tier.freshness === 'rollup' && lastRollupPassSec !== null) {
      return { ...tier, dataUntilSec: Math.min(opts.nowSec, lastRollupPassSec) }
    }
    return tier
  })
}

// ── query ────────────────────────────────────────────────────────────────

function sqlSeconds(sec: number): string {
  return DateTime.fromSeconds(sec, { zone: 'utc' }).toFormat('yyyy-MM-dd HH:mm:ss')
}

/**
 * Sums of `columns` per bucket of the plan and per key (`keyExpr`, an SQL
 * expression on alias `t`; omitted = one key, `''`). Rows are read from the
 * window start to the end of the plan's data (`effUntilSec`), so the live
 * bucket never holds rows its `seconds` do not count. Result: bucket index →
 * key → one sum per column.
 */
export async function querySeriesKeyedSums(opts: {
  plan: SeriesPlan
  sinceSql: string
  untilSql: string
  columns: readonly string[]
  keyExpr?: string
  /** Bindings of `keyExpr`'s placeholders (they come first). */
  keyBindings?: ReadonlyArray<string | number>
  where: readonly string[]
  bindings: ReadonlyArray<string | number>
}): Promise<Map<number, Map<string, number[]>>> {
  const { plan } = opts
  const out = new Map<number, Map<string, number[]>>()
  if (plan.lastIndex < plan.firstIndex) return out
  const col = `t.${plan.tier.timeColumn}`
  const untilSql = seriesUntilSql(plan, opts.untilSql)
  const keySelect = opts.keyExpr ? `${opts.keyExpr}` : `''`
  const sums = opts.columns.map((c, i) => `SUM(t.${c}) AS s${i}`).join(',\n        ')
  const rows = rawRows<Record<string, bigint | number | string | null>>(
    await db.rawQuery(
      `
      SELECT
        TIMESTAMPDIFF(SECOND, '1970-01-01 00:00:00', ${col}) DIV ? AS idx,
        ${keySelect} AS k,
        ${sums}
      FROM ${plan.tier.table} t
      WHERE ${[...opts.where, `${col} >= ?`, `${col} < ?`].join(' AND ')}
      GROUP BY idx, k
    `,
      [
        plan.bucketSeconds,
        ...(opts.keyBindings ?? []),
        ...opts.bindings,
        seriesSinceSql(plan, opts.sinceSql),
        untilSql,
      ]
    )
  )
  for (const row of rows) {
    const idx = Number(row.idx)
    let byKey = out.get(idx)
    if (!byKey) {
      byKey = new Map()
      out.set(idx, byKey)
    }
    byKey.set(
      String(row.k ?? ''),
      opts.columns.map((_, i) => num(row[`s${i}`]))
    )
  }
  return out
}

/**
 * Sums of two columns per bucket of the plan, keyed by bucket index. `where`
 * holds extra predicates on alias `t` (name, collector) with their bindings;
 * the time range is added here. Group key is `epoch seconds DIV width`
 * computed with TIMESTAMPDIFF, which does not depend on any time zone.
 */
export async function querySeriesSums(opts: {
  plan: SeriesPlan
  sinceSql: string
  untilSql: string
  columns: readonly [string, string]
  where: readonly string[]
  bindings: ReadonlyArray<string | number>
}): Promise<Map<number, [number, number]>> {
  const keyed = await querySeriesKeyedSums(opts)
  const out = new Map<number, [number, number]>()
  for (const [idx, byKey] of keyed) {
    const sums = byKey.get('') ?? [0, 0]
    out.set(idx, [sums[0] ?? 0, sums[1] ?? 0])
  }
  return out
}

/** Megabits per second over a bucket's real seconds. */
export function mbps(bytes: number, seconds: number): number {
  return seconds > 0 ? (bytes * 8) / seconds / 1_000_000 : 0
}

function num(value: bigint | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0
  return typeof value === 'number' ? value : Number(value)
}

function rawRows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result[0] : result) as T[]
}
