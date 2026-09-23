import Collector from '#models/collector'
import {
  bucketTierRetentionDays,
  nativeRetentionDaysFromEnv,
  retentionOptionsFromEnv,
  type BucketTierRetention,
} from '#services/bucket_retention'
import {
  ROLLUP_SPECS,
  runRollupSpec,
  type RollupRunResult,
  type RollupSpec,
} from '#services/rollup_maintainer'
import env from '#start/env'
import db from '@adonisjs/lucid/services/db'
import type { QueryClientContract, TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'

/**
 * Folding one collector's history into another (`node ace collectors:merge`).
 *
 * The case it exists for is hardware replacement: the old capture box is
 * switched off, a router starts collecting in its place, and the dashboard
 * should show one continuous history instead of two collectors that each
 * hold half of it. Afterwards exactly one collector row remains. It always
 * carries the `into` collector's identity (name, address, key, instance id,
 * source, lifecycle), because that is the one still running.
 *
 * Which physical row survives is a cost decision, not a semantic one. Every
 * history row of the other collector has its `collector_id` rewritten, and
 * on the rollup tables that column leads the primary key, so each rewrite is
 * a delete plus an insert in the clustered index. The side with more rows
 * therefore keeps its row id and, when that is the `from` side, takes over
 * the `into` identity; the smaller side's rows move. On the owner's box that
 * was ~4,600 rows moved instead of ~4 million.
 *
 * Collisions (both collectors hold a row with the same key, e.g. the same
 * device in the same 5-minute slot) only happen where their activity
 * overlapped, and how to resolve them depends on why they overlapped:
 *
 *   replace (default when the overlap is at most 15 minutes): a hand-over.
 *     Traffic buckets (one row per poll) and the top-peer snapshot keep the
 *     target's row; everything the poller accumulates over a longer slot
 *     (protocol rows per minute, services per 5 minutes and hour, peers,
 *     destinations) adds up, because each collector contributed its own part
 *     of the slot.
 *   into: the two ran side by side and saw the same traffic; the target's
 *     row wins everywhere.
 *   sum: the two ran side by side and saw different traffic (two segments);
 *     rows are added everywhere.
 *
 * Longer overlaps have no safe default, so the plan refuses until the
 * operator picks `into` or `sum`. Whatever the policy, the rollup tiers are
 * then rebuilt from the tier below over the shared slots, wherever the tier
 * below still has the rows (native is kept 30 days, 5-minute and hourly 730),
 * so every rollup in reach agrees with the merged buckets exactly.
 *
 * Everything runs in one transaction; a deadlock against the live poller or
 * rollup maintainer rolls it back whole and the command retries it. The
 * table registry is checked against `information_schema` first: a new table
 * referencing `collectors`, or a new column on a known one, makes the merge
 * refuse instead of letting `ON DELETE CASCADE` or a silent overwrite eat it.
 * Tables that reference `collectors` without holding history
 * (`NON_HISTORY_TABLES`) are exempt and moved by their own rule.
 */

export const MERGE_OVERLAP_POLICIES = ['replace', 'into', 'sum'] as const
export type MergeOverlapPolicy = (typeof MERGE_OVERLAP_POLICIES)[number]

/** Longest activity overlap for which `replace` is chosen without being asked. */
export const AUTO_REPLACE_MAX_OVERLAP_SECONDS = 15 * 60

/** Refusals and validation failures, printed to the operator as they are. */
export class CollectorMergeError extends Error {}

/** How a key collision between the two collectors is resolved in one table. */
export type CollisionRule = 'into' | 'sum' | 'identity'

type CounterTable = {
  kind: 'counter'
  table: string
  /** The table's unique key without `collector_id`. */
  keys: readonly string[]
  /** Additive columns. */
  sums: readonly string[]
  /**
   * Non-additive value columns. The winning side's value is kept unless it is
   * empty, the same rule the poller's upsert applies (`bucket_writer.ts`).
   */
  extras?: readonly string[]
  /**
   * native      one row per poll (`device_traffic_buckets`, `device_service_buckets`, as wide as the
   *             poll interval): a collision is two measurements of the same
   *             seconds.
   * rollup      rebuilt from the tier below by the rollup maintainer; the
   *             merge rebuilds the shared slots the same way afterwards.
   * accumulator totals the poller adds each tick into (protocol rows per
   *             minute, 5-minute and hourly services, peers, destinations): a
   *             collision means both were active in the slot, each for its
   *             own part of it.
   */
  role: 'native' | 'rollup' | 'accumulator'
}

type SnapshotTable = {
  kind: 'snapshot'
  table: string
  keys: readonly string[]
  /** Point-in-time values; the target's copy wins. */
  values: readonly string[]
}

type IdentityTable = {
  kind: 'identity'
  table: 'device_identities'
  keys: readonly string[]
}

export type MergeTable = CounterTable | SnapshotTable | IdentityTable

/** Columns every registry table may carry that the merge never interprets. */
const META_COLUMNS = new Set(['id', 'created_at', 'updated_at'])

/**
 * Tables that reference `collectors` but hold no history: the merge moves
 * them with a rule of their own instead of the counter/snapshot machinery.
 * `infra_nodes`: the Gateway agent's node on the infrastructure view
 * (`repointInfraNode`). `gateway_hosts`, `gateway_observations`: the Gateway
 * agent's DHCP mirror, runtime state that follows `into`, the collector that
 * keeps running (`repointGatewayObservations`).
 */
export const NON_HISTORY_TABLES = new Set(['infra_nodes', 'gateway_hosts', 'gateway_observations'])
const IDENTITY_COLUMNS = ['primary_ip', 'ips', 'first_seen_at', 'last_seen_at']
const SERVICE_SUMS = ['bytes_served', 'bytes_received', 'packets_served', 'packets_received']
const BYTE_PACKET_SUMS = ['bytes_in', 'bytes_out', 'packets_in', 'packets_out']

/**
 * The rollup chains the merge rebuilds, in ladder order, each with the
 * retention tier of its source (how far back the tier below is complete).
 */
const REBUILT_SPECS: readonly (readonly [string, keyof BucketTierRetention])[] = [
  ['traffic:native→5m', 'nativeDays'],
  ['traffic:5m→hourly', 'fiveMinDays'],
  ['traffic:hourly→daily', 'hourlyDays'],
  ['protocol:native→5m', 'nativeDays'],
  ['protocol:5m→hourly', 'fiveMinDays'],
  ['protocol:hourly→daily', 'hourlyDays'],
]

function specNamed(name: string): RollupSpec {
  const spec = ROLLUP_SPECS.find((s) => s.name === name)
  if (!spec) throw new CollectorMergeError(`rollup spec "${name}" no longer exists`)
  return spec
}

/**
 * Additive columns of a rollup spec. Adding two rows is only the right
 * collision rule when every aggregate is a plain SUM of the same column.
 */
function specSums(spec: RollupSpec): string[] {
  return Object.entries(spec.aggregates).map(([column, expression]) => {
    if (expression !== `SUM(${column})`) {
      throw new CollectorMergeError(
        `rollup spec "${spec.name}" aggregates ${column} as ${expression}; ` +
          'collectors:merge only knows how to add plain sums'
      )
    }
    return column
  })
}

function withoutCollector(keys: readonly string[]): string[] {
  return keys.filter((k) => k !== 'collector_id')
}

/**
 * Every table that references `collectors`, with its merge semantics. Built
 * on demand (not at import time) so a drifted rollup spec surfaces as a
 * refusal of this command rather than as a crash of every ace command.
 */
export function mergeTables(): MergeTable[] {
  const sourceOf = (specName: string, role: CounterTable['role']): CounterTable => {
    const spec = specNamed(specName)
    return {
      kind: 'counter',
      role,
      table: spec.source,
      keys: [...withoutCollector(spec.keys), spec.sourceTimeColumn],
      sums: specSums(spec),
    }
  }
  const rollupOf = (specName: string): CounterTable => {
    const spec = specNamed(specName)
    return {
      kind: 'counter',
      role: 'rollup',
      table: spec.target,
      keys: [...withoutCollector(spec.keys), spec.targetTimeColumn],
      sums: specSums(spec),
    }
  }
  return [
    sourceOf('traffic:native→5m', 'native'),
    // Protocol rows are per minute (PROTOCOL_NATIVE_GRAIN_SECONDS): twelve
    // ticks upserted into one row, so they merge like the other accumulators.
    sourceOf('protocol:native→5m', 'accumulator'),
    ...REBUILT_SPECS.map(([name]) => rollupOf(name)),
    {
      kind: 'counter',
      role: 'accumulator',
      table: 'device_peer_buckets_hourly',
      keys: ['mac', 'scope', 'peer_ip', 'hour_start'],
      sums: ['bytes_in', 'bytes_out'],
    },
    {
      kind: 'counter',
      role: 'native',
      table: 'device_service_buckets',
      keys: ['mac', 'server_name', 'protocol', 'bucket_start'],
      sums: SERVICE_SUMS,
    },
    {
      kind: 'counter',
      role: 'accumulator',
      table: 'device_service_buckets_5m',
      keys: ['mac', 'server_name', 'protocol', 'slot_start'],
      sums: SERVICE_SUMS,
    },
    {
      kind: 'counter',
      role: 'accumulator',
      table: 'device_service_buckets_hourly',
      keys: ['mac', 'server_name', 'protocol', 'hour_start'],
      sums: SERVICE_SUMS,
    },
    {
      kind: 'counter',
      role: 'accumulator',
      table: 'device_destination_buckets_hourly',
      keys: ['mac', 'server_name', 'peer_ip', 'protocol', 'hour_start'],
      sums: BYTE_PACKET_SUMS,
      extras: ['category'],
    },
    {
      kind: 'snapshot',
      table: 'device_top_peers',
      keys: ['mac', 'peer_ip', 'scope'],
      values: ['bytes_in', 'bytes_out', 'updated_at'],
    },
    { kind: 'identity', table: 'device_identities', keys: ['mac'] },
  ]
}

function valueColumns(t: MergeTable): string[] {
  if (t.kind === 'counter') return [...t.sums, ...(t.extras ?? [])]
  if (t.kind === 'snapshot') return [...t.values]
  return IDENTITY_COLUMNS
}

export function collisionRule(t: MergeTable, policy: MergeOverlapPolicy): CollisionRule {
  if (t.kind === 'identity') return 'identity'
  if (t.kind === 'snapshot') return 'into'
  if (policy !== 'replace') return policy
  return t.role === 'native' ? 'into' : 'sum'
}

// ── small SQL helpers ────────────────────────────────────────────────────

type Client = QueryClientContract

function resultRows<T>(result: unknown): T[] {
  return ((Array.isArray(result) ? result[0] : result) ?? []) as T[]
}

function affectedRows(result: unknown): number {
  const head = Array.isArray(result) ? result[0] : result
  return Number((head as { affectedRows?: unknown } | undefined)?.affectedRows ?? 0)
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ')
}

/** Survivor alias `s`, removed alias `r`, joined on the table key. */
function keyJoin(t: MergeTable): string {
  return t.keys.map((k) => `s.${k} = r.${k}`).join(' AND ')
}

const SQL_DATETIME = '%Y-%m-%d %H:%i:%s'

function parseUtc(value: string): DateTime {
  return DateTime.fromSQL(value, { zone: 'utc' })
}

function floorTo(ts: DateTime, grainSeconds: number): DateTime {
  const sec = Math.floor(ts.toSeconds())
  return DateTime.fromSeconds(sec - (((sec % grainSeconds) + grainSeconds) % grainSeconds), {
    zone: 'utc',
  })
}

function ceilTo(ts: DateTime, grainSeconds: number): DateTime {
  const floored = floorTo(ts, grainSeconds)
  return floored.toMillis() < ts.toMillis() ? floored.plus({ seconds: grainSeconds }) : floored
}

function later(a: DateTime, b: DateTime): DateTime {
  return a.toMillis() >= b.toMillis() ? a : b
}

function earlier(a: DateTime, b: DateTime): DateTime {
  return a.toMillis() <= b.toMillis() ? a : b
}

async function countRows(client: Client, table: string, collectorId: number): Promise<number> {
  const [row] = resultRows<{ n: unknown }>(
    await client.rawQuery(`SELECT COUNT(*) AS n FROM ${table} WHERE collector_id = ?`, [
      collectorId,
    ])
  )
  return Number(row?.n ?? 0)
}

async function countCollisions(
  client: Client,
  t: MergeTable,
  survivorId: number,
  removedId: number
): Promise<number> {
  const [row] = resultRows<{ n: unknown }>(
    await client.rawQuery(
      `SELECT COUNT(*) AS n FROM ${t.table} r
         JOIN ${t.table} s ON s.collector_id = ? AND ${keyJoin(t)}
        WHERE r.collector_id = ?`,
      [survivorId, removedId]
    )
  )
  return Number(row?.n ?? 0)
}

// ── schema drift guard ───────────────────────────────────────────────────

/**
 * Refuses when the schema no longer matches the registry: a table that
 * references `collectors` but is not listed (its rows would be cascaded away
 * with the removed collector), a listed table whose unique key differs from
 * the registry's (collisions would be judged on the wrong columns), or a
 * column the registry does not account for (it would silently keep the
 * survivor's value on every collision).
 */
export async function assertMergeRegistryMatchesSchema(client: Client = db.connection()) {
  const tables = mergeTables()
  const names = tables.map((t) => t.table)

  const referencing = new Set(
    resultRows<{ t: string }>(
      await client.rawQuery(
        `SELECT table_name AS t FROM information_schema.referential_constraints
          WHERE constraint_schema = DATABASE() AND referenced_table_name = 'collectors'`
      )
    ).map((r) => r.t)
  )
  const unknown = [...referencing]
    .filter((t) => !names.includes(t) && !NON_HISTORY_TABLES.has(t))
    .sort()
  if (unknown.length > 0) {
    throw new CollectorMergeError(
      `${unknown.join(', ')} reference collectors, but collectors:merge does not know how to ` +
        'merge them. Add them to the registry in app/services/collector_merge.ts first.'
    )
  }
  const gone = names.filter((t) => !referencing.has(t))
  if (gone.length > 0) {
    throw new CollectorMergeError(
      `${gone.join(', ')} no longer reference collectors; the merge registry in ` +
        'app/services/collector_merge.ts is out of date.'
    )
  }

  const columnRows = resultRows<{ t: string; c: string }>(
    await client.rawQuery(
      `SELECT table_name AS t, column_name AS c FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name IN (${placeholders(names)})`,
      names
    )
  )
  const indexRows = resultRows<{ t: string; i: string; c: string }>(
    await client.rawQuery(
      `SELECT table_name AS t, index_name AS i, column_name AS c FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND non_unique = 0 AND table_name IN (${placeholders(names)})`,
      names
    )
  )

  const problems: string[] = []
  for (const t of tables) {
    const columns = new Set(columnRows.filter((r) => r.t === t.table).map((r) => r.c))
    const known = new Set(['collector_id', ...t.keys, ...valueColumns(t)])
    for (const c of known) {
      if (!columns.has(c)) problems.push(`${t.table}.${c} is missing`)
    }
    for (const c of columns) {
      if (!known.has(c) && !META_COLUMNS.has(c)) problems.push(`${t.table}.${c} is not handled`)
    }
    if (t.kind === 'counter' && !columns.has('updated_at')) {
      problems.push(`${t.table}.updated_at is missing`)
    }

    const wanted = ['collector_id', ...t.keys].sort().join(',')
    const uniqueKeys = new Map<string, string[]>()
    for (const r of indexRows.filter((row) => row.t === t.table)) {
      uniqueKeys.set(r.i, [...(uniqueKeys.get(r.i) ?? []), r.c])
    }
    const matches = [...uniqueKeys.values()].some((cols) => [...cols].sort().join(',') === wanted)
    if (!matches) problems.push(`${t.table} has no unique key on (${wanted})`)
  }
  if (problems.length > 0) {
    throw new CollectorMergeError(
      'The merge registry in app/services/collector_merge.ts no longer matches the schema: ' +
        `${problems.join('; ')}.`
    )
  }
}

// ── activity, overlap and rebuild windows ────────────────────────────────

/**
 * Traffic tiers from finest to coarsest, used to find when a collector
 * recorded anything. `grain` is how long one row covers; a native row covers
 * one poll interval, so its grain is the collector's (null here).
 */
const ACTIVITY_TIERS = [
  { table: 'device_traffic_buckets', column: 'bucket_start', grain: null },
  { table: 'device_traffic_buckets_5m', column: 'slot_start', grain: 300 },
  { table: 'device_traffic_buckets_hourly', column: 'hour_start', grain: 3600 },
  { table: 'device_traffic_buckets_daily', column: 'day_start', grain: 86400 },
] as const

export type ActivitySpan = { first: DateTime; last: DateTime }

/**
 * When a collector recorded traffic.
 *
 * `last` is the end of its newest row in the finest tier that has any, so it
 * is exact to the poll for anything polled within native retention.
 *
 * `first` walks from coarse to fine: the oldest daily row names the day, the
 * oldest hourly row refines it if it falls inside that day, then 5-minute,
 * then native. The walk stops at the first tier whose oldest row lies beyond
 * the current slot, because that tier has been pruned past the collector's
 * start (native keeps 30 days, 5-minute and hourly 730, daily 1825). So an
 * old capture box reads as "since 2026-05-24 13:25", not as the retention
 * edge of the native table, and a collector with an old stint and a recent
 * one still reads from its old stint.
 */
async function activitySpan(
  client: Client,
  collector: { id: number; pollIntervalSeconds: number }
): Promise<ActivitySpan | null> {
  const bounds: { lo: DateTime; hi: DateTime; grain: number }[] = []
  for (const tier of ACTIVITY_TIERS) {
    const [row] = resultRows<{ lo: string | null; hi: string | null }>(
      await client.rawQuery(
        `SELECT DATE_FORMAT(MIN(${tier.column}), '${SQL_DATETIME}') AS lo,
                DATE_FORMAT(MAX(${tier.column}), '${SQL_DATETIME}') AS hi
           FROM ${tier.table} WHERE collector_id = ?`,
        [collector.id]
      )
    )
    if (row?.lo && row.hi) {
      const grain = tier.grain ?? Math.max(5, collector.pollIntervalSeconds)
      bounds.push({ lo: parseUtc(row.lo), hi: parseUtc(row.hi), grain })
    }
  }
  if (bounds.length === 0) return null

  const finest = bounds[0]
  const last = finest.hi.plus({ seconds: finest.grain })

  let first: DateTime | null = null
  let slotEnd: DateTime | null = null
  for (const b of [...bounds].reverse()) {
    if (!first || !slotEnd || b.lo.toMillis() < first.toMillis()) {
      // Coarsest tier, or a finer tier that knows of older rows than the
      // coarser one (a rollup that has not run yet): take its start as is.
      first = b.lo
    } else if (b.lo.toMillis() >= slotEnd.toMillis()) {
      break
    } else {
      first = b.lo
    }
    slotEnd = b.lo.plus({ seconds: b.grain })
  }
  return { first: first!, last }
}

export type MergeOverlap = { start: DateTime; end: DateTime; seconds: number }

type SpanSubject = { id: number; pollIntervalSeconds: number }

async function activityOverlap(
  client: Client,
  fromSide: SpanSubject,
  intoSide: SpanSubject
): Promise<{ from: ActivitySpan | null; into: ActivitySpan | null; overlap: MergeOverlap | null }> {
  const from = await activitySpan(client, fromSide)
  const into = await activitySpan(client, intoSide)
  if (!from || !into) return { from, into, overlap: null }
  const start = later(from.first, into.first)
  const end = earlier(from.last, into.last)
  return {
    from,
    into,
    overlap: { start, end, seconds: (end.toMillis() - start.toMillis()) / 1000 },
  }
}

export type MergeRebuild = { spec: string; since: DateTime; until: DateTime }

/**
 * The slots of each rebuilt rollup that can hold rows of both collectors:
 * those between the later start and the earlier end, widened to the grain.
 * With a gap between the two (a clean hand-over) that is empty at 5 minutes
 * but still the shared hour and day.
 *
 * A slot is only rebuilt while the tier below still holds all of it, i.e.
 * while it is younger than that tier's retention, with one grain of margin so
 * the daily prune running during a long merge cannot cut into the first slot.
 * Older slots keep the collision rule's value: a rebuild there would come out
 * short. With native retention switched off (`BUCKET_RETENTION_DAYS` < 1, the
 * prune task then deletes nothing) no slot is clamped.
 */
export function rebuildWindows(
  overlap: MergeOverlap | null,
  options: { now?: DateTime; retention?: BucketTierRetention | null } = {}
): MergeRebuild[] {
  if (!overlap) return []
  const now = options.now ?? DateTime.utc()
  const retention = options.retention === undefined ? retentionFromEnv() : options.retention
  const windows: MergeRebuild[] = []
  for (const [name, sourceTier] of REBUILT_SPECS) {
    const grain = specNamed(name).grainSeconds
    const start = floorTo(overlap.start, grain)
    const end = floorTo(overlap.end.minus({ milliseconds: 1 }), grain).plus({ seconds: grain })
    const since = retention
      ? later(
          start,
          ceilTo(now.minus({ days: retention[sourceTier] }), grain).plus({ seconds: grain })
        )
      : start
    if (since.toMillis() >= end.toMillis()) continue
    windows.push({ spec: name, since, until: end })
  }
  return windows
}

/** Retention of the bucket tiers, or null when pruning is switched off. */
function retentionFromEnv(): BucketTierRetention | null {
  const nativeDays = nativeRetentionDaysFromEnv()
  if (!nativeDays || nativeDays < 1) return null
  return bucketTierRetentionDays(nativeDays, retentionOptionsFromEnv())
}

// ── infrastructure nodes ─────────────────────────────────────────────────

/**
 * The Gateway agent's node (`infra_nodes.collector_id`) is layout, not
 * history. Afterwards the merged collector has at most one node:
 *   - only the removed row has one: it moves to the survivor;
 *   - both have one: the one with more cables stays bound (on a tie, the one
 *     of `into`, whose ports are the running collector's), the other is
 *     detached (`collector_id = NULL`): it keeps its ports, cables and
 *     position, and the operator deletes or re-binds it;
 *   - otherwise nothing moves.
 */
export type InfraNodeMove = {
  /** The node bound to the merged collector afterwards, if any. */
  boundNodeId: number | null
  /** The node that stays bound but changes rows (it was the removed collector's). */
  movedNodeId: number | null
  /** The node that loses its binding. */
  detachedNodeId: number | null
  /** Cables on each collector's node, for the plan output. */
  links: Record<number, number>
}

async function collectorNodes(
  client: Client,
  collectorIds: number[]
): Promise<{ id: number; collectorId: number; links: number }[]> {
  return resultRows<{ id: number; collectorId: number; links: number | string }>(
    await client.rawQuery(
      `SELECT n.id AS id, n.collector_id AS collectorId,
              (SELECT COUNT(*) FROM infra_links l
                 JOIN infra_ports p ON p.id = l.a_port_id OR p.id = l.b_port_id
                WHERE p.node_id = n.id) AS links
         FROM infra_nodes n
        WHERE n.collector_id IN (${placeholders(collectorIds)})`,
      collectorIds
    )
  ).map((row) => ({
    id: Number(row.id),
    collectorId: Number(row.collectorId),
    links: Number(row.links),
  }))
}

export async function planInfraNodeMove(
  client: Client,
  sides: { survivorId: number; removedId: number; intoId: number }
): Promise<InfraNodeMove> {
  const nodes = await collectorNodes(client, [sides.survivorId, sides.removedId])
  const survivor = nodes.find((n) => n.collectorId === sides.survivorId) ?? null
  const removed = nodes.find((n) => n.collectorId === sides.removedId) ?? null
  const links = Object.fromEntries(nodes.map((n) => [n.id, n.links]))
  if (!removed) {
    return { boundNodeId: survivor?.id ?? null, movedNodeId: null, detachedNodeId: null, links }
  }
  if (!survivor) {
    return { boundNodeId: removed.id, movedNodeId: removed.id, detachedNodeId: null, links }
  }
  const intoNode = sides.intoId === sides.removedId ? removed : survivor
  const keep =
    survivor.links > removed.links ? survivor : removed.links > survivor.links ? removed : intoNode
  const detach = keep === survivor ? removed : survivor
  return {
    boundNodeId: keep.id,
    movedNodeId: keep === removed ? removed.id : null,
    detachedNodeId: detach.id,
    links,
  }
}

/**
 * Carries out `planInfraNodeMove` inside the merge transaction, before the
 * removed collector row is deleted (its ON DELETE SET NULL would otherwise
 * detach the removed side's node). The detach goes first: `collector_id` is
 * unique.
 */
export async function repointInfraNode(
  trx: Client,
  sides: { survivorId: number; removedId: number; intoId: number }
): Promise<InfraNodeMove> {
  const move = await planInfraNodeMove(trx, sides)
  const now = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')
  if (move.detachedNodeId !== null) {
    await trx.rawQuery('UPDATE infra_nodes SET collector_id = NULL, updated_at = ? WHERE id = ?', [
      now,
      move.detachedNodeId,
    ])
  }
  if (move.movedNodeId !== null) {
    await trx.rawQuery('UPDATE infra_nodes SET collector_id = ?, updated_at = ? WHERE id = ?', [
      sides.survivorId,
      now,
      move.movedNodeId,
    ])
  }
  return move
}

/** One line for the plan and result output, or null when no node is involved. */
export function describeInfraNodeMove(
  move: InfraNodeMove,
  sides: { survivorId: number; removedId: number }
): string | null {
  const cables = (id: number) => {
    const n = move.links[id] ?? 0
    return `${n} cable${n === 1 ? '' : 's'}`
  }
  if (move.detachedNodeId !== null && move.boundNodeId !== null) {
    return (
      `Infrastructure view: both collectors have a node. Node #${move.boundNodeId} ` +
      `(${cables(move.boundNodeId)}) stays bound to #${sides.survivorId}; node ` +
      `#${move.detachedNodeId} (${cables(move.detachedNodeId)}) is detached and keeps its ` +
      'ports, cables and position (delete or re-bind it on the Infrastructure page).'
    )
  }
  if (move.movedNodeId !== null) {
    return (
      `Infrastructure view: node #${move.movedNodeId} moves from #${sides.removedId} to ` +
      `#${sides.survivorId}.`
    )
  }
  if (move.boundNodeId !== null) {
    return `Infrastructure view: node #${move.boundNodeId} stays bound to #${sides.survivorId}.`
  }
  return null
}

// ── gateway observations ─────────────────────────────────────────────────

/** The Gateway agent's runtime mirrors (docs/collector-agent.md section 4.3). */
const GATEWAY_OBSERVATION_TABLES = ['gateway_hosts', 'gateway_observations'] as const

/**
 * The DHCP mirror is what the running collector (`into`) reports, not
 * history: afterwards the survivor holds `into`'s rows and the other side's
 * are gone. When `into` is the survivor that is only the removed side's rows
 * going (they would CASCADE anyway); otherwise the survivor's own rows are
 * dropped and `into`'s move over. The server's fingerprint cache is keyed by
 * row id and may still name the survivor's old report; the next report of
 * the collector (a new session sends it first thing) rewrites it if needed.
 */
export async function repointGatewayObservations(
  trx: Client,
  sides: { survivorId: number; removedId: number; intoId: number }
): Promise<void> {
  const dropId = sides.intoId === sides.survivorId ? sides.removedId : sides.survivorId
  for (const table of GATEWAY_OBSERVATION_TABLES) {
    await trx.rawQuery(`DELETE FROM ${table} WHERE collector_id = ?`, [dropId])
  }
  if (sides.intoId === sides.removedId) {
    for (const table of GATEWAY_OBSERVATION_TABLES) {
      await trx.rawQuery(`UPDATE ${table} SET collector_id = ? WHERE collector_id = ?`, [
        sides.survivorId,
        sides.removedId,
      ])
    }
  }
}

// ── the plan ─────────────────────────────────────────────────────────────

export type MergeSide = {
  id: number
  name: string
  baseUrl: string | null
  source: string
  lifecycle: string
  /** As found, before the command takes both collectors out of service. */
  enabled: boolean
  instanceId: string | null
  pollIntervalSeconds: number
  rows: number
  activity: ActivitySpan | null
}

export type MergeTablePlan = {
  table: string
  kind: MergeTable['kind']
  role: CounterTable['role'] | null
  /** Rows of the removed side in this table. */
  moving: number
  /** Of those, rows whose key the survivor already has. */
  collisions: number
  rule: CollisionRule | null
}

export type CollectorMergePlan = {
  from: MergeSide
  into: MergeSide
  /** The row that remains (and carries `into`'s identity). */
  survivorId: number
  /** The row that is deleted once its history has moved. */
  removedId: number
  overlap: MergeOverlap | null
  policy: MergeOverlapPolicy | null
  policySource: 'explicit' | 'automatic' | null
  /** Why the merge must not run as asked. Non-empty means nothing is executed. */
  refusals: string[]
  tables: MergeTablePlan[]
  rebuilds: MergeRebuild[]
  /** What happens to the collectors' nodes on the infrastructure view. */
  infraNodes: InfraNodeMove
  warnings: string[]
}

export type PlanOptions = {
  fromId: number
  intoId: number
  overlap?: MergeOverlapPolicy
  client?: Client
  /** The server's COLLECTOR_URL; read from the environment when not given. */
  collectorUrl?: string | null
}

/**
 * What the next server start does with COLLECTOR_URL, given the rows the merge
 * leaves (`ensureDefaultCollector` in app/services/default_collector.ts), when
 * the merge itself is what changes the outcome:
 *   - the retired collector was the COLLECTOR_URL row: its address would be
 *     registered again as a new collector and polled alongside the merged one;
 *   - the merge leaves a single manual row and no row at that address: the
 *     start would move the merged collector there and swap its key.
 */
function collectorUrlConflict(
  collectorUrl: string | null | undefined,
  from: Collector,
  after: { source: string; baseUrl: string | null }[]
): string | null {
  if (!collectorUrl) return null
  const target = collectorUrl.replace(/\/+$/, '')
  if (after.some((row) => row.baseUrl === target)) return null
  const unset =
    'Take it out of the server environment first (docker-compose.no-collector.yml in ' +
    'COMPOSE_FILE, or unset COLLECTOR_URL), recreate the server, then merge.'
  if (from.source === 'env') {
    return (
      `This server still sets COLLECTOR_URL=${target}, which registered #${from.id}. After the ` +
      'merge its next start would register that address again as a new collector, polled and ' +
      `counted next to the merged one. ${unset}`
    )
  }
  if (
    !after.some((row) => row.source === 'env') &&
    after.length === 1 &&
    after[0].source === 'manual'
  ) {
    return (
      `This server sets COLLECTOR_URL=${target}. The merge leaves one manually added collector, ` +
      `which its next start would move to that address and give COLLECTOR_API_KEY. ${unset}`
    )
  }
  return null
}

export function describeDuration(seconds: number): string {
  if (seconds < 120) return `${Math.round(seconds)} s`
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} h`
  return `${(seconds / 86400).toFixed(1)} days`
}

/**
 * Validates the request and works out everything the merge will do, without
 * changing anything. Throws `CollectorMergeError` for requests that can never
 * run (unknown ids, same id, target not adopted, schema drift); returns a plan
 * with `refusals` when the request needs a decision or a config change first.
 */
export async function planCollectorMerge(options: PlanOptions): Promise<CollectorMergePlan> {
  const client = options.client ?? db.connection()
  const { fromId, intoId } = options
  if (fromId === intoId) {
    throw new CollectorMergeError('--from and --into name the same collector.')
  }

  const rows = await Collector.query({ client }).whereIn('id', [fromId, intoId])
  const from = rows.find((c) => c.id === fromId)
  const into = rows.find((c) => c.id === intoId)
  if (!from) throw new CollectorMergeError(`No collector with id=${fromId}.`)
  if (!into) throw new CollectorMergeError(`No collector with id=${intoId}.`)
  if (into.lifecycle !== 'adopted') {
    throw new CollectorMergeError(
      `Collector #${into.id} is ${into.lifecycle}. Adopt it first (Settings → Collectors), ` +
        'then merge the old history into it.'
    )
  }

  await assertMergeRegistryMatchesSchema(client)
  const tables = mergeTables()

  const perTable = new Map<string, { from: number; into: number }>()
  for (const t of tables) {
    perTable.set(t.table, {
      from: await countRows(client, t.table, fromId),
      into: await countRows(client, t.table, intoId),
    })
  }
  const total = (side: 'from' | 'into') =>
    [...perTable.values()].reduce((sum, counts) => sum + counts[side], 0)
  const fromRows = total('from')
  const intoRows = total('into')

  // Keep the bigger side in place; a tie keeps the target's own row.
  const survivorId = fromRows > intoRows ? fromId : intoId
  const removedId = survivorId === fromId ? intoId : fromId

  const activity = await activityOverlap(client, from, into)
  const overlap = activity.overlap

  let policy: MergeOverlapPolicy | null = null
  let policySource: CollectorMergePlan['policySource'] = null
  const refusals: string[] = []
  if (options.overlap) {
    policy = options.overlap
    policySource = 'explicit'
  } else if (!overlap || overlap.seconds <= AUTO_REPLACE_MAX_OVERLAP_SECONDS) {
    policy = 'replace'
    policySource = 'automatic'
  } else {
    refusals.push(
      `Both collectors recorded traffic for ${describeDuration(overlap.seconds)} ` +
        `(${overlap.start.toFormat('yyyy-MM-dd HH:mm')} to ${overlap.end.toFormat('yyyy-MM-dd HH:mm')} UTC), ` +
        'which is more than a hand-over, so there is no safe default. Re-run with ' +
        '--overlap=into if they saw the same traffic (the target keeps its numbers wherever ' +
        'both recorded a slot), or --overlap=sum if they saw different traffic (the numbers are ' +
        'added). --overlap=replace treats it as a hand-over anyway.'
    )
  }

  const collectorUrl = 'collectorUrl' in options ? options.collectorUrl : env.get('COLLECTOR_URL')
  const others = await Collector.query({ client }).whereNotIn('id', [fromId, intoId])
  const conflict = collectorUrlConflict(collectorUrl, from, [
    ...others.map((c) => ({ source: c.source, baseUrl: c.baseUrl })),
    // The survivor carries the target's identity, whichever row it is.
    { source: into.source, baseUrl: into.baseUrl },
  ])
  if (conflict) refusals.push(conflict)

  const tablePlans: MergeTablePlan[] = []
  for (const t of tables) {
    const counts = perTable.get(t.table)!
    const moving = removedId === fromId ? counts.from : counts.into
    tablePlans.push({
      table: t.table,
      kind: t.kind,
      role: t.kind === 'counter' ? t.role : null,
      moving,
      collisions: moving > 0 ? await countCollisions(client, t, survivorId, removedId) : 0,
      rule: policy ? collisionRule(t, policy) : null,
    })
  }

  const infraNodes = await planInfraNodeMove(client, { survivorId, removedId, intoId })

  const warnings: string[] = []
  if (!into.enabled) {
    warnings.push(
      `#${into.id} is disabled, so the merged collector will be too. Enable it under Settings → ` +
        'Collectors afterwards (an interrupted merge also leaves both collectors disabled).'
    )
  }
  if (from.source === 'announced' || from.instanceId) {
    warnings.push(
      `If the daemon behind #${from.id} is still running with server_url set, its next announce ` +
        'shows up as a new pending collector. Stop it, or dismiss that entry.'
    )
  }

  const side = (c: Collector, rowCount: number, span: ActivitySpan | null): MergeSide => ({
    id: c.id,
    name: c.name,
    baseUrl: c.baseUrl,
    source: c.source,
    lifecycle: c.lifecycle,
    enabled: Boolean(c.enabled),
    instanceId: c.instanceId,
    pollIntervalSeconds: c.pollIntervalSeconds,
    rows: rowCount,
    activity: span,
  })

  return {
    from: side(from, fromRows, activity.from),
    into: side(into, intoRows, activity.into),
    survivorId,
    removedId,
    overlap,
    policy,
    policySource,
    refusals,
    tables: tablePlans,
    rebuilds: policy ? rebuildWindows(overlap) : [],
    infraNodes,
    warnings,
  }
}

