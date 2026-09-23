import SystemSetting from '#models/system_setting'
import { CONNECTED_INACTIVE_MS } from '#services/wifi_presence'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * Grains (seconds) the WiFi client-distribution rollup keeps exact distinct
 * counts for: 1m / 5m / 15m / 1h. These are the resolutions `clientsHistory`
 * routes to the rollup; finer 5s/15s grains (short windows only) stay on raw.
 */
export const CLIENT_DISTRIBUTION_GRAINS = [60, 300, 900, 3600] as const

/** Active-station threshold, shared with every "clients now" read (`wifi_presence.ts`). */
const INACTIVE_MS = CONNECTED_INACTIVE_MS

export const CLIENT_DISTRIBUTION_TABLE = 'wifi_client_distribution'
export const CLIENT_TOTALS_TABLE = 'wifi_client_totals'

/** Grain the "peak clients" tiles are computed at. */
export const PEAK_CLIENTS_GRAIN = 300

const PEAK_SETTING_KEY = 'wifi_peak_clients_all_time'

/** `system_settings` key holding the all-time peak, globally or per AP. */
export function peakClientsSettingKey(apId?: number): string {
  return apId ? `${PEAK_SETTING_KEY}_ap_${apId}` : PEAK_SETTING_KEY
}

export type PeakClients = { count: number; slotStart: string | null }

export type RecomputeResult = { grain: number; affected: number; totalsAffected: number }

function sql(ts: DateTime): string {
  return ts.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
}

/**
 * Recompute the exact distinct active-client count per (ap, band, slot) and
 * the network-wide total per slot for each grain over a window, upserting
 * into the two rollup tables. Because a distinct count over a *partial* slot
 * would undercount it, the `since` edge is floored to the coarsest grain so
 * every slot in range is fully covered; the `until` edge is the live,
 * still-filling slot (recomputed next run). Finishes by bumping the stored
 * all-time peaks.
 */
export async function recomputeClientDistribution(opts: {
  since: DateTime
  until: DateTime
  grains?: readonly number[]
}): Promise<RecomputeResult[]> {
  const grains = opts.grains ?? CLIENT_DISTRIBUTION_GRAINS
  if (grains.length === 0) return []

  // Floor `since` to the coarsest grain so no slot is partially recomputed.
  const coarsest = Math.max(...grains)
  const flooredSinceSec = Math.floor(opts.since.toSeconds() / coarsest) * coarsest
  const since = DateTime.fromSeconds(flooredSinceSec, { zone: 'utc' })
  const sinceSql = sql(since)
  const untilSql = sql(opts.until)

  const results: RecomputeResult[] = []
  for (const grain of grains) {
    const slotExpr = `DATE_SUB(s.recorded_at, INTERVAL MOD(TO_SECONDS(s.recorded_at), ${grain}) SECOND)`
    const res = await db.rawQuery(
      `
      INSERT INTO ${CLIENT_DISTRIBUTION_TABLE}
        (grain_seconds, ap_id, band, slot_start, client_count, updated_at)
      SELECT
        ?, s.ap_id, COALESCE(s.band, ''), ${slotExpr} AS slot_start,
        COUNT(DISTINCT s.mac), UTC_TIMESTAMP()
      FROM wifi_station_snapshots s
      WHERE s.recorded_at >= ? AND s.recorded_at < ? AND s.inactive_ms < ?
      GROUP BY s.ap_id, COALESCE(s.band, ''), slot_start
      ON DUPLICATE KEY UPDATE
        client_count = VALUES(client_count), updated_at = VALUES(updated_at)
    `,
      [grain, sinceSql, untilSql, INACTIVE_MS]
    )
    const totals = await db.rawQuery(
      `
      INSERT INTO ${CLIENT_TOTALS_TABLE} (grain_seconds, slot_start, client_count, updated_at)
      SELECT ?, ${slotExpr} AS slot_start, COUNT(DISTINCT s.mac), UTC_TIMESTAMP()
      FROM wifi_station_snapshots s
      WHERE s.recorded_at >= ? AND s.recorded_at < ? AND s.inactive_ms < ?
      GROUP BY slot_start
      ON DUPLICATE KEY UPDATE
        client_count = VALUES(client_count), updated_at = VALUES(updated_at)
    `,
      [grain, sinceSql, untilSql, INACTIVE_MS]
    )
    results.push({
      grain,
      affected: affectedRows(res),
      totalsAffected: affectedRows(totals),
    })
  }

  await refreshPeakClients(since, opts.until)
  return results
}

