import db from '@adonisjs/lucid/services/db'
import type { QueryClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'

/**
 * Rollup maintenance: rebuilds every coarse tier from the tier below it over
 * a short trailing window, once a minute. Each spec is one
 * `INSERT … SELECT … GROUP BY slot ON DUPLICATE KEY UPDATE col = VALUES(col)`
 * — a *replace* of the slot's value computed from source rows, not an
 * additive merge — so re-running over the same window is idempotent and a
 * late native write inside the lookback simply corrects the slot.
 *
 * Why this instead of fanning every native write into every tier: the
 * per-tick fan-out issued three UPSERTs per stream per tick and rewrote the
 * same hourly row ~720 times an hour. Recomputing from closed buckets issues
 * ~12 statements per minute in total, over a few thousand rows.
 *
 * Slot alignment uses `TO_SECONDS()` arithmetic (a pure calendar
 * calculation) so it never depends on the DB session time zone; the stored
 * timestamps are UTC wall times.
 *
 * Specs run in list order: a tier that reads from another rollup (hourly from
 * 5 m, daily from hourly) is listed after its source.
 */
export type RollupSpec = {
  name: string
  source: string
  target: string
  sourceTimeColumn: string
  targetTimeColumn: string
  grainSeconds: number
  /** Group-by key columns copied verbatim from source to target. */
  keys: string[]
  /** target column → aggregate expression over the source rows. */
  aggregates: Record<string, string>
  /** Optional extra WHERE fragment on the source (no leading AND). */
  where?: string
}

const TRAFFIC_SUMS = [
  'bytes_in',
  'bytes_out',
  'packets_in',
  'packets_out',
  'bytes_in_wan',
  'bytes_out_wan',
  'packets_in_wan',
  'packets_out_wan',
  'bytes_in_lan',
  'bytes_out_lan',
  'packets_in_lan',
  'packets_out_lan',
]
const PROTOCOL_SUMS = ['bytes_in', 'bytes_out', 'packets_in', 'packets_out']
const WIFI_IFACE_SUMS = [
  'bytes_in',
  'bytes_out',
  'packets_in',
  'packets_out',
  'errs_in',
  'errs_out',
  'drops_in',
  'drops_out',
]

function sums(cols: string[]): Record<string, string> {
  return Object.fromEntries(cols.map((c) => [c, `SUM(${c})`]))
}

const WIFI_IFACE_ATTRS = { ssid: 'MAX(ssid)', radio: 'MAX(radio)', band: 'MAX(band)' }

/** Active-station threshold — must match the read path in `wifi_controller`. */
const WIFI_ACTIVE_MS = 200000

export const ROLLUP_SPECS: readonly RollupSpec[] = [
  // ── device traffic ─────────────────────────────────────────────────────
  {
    name: 'traffic:native→5m',
    source: 'device_traffic_buckets',
    target: 'device_traffic_buckets_5m',
    sourceTimeColumn: 'bucket_start',
    targetTimeColumn: 'slot_start',
    grainSeconds: 300,
    keys: ['collector_id', 'mac'],
    aggregates: sums(TRAFFIC_SUMS),
  },
  {
    name: 'traffic:5m→hourly',
    source: 'device_traffic_buckets_5m',
    target: 'device_traffic_buckets_hourly',
    sourceTimeColumn: 'slot_start',
    targetTimeColumn: 'hour_start',
    grainSeconds: 3600,
    keys: ['collector_id', 'mac'],
    aggregates: sums(TRAFFIC_SUMS),
  },
  {
    name: 'traffic:hourly→daily',
    source: 'device_traffic_buckets_hourly',
    target: 'device_traffic_buckets_daily',
    sourceTimeColumn: 'hour_start',
    targetTimeColumn: 'day_start',
    grainSeconds: 86400,
    keys: ['collector_id', 'mac'],
    aggregates: sums(TRAFFIC_SUMS),
  },
  // ── device protocol ────────────────────────────────────────────────────
  {
    name: 'protocol:native→5m',
    source: 'device_protocol_buckets',
    target: 'device_protocol_buckets_5m',
    sourceTimeColumn: 'bucket_start',
    targetTimeColumn: 'slot_start',
    grainSeconds: 300,
    keys: ['collector_id', 'mac', 'protocol'],
    aggregates: sums(PROTOCOL_SUMS),
  },
  {
    name: 'protocol:5m→hourly',
    source: 'device_protocol_buckets_5m',
    target: 'device_protocol_buckets_hourly',
    sourceTimeColumn: 'slot_start',
    targetTimeColumn: 'hour_start',
    grainSeconds: 3600,
    keys: ['collector_id', 'mac', 'protocol'],
    aggregates: sums(PROTOCOL_SUMS),
  },
  {
    name: 'protocol:hourly→daily',
    source: 'device_protocol_buckets_hourly',
    target: 'device_protocol_buckets_daily',
    sourceTimeColumn: 'hour_start',
    targetTimeColumn: 'day_start',
    grainSeconds: 86400,
    keys: ['collector_id', 'mac', 'protocol'],
    aggregates: sums(PROTOCOL_SUMS),
  },
  // ── wifi interface counters ────────────────────────────────────────────
  {
    name: 'wifi_iface:native→5m',
    source: 'wifi_interface_buckets',
    target: 'wifi_interface_buckets_5m',
    sourceTimeColumn: 'bucket_start',
    targetTimeColumn: 'slot_start',
    grainSeconds: 300,
    keys: ['ap_id', 'ifname'],
    aggregates: { ...WIFI_IFACE_ATTRS, ...sums(WIFI_IFACE_SUMS) },
  },
  {
    name: 'wifi_iface:5m→hourly',
    source: 'wifi_interface_buckets_5m',
    target: 'wifi_interface_buckets_hourly',
    sourceTimeColumn: 'slot_start',
    targetTimeColumn: 'hour_start',
    grainSeconds: 3600,
    keys: ['ap_id', 'ifname'],
    aggregates: { ...WIFI_IFACE_ATTRS, ...sums(WIFI_IFACE_SUMS) },
  },
  {
    name: 'wifi_iface:hourly→daily',
    source: 'wifi_interface_buckets_hourly',
    target: 'wifi_interface_buckets_daily',
    sourceTimeColumn: 'hour_start',
    targetTimeColumn: 'day_start',
    grainSeconds: 86400,
    keys: ['ap_id', 'ifname'],
    aggregates: { ...WIFI_IFACE_ATTRS, ...sums(WIFI_IFACE_SUMS) },
  },
  // ── wifi snapshot streams → 5 m ────────────────────────────────────────
  {
    name: 'wifi_station:snapshots→5m',
    source: 'wifi_station_snapshots',
    target: 'wifi_station_buckets_5m',
    sourceTimeColumn: 'recorded_at',
    targetTimeColumn: 'slot_start',
    grainSeconds: 300,
    keys: ['ap_id', 'mac'],
    aggregates: {
      ifname: 'MAX(ifname)',
      ssid: 'MAX(ssid)',
      band: 'MAX(band)',
      avg_signal_dbm: 'AVG(signal_dbm)',
      min_signal_dbm: 'MIN(signal_dbm)',
      max_signal_dbm: 'MAX(signal_dbm)',
      avg_snr_db: 'AVG(snr_db)',
      max_tx_rate_kbps: 'MAX(tx_rate_kbps)',
      max_rx_rate_kbps: 'MAX(rx_rate_kbps)',
      samples: 'COUNT(*)',
      active_samples: `SUM(CASE WHEN inactive_ms < ${WIFI_ACTIVE_MS} THEN 1 ELSE 0 END)`,
    },
  },
  {
    name: 'wifi_network:snapshots→5m',
    source: 'wifi_network_snapshots',
    target: 'wifi_network_buckets_5m',
    sourceTimeColumn: 'recorded_at',
    targetTimeColumn: 'slot_start',
    grainSeconds: 300,
    keys: ['ap_id', 'ifname'],
    aggregates: {
      ssid: 'MAX(ssid)',
      band: 'MAX(band)',
      avg_signal_dbm: 'AVG(signal_dbm)',
      avg_noise_dbm: 'AVG(noise_dbm)',
      avg_quality: 'AVG(quality)',
      max_bitrate_kbps: 'MAX(bitrate_kbps)',
      samples: 'COUNT(*)',
    },
  },
  {
    name: 'ap_system:snapshots→5m',
    source: 'ap_system_snapshots',
    target: 'ap_system_buckets_5m',
    sourceTimeColumn: 'recorded_at',
    targetTimeColumn: 'slot_start',
    grainSeconds: 300,
    keys: ['ap_id'],
    aggregates: {
      avg_load_1: 'AVG(load_1)',
      avg_load_5: 'AVG(load_5)',
      avg_load_15: 'AVG(load_15)',
      max_mem_total: 'MAX(mem_total)',
      max_mem_available: 'MAX(mem_available)',
      max_conntrack_entries: 'MAX(conntrack_entries)',
      max_conntrack_limit: 'MAX(conntrack_limit)',
      max_uptime_seconds: 'MAX(uptime_seconds)',
      samples: 'COUNT(*)',
    },
  },
]

export type RollupRunResult = { name: string; affected: number; since: string; until: string }

export type RollupRunOptions = {
  /** Run on this client (a transaction, typically) instead of the default connection. */
  client?: QueryClientContract
  /**
   * Recompute only this collector's slots. The spec must be keyed by
   * `collector_id` (the device specs are; the WiFi specs are not).
   */
  collectorId?: number
}

function sql(ts: DateTime): string {
  return ts.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
}

/** Floor a UTC instant to the spec's grain (epoch-anchored, like `alignToBucket`). */
function floorToGrain(ts: DateTime, grainSeconds: number): DateTime {
  const sec = Math.floor(ts.toSeconds())
  return DateTime.fromSeconds(sec - (sec % grainSeconds), { zone: 'utc' })
}

/**
 * Recompute every target slot that intersects `[since, until)` from the
 * source rows in that window. `since` is floored to the grain so no slot is
 * ever computed from a partial view of its source rows.
 */
export async function runRollupSpec(
  spec: RollupSpec,
  since: DateTime,
  until: DateTime,
  options: RollupRunOptions = {}
): Promise<RollupRunResult> {
  const { collectorId } = options
  if (collectorId !== undefined && !spec.keys.includes('collector_id')) {
    throw new Error(`rollup spec ${spec.name} is not keyed by collector_id`)
  }
  const from = floorToGrain(since, spec.grainSeconds)
  const aggCols = Object.keys(spec.aggregates)
  const slotExpr = `DATE_SUB(${spec.sourceTimeColumn}, INTERVAL MOD(TO_SECONDS(${spec.sourceTimeColumn}), ${spec.grainSeconds}) SECOND)`

  const statement = `
    INSERT INTO ${spec.target}
      (${[...spec.keys, spec.targetTimeColumn, ...aggCols, 'updated_at'].join(', ')})
    SELECT
      ${spec.keys.join(', ')},
      ${slotExpr} AS rollup_slot,
      ${aggCols.map((c) => spec.aggregates[c]).join(', ')},
      UTC_TIMESTAMP()
    FROM ${spec.source}
    WHERE ${spec.sourceTimeColumn} >= ? AND ${spec.sourceTimeColumn} < ?
      ${spec.where ? `AND (${spec.where})` : ''}
      ${collectorId !== undefined ? 'AND collector_id = ?' : ''}
    GROUP BY ${spec.keys.join(', ')}, rollup_slot
    ON DUPLICATE KEY UPDATE
      ${aggCols.map((c) => `${c} = VALUES(${c})`).join(', ')},
      updated_at = VALUES(updated_at)
  `
  const bindings: (string | number)[] = [sql(from), sql(until)]
  if (collectorId !== undefined) bindings.push(collectorId)
  const client = options.client ?? db.connection()
  const res = await client.rawQuery(statement, bindings)
  const affected = Number((Array.isArray(res) ? res[0]?.affectedRows : res?.affectedRows) ?? 0)
  return { name: spec.name, affected, since: sql(from), until: sql(until) }
}

/**
 * The once-a-minute maintenance pass: every spec over its own trailing
 * window of `lookbackGrains` target slots (default 2 — the open slot plus
 * the one just closed, which covers a poll that lands seconds late).
 */
export async function runAllRollups(
  options: { now?: DateTime; lookbackGrains?: number; specs?: readonly RollupSpec[] } = {}
): Promise<RollupRunResult[]> {
  const now = options.now ?? DateTime.utc()
  const lookbackGrains = options.lookbackGrains ?? 2
  const results: RollupRunResult[] = []
  for (const spec of options.specs ?? ROLLUP_SPECS) {
    const since = now.minus({ seconds: spec.grainSeconds * lookbackGrains })
    results.push(await runRollupSpec(spec, since, now))
  }
  return results
}

/**
 * Rebuild every tier over an arbitrary window (backfill / repair). Runs the
 * specs in order so each chained tier sees its freshly rebuilt source.
 */
export async function backfillRollups(
  since: DateTime,
  until: DateTime,
  specs: readonly RollupSpec[] = ROLLUP_SPECS
): Promise<RollupRunResult[]> {
  const results: RollupRunResult[] = []
  for (const spec of specs) {
    results.push(await runRollupSpec(spec, since, until))
  }
  return results
}