// ── execution ────────────────────────────────────────────────────────────

export type MergeTableResult = {
  table: string
  rule: CollisionRule
  /** Rows re-keyed onto the survivor. */
  moved: number
  /** Rows of the removed side folded into an existing survivor row. */
  collisions: number
}

export type CollectorMergeResult = {
  survivorId: number
  removedId: number
  tables: MergeTableResult[]
  rebuilds: RollupRunResult[]
  infraNodes: InfraNodeMove
  collector: Collector
}

async function mergeCounterOrSnapshot(
  trx: Client,
  t: CounterTable | SnapshotTable,
  rule: 'into' | 'sum',
  survivorId: number,
  removedId: number,
  intoIsRemoved: boolean
): Promise<number> {
  const sets: string[] = []
  if (t.kind === 'snapshot') {
    if (intoIsRemoved) sets.push(...t.values.map((c) => `s.${c} = r.${c}`))
  } else {
    if (rule === 'sum') sets.push(...t.sums.map((c) => `s.${c} = s.${c} + r.${c}`))
    else if (intoIsRemoved) sets.push(...t.sums.map((c) => `s.${c} = r.${c}`))
    for (const c of t.extras ?? []) {
      sets.push(
        intoIsRemoved
          ? `s.${c} = IF(r.${c} = '', s.${c}, r.${c})`
          : `s.${c} = IF(s.${c} = '', r.${c}, s.${c})`
      )
    }
    if (sets.length > 0) sets.push('s.updated_at = UTC_TIMESTAMP()')
  }
  // Each assignment reads only its own column, so the unspecified order of a
  // multi-table UPDATE's assignments cannot matter.
  if (sets.length > 0) {
    await trx.rawQuery(
      `UPDATE ${t.table} s JOIN ${t.table} r ON r.collector_id = ? AND ${keyJoin(t)}
          SET ${sets.join(', ')}
        WHERE s.collector_id = ?`,
      [removedId, survivorId]
    )
  }
  return deleteCollisions(trx, t, survivorId, removedId)
}

