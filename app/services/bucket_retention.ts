import env from '#start/env'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * Tiered retention. Each tier is keyed on its own time column and pruned at
 * its own horizon. The native per-poll tables and the raw WiFi snapshot
 * streams are the bulk of the row volume and are pruned aggressively; the
 * coarser rollups are kept far longer at a tiny fraction of the volume, so
 * multi-month / multi-year charts survive after the fine rows are gone.
 *
 *   tier             time column    default retention
 *   native buckets   bucket_start   30 d   (BUCKET_RETENTION_DAYS; traffic, protocol, service)
 *   wifi snapshots   recorded_at    14 d   (WIFI_SNAPSHOT_RETENTION_DAYS)
 *   wifi events      detected_at    90 d   (WIFI_EVENT_RETENTION_DAYS)
 *   peer hourly      hour_start     90 d   (PEER_HOURLY_RETENTION_DAYS)
 *   service hourly   hour_start     365 d  (SERVICE_HOURLY_RETENTION_DAYS)
 *   service 5m       slot_start     14 d   (SERVICE_5M_RETENTION_DAYS)
 *   router samples   recorded_at    90 d   (ROUTER_SAMPLE_RETENTION_DAYS)
 *   destination hourly hour_start   365 d  (DESTINATION_HOURLY_RETENTION_DAYS)
 *   5-minute         slot_start     730 d  (BUCKET_5M_RETENTION_DAYS)
 *   hourly           hour_start     730 d  (BUCKET_HOURLY_RETENTION_DAYS)
 *   daily            day_start      1825 d (BUCKET_DAILY_RETENTION_DAYS)
 *
 * Invariant: each coarser bucket tier lives at least as long as the finer
 * tier below it (a 5-minute row is never pruned while its native source could
 * remain; daily outlives hourly).
 */
const NATIVE_TABLES = [
  'device_traffic_buckets',
  'device_protocol_buckets',
  'device_service_buckets',
  'wifi_interface_buckets',
] as const
const FIVE_MIN_TABLES = [
  'device_traffic_buckets_5m',
  'device_protocol_buckets_5m',
  'wifi_interface_buckets_5m',
  'wifi_station_buckets_5m',
  'wifi_network_buckets_5m',
  'ap_system_buckets_5m',
  'wifi_client_distribution',
  'wifi_client_totals',
] as const
const HOURLY_TABLES = [
  'device_traffic_buckets_hourly',
  'device_protocol_buckets_hourly',
  'wifi_interface_buckets_hourly',
] as const
const DAILY_TABLES = [
  'device_traffic_buckets_daily',
  'device_protocol_buckets_daily',
  'wifi_interface_buckets_daily',
] as const
const WIFI_SNAPSHOT_TABLES = [
  'wifi_station_snapshots',
  'wifi_network_snapshots',
  'ap_system_snapshots',
] as const

/** Defaults for every horizon other than the native one (which is required). */
export const RETENTION_DEFAULTS = {
  fiveMinRetentionDays: 730,
  hourlyRetentionDays: 730,
  dailyRetentionDays: 1825,
  wifiSnapshotRetentionDays: 14,
  wifiEventRetentionDays: 90,
  peerHourlyRetentionDays: 90,
  serviceHourlyRetentionDays: 365,
  service5mRetentionDays: 14,
  routerSampleRetentionDays: 90,
  destinationHourlyRetentionDays: 365,
} as const

/**
 * Rows deleted per statement. Pruning a day of dense ~5 s captures is
 * hundreds of thousands of rows; batching keeps each DELETE short rather
 * than holding one long lock that could stall the poller's writes.
 */
const DEFAULT_BATCH = 50_000

/** Default when `BUCKET_RETENTION_DAYS` is unset. */
export const DEFAULT_NATIVE_RETENTION_DAYS = 30

export function nativeRetentionDaysFromEnv(): number {
  return env.get('BUCKET_RETENTION_DAYS', DEFAULT_NATIVE_RETENTION_DAYS)
}

