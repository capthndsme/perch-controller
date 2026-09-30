import { nativeRetentionDaysFromEnv } from '#services/bucket_retention'
import type { ConditionInput, DetectorContext, ParamValue, Severity } from '#services/alerts/model'
import { registerDetector } from '#services/alerts/registry'
import { rawRows, toNumberOrNull } from '#services/alerts/detectors/liveness'
import db from '@adonisjs/lucid/services/db'
import { statfs } from 'node:fs/promises'

/**
 * Detector `system` (WP-A5a, events.md section 3.8): the controller's own
 * health, one condition per check, all on the `controller` subject.
 *
 * - `system.disk_low` (60 s): free space of the data path (`/data`, the
 *   controller's volume in the compose stack).
 * - `system.db_size` (15 min): the database's size, off until `warnGb` > 0.
 * - `system.rollup_stalled` (5 min): native buckets arrive but the newest
 *   5-minute rollup lags.
 * - `system.retention_stalled` (15 min): the oldest native bucket outlived
 *   its retention by `graceDays`.
 *
 * Each check is a separate detector so a slow `information_schema` read
 * never delays the disk check, and each has its own period.
 */

export const DISK_TYPE = 'system.disk_low'
export const DB_SIZE_TYPE = 'system.db_size'
export const ROLLUP_TYPE = 'system.rollup_stalled'
export const RETENTION_TYPE = 'system.retention_stalled'

const CONTROLLER = { kind: 'controller' } as const