async function mergeIdentities(
  trx: Client,
  t: IdentityTable,
  survivorId: number,
  removedId: number
): Promise<number> {
  // Addresses follow whichever side saw the device last. A separate statement
  // with the choice in WHERE, because the next one rewrites last_seen_at.
  await trx.rawQuery(
    `UPDATE ${t.table} s JOIN ${t.table} r ON r.collector_id = ? AND ${keyJoin(t)}
        SET s.primary_ip = r.primary_ip, s.ips = r.ips
      WHERE s.collector_id = ?
        AND r.last_seen_at IS NOT NULL
        AND (s.last_seen_at IS NULL OR r.last_seen_at > s.last_seen_at)`,
    [removedId, survivorId]
  )
  await trx.rawQuery(
    `UPDATE ${t.table} s JOIN ${t.table} r ON r.collector_id = ? AND ${keyJoin(t)}
        SET s.first_seen_at = CASE
              WHEN s.first_seen_at IS NULL THEN r.first_seen_at
              WHEN r.first_seen_at IS NULL THEN s.first_seen_at
              ELSE LEAST(s.first_seen_at, r.first_seen_at) END,
            s.last_seen_at = CASE
              WHEN s.last_seen_at IS NULL THEN r.last_seen_at
              WHEN r.last_seen_at IS NULL THEN s.last_seen_at
              ELSE GREATEST(s.last_seen_at, r.last_seen_at) END,
            s.updated_at = UTC_TIMESTAMP()
      WHERE s.collector_id = ?`,
    [removedId, survivorId]
  )
  return deleteCollisions(trx, t, survivorId, removedId)
}