/** Every non-native retention horizon from the environment, falling back to the defaults. */
export function retentionOptionsFromEnv(): PruneOptions {
  return {
    fiveMinRetentionDays: env.get(
      'BUCKET_5M_RETENTION_DAYS',
      RETENTION_DEFAULTS.fiveMinRetentionDays
    ),
    hourlyRetentionDays: env.get(
      'BUCKET_HOURLY_RETENTION_DAYS',
      RETENTION_DEFAULTS.hourlyRetentionDays
    ),
    dailyRetentionDays: env.get(
      'BUCKET_DAILY_RETENTION_DAYS',
      RETENTION_DEFAULTS.dailyRetentionDays
    ),
    wifiSnapshotRetentionDays: env.get(
      'WIFI_SNAPSHOT_RETENTION_DAYS',
      RETENTION_DEFAULTS.wifiSnapshotRetentionDays
    ),
    wifiEventRetentionDays: env.get(
      'WIFI_EVENT_RETENTION_DAYS',
      RETENTION_DEFAULTS.wifiEventRetentionDays
    ),
    peerHourlyRetentionDays: env.get(
      'PEER_HOURLY_RETENTION_DAYS',
      RETENTION_DEFAULTS.peerHourlyRetentionDays
    ),
    serviceHourlyRetentionDays: env.get(
      'SERVICE_HOURLY_RETENTION_DAYS',
      RETENTION_DEFAULTS.serviceHourlyRetentionDays
    ),
    service5mRetentionDays: env.get(
      'SERVICE_5M_RETENTION_DAYS',
      RETENTION_DEFAULTS.service5mRetentionDays
    ),
    routerSampleRetentionDays: env.get(
      'ROUTER_SAMPLE_RETENTION_DAYS',
      RETENTION_DEFAULTS.routerSampleRetentionDays
    ),
    destinationHourlyRetentionDays: env.get(
      'DESTINATION_HOURLY_RETENTION_DAYS',
      RETENTION_DEFAULTS.destinationHourlyRetentionDays
    ),
  }
}

export type PruneTableResult = { table: string; deleted: number }
export type PruneResult = { cutoff: string; tables: PruneTableResult[] }

export type PruneOptions = {
  now?: DateTime
  dryRun?: boolean
  batchSize?: number
  fiveMinRetentionDays?: number
  hourlyRetentionDays?: number
  dailyRetentionDays?: number
  wifiSnapshotRetentionDays?: number
  wifiEventRetentionDays?: number
  peerHourlyRetentionDays?: number
  serviceHourlyRetentionDays?: number
  service5mRetentionDays?: number
  routerSampleRetentionDays?: number
  destinationHourlyRetentionDays?: number
}

function atLeastOne(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) >= 1 ? (value as number) : fallback
}

export type BucketTierRetention = {
  nativeDays: number
  fiveMinDays: number
  hourlyDays: number
  dailyDays: number
}

/**
 * Effective retention of the four device bucket tiers: each coarser tier
 * lives at least as long as the finer tier below it. Shared with
 * `collectors:merge`, which may only rebuild a rollup slot from the tier
 * below while that tier still holds every row of the slot.
 */
export function bucketTierRetentionDays(
  nativeDays: number,
  options: Pick<
    PruneOptions,
    'fiveMinRetentionDays' | 'hourlyRetentionDays' | 'dailyRetentionDays'
  > = {}
): BucketTierRetention {
  const fiveMinDays = Math.max(
    nativeDays,
    atLeastOne(options.fiveMinRetentionDays, RETENTION_DEFAULTS.fiveMinRetentionDays)
  )
  const hourlyDays = Math.max(
    fiveMinDays,
    atLeastOne(options.hourlyRetentionDays, RETENTION_DEFAULTS.hourlyRetentionDays)
  )
  const dailyDays = Math.max(
    hourlyDays,
    atLeastOne(options.dailyRetentionDays, RETENTION_DEFAULTS.dailyRetentionDays)
  )
  return { nativeDays, fiveMinDays, hourlyDays, dailyDays }
}

/**
 * Delete rows past each tier's retention horizon. Returns per-table counts.
 * With `dryRun`, counts what *would* be deleted without touching anything.
 *
 * Safety: a non-positive `retentionDays` would compute a cutoff at/after now
 * and wipe everything, so this throws rather than silently delete the world.
 */