function intParam(params: Record<string, ParamValue> | undefined, key: string, fallback: number) {
  const value = params?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

// ── disk ───────────────────────────────────────────────────────────────────

export type DiskReading = { freeBytes: number; totalBytes: number; freePercent: number }

type StatfsFn = (
  path: string
) => Promise<{ bavail: number | bigint; blocks: number | bigint; bsize: number | bigint }>
let statfsImpl: StatfsFn = (path) => statfs(path)

/** Tests only: replace `fs.statfs` (null restores it). */
export function _setStatfsForTesting(fn: StatfsFn | null): void {
  statfsImpl = fn ?? ((path) => statfs(path))
}

export async function readDisk(path: string): Promise<DiskReading | null> {
  try {
    const s = await statfsImpl(path)
    const bsize = Number(s.bsize)
    const blocks = Number(s.blocks)
    const bavail = Number(s.bavail)
    if (!(blocks > 0) || !(bsize > 0)) return null
    return {
      freeBytes: bavail * bsize,
      totalBytes: blocks * bsize,
      freePercent: (bavail / blocks) * 100,
    }
  } catch {
    // No such path (a controller outside the compose stack): not evaluated.
    return null
  }
}

/** The severity the disk condition holds with, or null when there is enough room. */
export function diskSeverity(
  freePercent: number,
  params: { warnPercentFree: number; criticalPercentFree: number }
): Severity | null {
  if (freePercent < params.criticalPercentFree) return 'critical'
  if (freePercent < params.warnPercentFree) return 'warning'
  return null
}

export function diskPath(params: Record<string, ParamValue> | undefined): string {
  const value = params?.path
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' && first.startsWith('/') ? first : '/data'
}

export async function runDiskCheck(ctx: DetectorContext): Promise<void> {
  const params = ctx.rule(DISK_TYPE).params
  const path = diskPath(params)
  const reading = await readDisk(path)
  if (!reading) return
  const severity = diskSeverity(reading.freePercent, {
    warnPercentFree: intParam(params, 'warnPercentFree', 10),
    criticalPercentFree: intParam(params, 'criticalPercentFree', 3),
  })
  await ctx.reconcile(
    [DISK_TYPE],
    severity
      ? [
          {
            type: DISK_TYPE,
            subject: CONTROLLER,
            dedupeKey: `${DISK_TYPE}:controller`,
            severity,
            source: 'detector:system',
            payload: {
              path,
              freeBytes: reading.freeBytes,
              totalBytes: reading.totalBytes,
              freePercent: Math.round(reading.freePercent * 10) / 10,
            },
          },
        ]
      : []
  )
}

// ── database size ──────────────────────────────────────────────────────────

export const BYTES_PER_GB = 1e9

export async function readDatabaseBytes(): Promise<number> {
  const rows = rawRows<{ bytes: number | string | null }>(
    await db.rawQuery(
      `SELECT SUM(data_length + index_length) AS bytes
         FROM information_schema.tables WHERE table_schema = DATABASE()`
    )
  )
  return Number(rows[0]?.bytes ?? 0)
}

export async function runDbSizeCheck(ctx: DetectorContext): Promise<void> {
  const warnGb = intParam(ctx.rule(DB_SIZE_TYPE).params, 'warnGb', 0)
  const current: ConditionInput[] = []
  // Off until the admin sets a threshold: nothing to hold, so anything live clears.
  if (warnGb > 0) {
    const bytes = await readDatabaseBytes()
    if (bytes > warnGb * BYTES_PER_GB) {
      current.push({
        type: DB_SIZE_TYPE,
        subject: CONTROLLER,
        dedupeKey: `${DB_SIZE_TYPE}:controller`,
        source: 'detector:system',
        payload: { sizeBytes: bytes, warnGb },
      })
    }
  }
  await ctx.reconcile([DB_SIZE_TYPE], current)
}

// ── rollups ────────────────────────────────────────────────────────────────

/** Native data counts as arriving while its newest bucket is younger than this. */
export const ARRIVING_MINUTES = 10

export type RollupAges = {
  /** Minutes since the newest native bucket started; null when there is none. */
  nativeAgeMinutes: number | null
  /** Minutes since the newest 5-minute slot started; null when there is none. */
  rollupAgeMinutes: number | null
}

/** Data is arriving but the 5-minute tier lags by more than `lagMinutes` (or has nothing). */
export function rollupStalled(ages: RollupAges, lagMinutes: number): boolean {
  if (ages.nativeAgeMinutes === null || ages.nativeAgeMinutes >= ARRIVING_MINUTES) return false
  return ages.rollupAgeMinutes === null || ages.rollupAgeMinutes > lagMinutes
}

export async function readRollupAges(): Promise<RollupAges> {
  // MAX over the indexed time columns (`*_time_idx`): an index read each.
  const [native, fiveMin] = await Promise.all([
    db.rawQuery(
      `SELECT TIMESTAMPDIFF(SECOND, MAX(bucket_start), UTC_TIMESTAMP()) AS age
         FROM device_traffic_buckets`
    ),
    db.rawQuery(
      `SELECT TIMESTAMPDIFF(SECOND, MAX(slot_start), UTC_TIMESTAMP()) AS age
         FROM device_traffic_buckets_5m`
    ),
  ])
  const minutes = (result: unknown) => {
    const seconds = toNumberOrNull(rawRows<{ age: unknown }>(result)[0]?.age)
    return seconds === null ? null : seconds / 60
  }
  return { nativeAgeMinutes: minutes(native), rollupAgeMinutes: minutes(fiveMin) }
}

export async function runRollupCheck(ctx: DetectorContext): Promise<void> {
  const lagMinutes = intParam(ctx.rule(ROLLUP_TYPE).params, 'lagMinutes', 30)
  const ages = await readRollupAges()
  await ctx.reconcile(
    [ROLLUP_TYPE],
    rollupStalled(ages, lagMinutes)
      ? [
          {
            type: ROLLUP_TYPE,
            subject: CONTROLLER,
            dedupeKey: `${ROLLUP_TYPE}:controller`,
            source: 'detector:system',
            payload: {
              ageMinutes: ages.rollupAgeMinutes === null ? null : Math.round(ages.rollupAgeMinutes),
              nativeAgeMinutes: Math.round(ages.nativeAgeMinutes ?? 0),
              lagMinutes,
            },
          },
        ]
      : []
  )
}

// ── retention ──────────────────────────────────────────────────────────────

/** The oldest native bucket outlived retention + grace. Retention < 1 = pruning off: never. */
export function retentionStalled(
  oldestAgeDays: number | null,
  retentionDays: number,
  graceDays: number
): boolean {
  if (retentionDays < 1 || oldestAgeDays === null) return false
  return oldestAgeDays > retentionDays + graceDays
}

export async function readOldestNativeAgeDays(): Promise<number | null> {
  const rows = rawRows<{ age: unknown }>(
    await db.rawQuery(
      `SELECT TIMESTAMPDIFF(SECOND, MIN(bucket_start), UTC_TIMESTAMP()) AS age
         FROM device_traffic_buckets`
    )
  )
  const seconds = toNumberOrNull(rows[0]?.age)
  return seconds === null ? null : seconds / 86_400
}

export async function runRetentionCheck(ctx: DetectorContext): Promise<void> {
  const retentionDays = nativeRetentionDaysFromEnv()
  const graceDays = intParam(ctx.rule(RETENTION_TYPE).params, 'graceDays', 2)
  const oldest = retentionDays >= 1 ? await readOldestNativeAgeDays() : null
  await ctx.reconcile(
    [RETENTION_TYPE],
    retentionStalled(oldest, retentionDays, graceDays)
      ? [
          {
            type: RETENTION_TYPE,
            subject: CONTROLLER,
            dedupeKey: `${RETENTION_TYPE}:controller`,
            source: 'detector:system',
            payload: {
              oldestDays: Math.floor(oldest ?? 0),
              retentionDays,
              graceDays,
            },
          },
        ]
      : []
  )
}

registerDetector({ id: 'system.disk', everySeconds: 60, types: [DISK_TYPE], run: runDiskCheck })
registerDetector({
  id: 'system.db_size',
  everySeconds: 900,
  types: [DB_SIZE_TYPE],
  run: runDbSizeCheck,
})
registerDetector({
  id: 'system.rollup',
  everySeconds: 300,
  types: [ROLLUP_TYPE],
  run: runRollupCheck,
})
registerDetector({
  id: 'system.retention',
  everySeconds: 900,
  types: [RETENTION_TYPE],
  run: runRetentionCheck,
})