function affectedRows(res: unknown): number {
  const r = res as { affectedRows?: number } | Array<{ affectedRows?: number }>
  return Number((Array.isArray(r) ? r[0]?.affectedRows : r?.affectedRows) ?? 0)
}

/**
 * Peak concurrent clients inside a window at the peak grain: globally from
 * the exact totals series, per AP from the distribution rollup (bands summed —
 * a client is on one band at a time, so this is exact per AP).
 */
export async function queryPeakClientsInWindow(
  since: DateTime,
  until: DateTime,
  apId?: number
): Promise<PeakClients> {
  const rows = apId
    ? await db.rawQuery(
        `SELECT slot_start AS slotStart, SUM(client_count) AS count
         FROM ${CLIENT_DISTRIBUTION_TABLE}
         WHERE grain_seconds = ? AND ap_id = ? AND slot_start >= ? AND slot_start < ?
         GROUP BY slot_start ORDER BY count DESC, slot_start DESC LIMIT 1`,
        [PEAK_CLIENTS_GRAIN, apId, sql(since), sql(until)]
      )
    : await db.rawQuery(
        `SELECT slot_start AS slotStart, client_count AS count
         FROM ${CLIENT_TOTALS_TABLE}
         WHERE grain_seconds = ? AND slot_start >= ? AND slot_start < ?
         ORDER BY client_count DESC, slot_start DESC LIMIT 1`,
        [PEAK_CLIENTS_GRAIN, sql(since), sql(until)]
      )
  const row = (Array.isArray(rows) ? rows[0]?.[0] : null) as
    | { slotStart: Date | string; count: number | string }
    | null
    | undefined
  if (!row) return { count: 0, slotStart: null }
  return { count: Number(row.count), slotStart: toIso(row.slotStart) }
}

/** Stored all-time peak (global or per AP); `{0, null}` when never computed. */
export async function getAllTimePeakClients(apId?: number): Promise<PeakClients> {
  const stored = await SystemSetting.get<PeakClients>(peakClientsSettingKey(apId))
  if (!stored || typeof stored.count !== 'number') return { count: 0, slotStart: null }
  return stored
}

/**
 * Bump the stored all-time peaks (global + every AP with data in the window)
 * if the window contains a higher 5-minute count than what is stored.
 */
export async function refreshPeakClients(since: DateTime, until: DateTime): Promise<void> {
  const global = await queryPeakClientsInWindow(since, until)
  await bumpPeak(undefined, global)

  const apRows = await db.rawQuery(
    `SELECT ap_id AS apId FROM ${CLIENT_DISTRIBUTION_TABLE}
     WHERE grain_seconds = ? AND slot_start >= ? AND slot_start < ?
     GROUP BY ap_id`,
    [PEAK_CLIENTS_GRAIN, sql(since), sql(until)]
  )
  const aps = (Array.isArray(apRows) ? apRows[0] : []) as Array<{ apId: number }>
  for (const { apId } of aps) {
    await bumpPeak(apId, await queryPeakClientsInWindow(since, until, apId))
  }
}

async function bumpPeak(apId: number | undefined, candidate: PeakClients): Promise<void> {
  if (candidate.count <= 0) return
  const stored = await getAllTimePeakClients(apId)
  if (candidate.count > stored.count) {
    await SystemSetting.set(peakClientsSettingKey(apId), candidate)
  }
}

function toIso(value: Date | string): string {
  if (value instanceof Date) return DateTime.fromJSDate(value, { zone: 'utc' }).toISO()!
  const parsed = DateTime.fromSQL(value, { zone: 'utc' })
  return parsed.isValid ? parsed.toISO()! : String(value)
}