async function deleteCollisions(
  trx: Client,
  t: MergeTable,
  survivorId: number,
  removedId: number
): Promise<number> {
  return affectedRows(
    await trx.rawQuery(
      `DELETE r FROM ${t.table} r
         JOIN ${t.table} s ON s.collector_id = ? AND ${keyJoin(t)}
        WHERE r.collector_id = ?`,
      [survivorId, removedId]
    )
  )
}

/** Collector attributes that stay with the row rather than the identity. */
const ROW_ATTRIBUTES = new Set(['id', 'createdAt', 'updatedAt'])

/**
 * Runs a plan inside `trx`. The caller owns the transaction (and its retry)
 * and must have taken both collectors out of service first, so the poller
 * is not writing rows behind the sweep.
 */
export async function executeCollectorMerge(
  plan: CollectorMergePlan,
  trx: TransactionClientContract
): Promise<CollectorMergeResult> {
  if (plan.refusals.length > 0 || !plan.policy) {
    throw new CollectorMergeError(
      plan.refusals.join(' ') || 'The merge plan has no overlap policy.'
    )
  }
  const { survivorId, removedId, policy } = plan

  const locked = await Collector.query({ client: trx })
    .whereIn('id', [survivorId, removedId])
    .forUpdate()
  const survivor = locked.find((c) => c.id === survivorId)
  const removed = locked.find((c) => c.id === removedId)
  if (!survivor || !removed) {
    throw new CollectorMergeError('One of the collectors disappeared since the plan was made.')
  }
  const intoIsRemoved = plan.into.id === removedId

  // The windows are recomputed here, after quiescing, from the final state of
  // both collectors; once the rows move they can no longer be told apart.
  await assertMergeRegistryMatchesSchema(trx)
  const { overlap } = await activityOverlap(trx, plan.from, plan.into)
  const windows = rebuildWindows(overlap)

  const tables: MergeTableResult[] = []
  for (const t of mergeTables()) {
    const rule = collisionRule(t, policy)
    const collisions =
      t.kind === 'identity'
        ? await mergeIdentities(trx, t, survivorId, removedId)
        : await mergeCounterOrSnapshot(
            trx,
            t,
            rule as 'into' | 'sum',
            survivorId,
            removedId,
            intoIsRemoved
          )
    const moved = affectedRows(
      await trx.rawQuery(`UPDATE ${t.table} SET collector_id = ? WHERE collector_id = ?`, [
        survivorId,
        removedId,
      ])
    )
    tables.push({ table: t.table, rule, moved, collisions })
  }

  const rebuilds: RollupRunResult[] = []
  for (const w of windows) {
    rebuilds.push(
      await runRollupSpec(specNamed(w.spec), w.since, w.until, {
        client: trx,
        collectorId: survivorId,
      })
    )
  }

  // ON DELETE CASCADE would take anything left behind with the row; make sure
  // nothing is, or roll the whole merge back.
  for (const t of mergeTables()) {
    const left = await countRows(trx, t.table, removedId)
    if (left > 0) {
      throw new CollectorMergeError(
        `${t.table} still holds ${left} rows of #${removedId} after the move; nothing was changed.`
      )
    }
  }

  // Runtime mirrors: `into`'s copy is what the running collector reports.
  await repointGatewayObservations(trx, { survivorId, removedId, intoId: plan.into.id })

  // Layout, not history: the Gateway agent's node follows the merged collector.
  const infraNodes = await repointInfraNode(trx, {
    survivorId,
    removedId,
    intoId: plan.into.id,
  })

  const intoRow = intoIsRemoved ? removed : survivor
  const identity: Record<string, unknown> = {}
  for (const attribute of Collector.$columnsDefinitions.keys()) {
    if (!ROW_ATTRIBUTES.has(attribute)) {
      identity[attribute] = (intoRow as unknown as Record<string, unknown>)[attribute]
    }
  }
  const createdAt = earlier(survivor.createdAt, removed.createdAt)

  // Delete first: the survivor is about to take the removed row's unique
  // instance_id.
  removed.useTransaction(trx)
  await removed.delete()

  survivor.useTransaction(trx)
  if (intoIsRemoved) survivor.merge(identity)
  survivor.enabled = plan.into.enabled
  survivor.createdAt = createdAt
  await survivor.save()

  return { survivorId, removedId, tables, rebuilds, infraNodes, collector: survivor }
}