export async function pruneOldBuckets(
  retentionDays: number,
  options: PruneOptions = {}
): Promise<PruneResult> {
  if (!Number.isFinite(retentionDays) || retentionDays < 1) {
    throw new Error(`pruneOldBuckets: retentionDays must be >= 1, got ${retentionDays}`)
  }

  const now = options.now ?? DateTime.utc()
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH))
  const dryRun = options.dryRun ?? false

  const { nativeDays, fiveMinDays, hourlyDays, dailyDays } = bucketTierRetentionDays(
    retentionDays,
    options
  )
  const wifiSnapshotDays = atLeastOne(
    options.wifiSnapshotRetentionDays,
    RETENTION_DEFAULTS.wifiSnapshotRetentionDays
  )
  const wifiEventDays = atLeastOne(
    options.wifiEventRetentionDays,
    RETENTION_DEFAULTS.wifiEventRetentionDays
  )
  const peerHourlyDays = atLeastOne(
    options.peerHourlyRetentionDays,
    RETENTION_DEFAULTS.peerHourlyRetentionDays
  )
  const serviceHourlyDays = atLeastOne(
    options.serviceHourlyRetentionDays,
    RETENTION_DEFAULTS.serviceHourlyRetentionDays
  )
  const service5mDays = atLeastOne(
    options.service5mRetentionDays,
    RETENTION_DEFAULTS.service5mRetentionDays
  )
  const routerSampleDays = atLeastOne(
    options.routerSampleRetentionDays,
    RETENTION_DEFAULTS.routerSampleRetentionDays
  )
  const destinationHourlyDays = atLeastOne(
    options.destinationHourlyRetentionDays,
    RETENTION_DEFAULTS.destinationHourlyRetentionDays
  )

  const cutoffFor = (days: number) => now.minus({ days }).toUTC().toFormat('yyyy-MM-dd HH:mm:ss')

  const groups: Array<{ tables: readonly string[]; timeColumn: string; cutoff: string }> = [
    { tables: NATIVE_TABLES, timeColumn: 'bucket_start', cutoff: cutoffFor(nativeDays) },
    {
      tables: WIFI_SNAPSHOT_TABLES,
      timeColumn: 'recorded_at',
      cutoff: cutoffFor(wifiSnapshotDays),
    },
    // A station nobody has seen inside the snapshot horizon is no longer
    // "current"; drop its latest row so the client list matches history.
    {
      tables: ['wifi_station_latest'],
      timeColumn: 'recorded_at',
      cutoff: cutoffFor(wifiSnapshotDays),
    },
    {
      tables: ['wifi_roaming_events'],
      timeColumn: 'detected_at',
      cutoff: cutoffFor(wifiEventDays),
    },
    {
      tables: ['device_peer_buckets_hourly'],
      timeColumn: 'hour_start',
      cutoff: cutoffFor(peerHourlyDays),
    },
    {
      tables: ['device_service_buckets_hourly'],
      timeColumn: 'hour_start',
      cutoff: cutoffFor(serviceHourlyDays),
    },
    {
      tables: ['device_service_buckets_5m'],
      timeColumn: 'slot_start',
      cutoff: cutoffFor(service5mDays),
    },
    { tables: ['router_samples'], timeColumn: 'recorded_at', cutoff: cutoffFor(routerSampleDays) },
    {
      tables: ['device_destination_buckets_hourly'],
      timeColumn: 'hour_start',
      cutoff: cutoffFor(destinationHourlyDays),
    },
    { tables: FIVE_MIN_TABLES, timeColumn: 'slot_start', cutoff: cutoffFor(fiveMinDays) },
    { tables: HOURLY_TABLES, timeColumn: 'hour_start', cutoff: cutoffFor(hourlyDays) },
    { tables: DAILY_TABLES, timeColumn: 'day_start', cutoff: cutoffFor(dailyDays) },
  ]

  const tables: PruneTableResult[] = []
  for (const group of groups) {
    for (const table of group.tables) {
      const deleted = await pruneTable(table, group.timeColumn, group.cutoff, batchSize, dryRun)
      tables.push({ table, deleted })
    }
  }

  // The native cutoff is the headline (the fine-grained window the operator set).
  return { cutoff: cutoffFor(nativeDays), tables }
}

/**
 * Prune (or, on `dryRun`, count) rows of one table older than `cutoff`,
 * batched. Even if the driver ignores LIMIT on DELETE this terminates: the
 * first pass deletes everything and the next returns 0 (< batchSize).
 */
async function pruneTable(
  table: string,
  timeColumn: string,
  cutoff: string,
  batchSize: number,
  dryRun: boolean
): Promise<number> {
  if (dryRun) {
    const rows = await db.from(table).where(timeColumn, '<', cutoff).count('* as total')
    return firstCount(rows)
  }

  let deleted = 0
  for (;;) {
    const affected = await db.from(table).where(timeColumn, '<', cutoff).limit(batchSize).delete()
    const n = Number(Array.isArray(affected) ? affected[0] : affected) || 0
    deleted += n
    if (n < batchSize) break
  }
  return deleted
}

/** First aggregate value out of a `count('* as total')` result row. */
function firstCount(rows: Array<Record<string, unknown>>): number {
  const row = rows[0]
  if (!row) return 0
  const value = (row as { total?: unknown }).total ?? Object.values(row)[0]
  return Number(value ?? 0)
}
