#!/usr/bin/env node
/**
 * import_vnstat.ts
 *
 * One-shot script that pulls vnstat2 historical WAN traffic data from
 * the router's LXC container and backfills it into the native
 * `device_traffic_buckets` table so it shows up in the existing
 * bandwidth charts.
 *
 * Strategy:
 *   - Monthly buckets (Sep 2024 → month before daily data starts)
 *     → one row per month, bucket_start = 1st of month 00:00 UTC
 *   - Daily buckets (from the earliest day vnstat has daily data for,
 *     up to but NOT overlapping with existing native data)
 *     → one row per day, bucket_start = midnight UTC of that day
 *   - Hourly/5min: skipped — too recent, already covered by native
 *     collector
 *
 * vnstat semantics:
 *   rx = bytes received on the WAN interface = download = bytes_in
 *   tx = bytes transmitted on the WAN interface = upload = bytes_out
 *
 * All imported rows use:
 *   - collector_id = 1  (the single localhost collector)
 *   - mac = the gateway's WAN interface MAC (VNSTAT_WAN_MAC)
 *   - vnstat runs as `lxc exec $VNSTAT_LXC_CONTAINER -- vnstat -i $VNSTAT_INTERFACE`
 *     (defaults: openwrt, wan)
 *   - bytes_in_wan / bytes_out_wan = same as bytes_in / bytes_out
 *     (all traffic on the WAN interface is WAN by definition)
 *   - LAN counters = 0
 *   - packets = 0 (vnstat doesn't track packet counts)
 *
 * Uses INSERT IGNORE to safely skip any rows that already exist.
 *
 * Run from metrics-be/ with the app's DB_* variables exported:
 *   set -a; . ./.env; set +a
 *   VNSTAT_WAN_MAC=02:00:00:00:00:04 VNSTAT_WAN_IP=192.168.0.1 npx tsx import_vnstat.ts
 */

import { execSync } from 'node:child_process'
import mysql from 'mysql2/promise'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`Missing required environment variable ${name}`)
    process.exit(1)
  }
  return value
}

// Same variables metrics-be reads from .env; nothing is hard-coded here.
const DB_CONFIG = {
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? 'root',
  password: requireEnv('DB_PASSWORD'),
  database: requireEnv('DB_DATABASE'),
}

const COLLECTOR_ID = Number(process.env.VNSTAT_COLLECTOR_ID ?? 1)
const LXC_CONTAINER = process.env.VNSTAT_LXC_CONTAINER ?? 'openwrt'
const VNSTAT_INTERFACE = process.env.VNSTAT_INTERFACE ?? 'wan'
/** MAC the imported rows are attributed to: the gateway's WAN interface. */
const WAN_MAC = requireEnv('VNSTAT_WAN_MAC')
/** Address recorded on that MAC's device identity (the gateway's LAN IP). */
const WAN_IP = requireEnv('VNSTAT_WAN_IP')

// ─── vnstat JSON types ──────────────────────────────────────────────

interface VnstatDate {
  year: number
  month: number
  day?: number
}

interface VnstatTime {
  hour: number
  minute: number
}

interface VnstatTrafficEntry {
  id: number
  date: VnstatDate
  time?: VnstatTime
  timestamp: number
  rx: number
  tx: number
}

interface VnstatResponse {
  vnstatversion: string
  jsonversion: string
  interfaces: Array<{
    name: string
    traffic: {
      total: { rx: number; tx: number }
      month?: VnstatTrafficEntry[]
      day?: VnstatTrafficEntry[]
      hour?: VnstatTrafficEntry[]
      fiveminute?: VnstatTrafficEntry[]
    }
  }>
}

// ─── helpers ────────────────────────────────────────────────────────

function queryVnstat(granularity: string, limit: number = 0): VnstatResponse {
  const flagMap: Record<string, string> = {
    month: 'm',
    day: 'd',
    hour: 'h',
    fiveminute: 'f',
    year: 'y',
  }
  const flag = flagMap[granularity]
  if (!flag) throw new Error(`Unknown granularity: ${granularity}`)

  const cmd = `lxc exec ${LXC_CONTAINER} -- vnstat -i ${VNSTAT_INTERFACE} --json ${flag} ${limit}`
  const output = execSync(cmd, { timeout: 30000, encoding: 'utf8' })
  return JSON.parse(output)
}

/**
 * Convert a vnstat date to a MySQL DATETIME string in UTC.
 * Monthly entries don't have a day field, so we use the 1st.
 */
function toBucketStart(entry: VnstatTrafficEntry, granularity: 'month' | 'day'): string {
  const d = entry.date
  if (granularity === 'month') {
    const mm = String(d.month).padStart(2, '0')
    return `${d.year}-${mm}-01 00:00:00`
  }
  const mm = String(d.month).padStart(2, '0')
  const dd = String(d.day ?? 1).padStart(2, '0')
  return `${d.year}-${mm}-${dd} 00:00:00`
}

// ─── main ───────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════╗')
  console.log('║  vnstat2 → device_traffic_buckets backfill       ║')
  console.log('╚══════════════════════════════════════════════════╝')
  console.log()

  // 1. Find the earliest existing native data
  const conn = await mysql.createConnection(DB_CONFIG)
  const [existingRows] = (await conn.query(
    'SELECT MIN(bucket_start) AS earliest FROM device_traffic_buckets'
  )) as any[]
  const existingEarliest: string | null = existingRows[0]?.earliest
    ? new Date(existingRows[0].earliest).toISOString()
    : null

  console.log(`Existing data starts at: ${existingEarliest ?? '(empty table)'}`)
  console.log(`Collector ID: ${COLLECTOR_ID}`)
  console.log(`WAN MAC: ${WAN_MAC}`)
  console.log()

  // Cutoff: only insert rows BEFORE existing data
  const cutoffDate = existingEarliest ? new Date(existingRows[0].earliest) : new Date() // if table is empty, import everything up to now

  // 2. Pull monthly data from vnstat
  console.log('── Fetching monthly data from vnstat ──')
  const monthlyData = queryVnstat('month', 0)
  const months = monthlyData.interfaces[0].traffic.month ?? []
  console.log(`  Got ${months.length} monthly records`)

  // 3. Pull daily data from vnstat
  console.log('── Fetching daily data from vnstat ──')
  const dailyData = queryVnstat('day', 0)
  const days = dailyData.interfaces[0].traffic.day ?? []
  console.log(`  Got ${days.length} daily records`)

  // 4. Build the set of daily bucket_start dates so we can subtract
  //    from monthly totals when they overlap
  const dailyBucketStarts = new Set<string>()
  for (const day of days) {
    dailyBucketStarts.add(toBucketStart(day, 'day'))
  }

  // Determine which months overlap with daily data
  const dailyMonths = new Set<string>()
  for (const day of days) {
    const mm = String(day.date.month).padStart(2, '0')
    dailyMonths.add(`${day.date.year}-${mm}`)
  }

  // 5. Prepare INSERT rows
  const insertRows: Array<{
    bucketStart: string
    bytesIn: number
    bytesOut: number
    source: string
  }> = []

  // Monthly rows: only for months that DON'T have daily breakdowns
  // For months that DO have daily data, we'll use the daily rows instead
  for (const month of months) {
    const mm = String(month.date.month).padStart(2, '0')
    const monthKey = `${month.date.year}-${mm}`
    const bucketStart = toBucketStart(month, 'month')
    const bucketDate = new Date(bucketStart)

    if (bucketDate >= cutoffDate) {
      continue // skip — this month overlaps with existing native data
    }

    if (dailyMonths.has(monthKey)) {
      continue // skip — we have daily granularity for this month
    }

    insertRows.push({
      bucketStart,
      bytesIn: month.rx,
      bytesOut: month.tx,
      source: `monthly:${monthKey}`,
    })
  }

  // Daily rows: only for days BEFORE existing data
  for (const day of days) {
    const bucketStart = toBucketStart(day, 'day')
    const bucketDate = new Date(bucketStart)

    if (bucketDate >= cutoffDate) {
      continue // skip — overlaps with existing native collection
    }

    insertRows.push({
      bucketStart,
      bytesIn: day.rx,
      bytesOut: day.tx,
      source: `daily:${day.date.year}-${String(day.date.month).padStart(2, '0')}-${String(day.date.day).padStart(2, '0')}`,
    })
  }

  // Sort by date
  insertRows.sort((a, b) => a.bucketStart.localeCompare(b.bucketStart))

  console.log()
  console.log(`── Backfill plan ──`)
  console.log(
    `  Monthly rows to insert: ${insertRows.filter((r) => r.source.startsWith('monthly')).length}`
  )
  console.log(
    `  Daily rows to insert:   ${insertRows.filter((r) => r.source.startsWith('daily')).length}`
  )
  console.log(`  Total rows to insert:   ${insertRows.length}`)
  console.log(`  Cutoff (before):        ${cutoffDate.toISOString()}`)
  console.log()

  if (insertRows.length === 0) {
    console.log('Nothing to import — all vnstat data overlaps with existing records.')
    await conn.end()
    return
  }

  // Print preview
  console.log('── Preview (first 5 / last 5) ──')
  const preview = [
    ...insertRows.slice(0, 5),
    ...(insertRows.length > 10
      ? [
          {
            bucketStart: '...',
            bytesIn: 0,
            bytesOut: 0,
            source: `... ${insertRows.length - 10} more ...`,
          },
        ]
      : []),
    ...insertRows.slice(-5),
  ]
  for (const row of preview) {
    const rxGB = (row.bytesIn / 1e9).toFixed(1)
    const txGB = (row.bytesOut / 1e9).toFixed(1)
    console.log(`  ${row.bucketStart}  rx=${rxGB} GB  tx=${txGB} GB  (${row.source})`)
  }
  console.log()

  // 6. INSERT IGNORE into device_traffic_buckets
  console.log('── Inserting into device_traffic_buckets ──')

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

  let inserted = 0
  for (const row of insertRows) {
    const sql = `
      INSERT IGNORE INTO device_traffic_buckets
        (collector_id, mac, bucket_start,
         bytes_in, bytes_out, packets_in, packets_out,
         bytes_in_wan, bytes_out_wan, packets_in_wan, packets_out_wan,
         bytes_in_lan, bytes_out_lan, packets_in_lan, packets_out_lan,
         created_at, updated_at)
      VALUES
        (?, ?, ?,
         ?, ?, 0, 0,
         ?, ?, 0, 0,
         0, 0, 0, 0,
         ?, ?)
    `
    const [result] = (await conn.query(sql, [
      COLLECTOR_ID,
      WAN_MAC,
      row.bucketStart,
      row.bytesIn,
      row.bytesOut,
      row.bytesIn, // bytes_in_wan = bytes_in (all WAN traffic)
      row.bytesOut, // bytes_out_wan = bytes_out
      now,
      now,
    ])) as any[]
    if (result.affectedRows > 0) inserted++
  }

  console.log(
    `  ✓ Inserted ${inserted} rows (${insertRows.length - inserted} skipped as duplicates)`
  )

  // 7. Also ensure a device_identity row exists for this MAC
  console.log()
  console.log('── Ensuring device identity for WAN MAC ──')
  await conn.query(
    `
    INSERT IGNORE INTO device_identities
      (collector_id, mac, primary_ip, ips, first_seen_at, last_seen_at, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    [
      COLLECTOR_ID,
      WAN_MAC,
      WAN_IP,
      JSON.stringify([WAN_IP]),
      insertRows[0].bucketStart,
      insertRows[insertRows.length - 1].bucketStart,
      now,
      now,
    ]
  )
  console.log(`  ✓ device_identity ensured`)

  // 8. Summary
  console.log()
  const [countRows] = (await conn.query(
    'SELECT COUNT(*) AS cnt, MIN(bucket_start) AS earliest, MAX(bucket_start) AS latest FROM device_traffic_buckets WHERE mac = ?',
    [WAN_MAC]
  )) as any[]
  console.log(`── Result: WAN MAC ${WAN_MAC} ──`)
  console.log(`  Total rows:  ${countRows[0].cnt}`)
  console.log(`  Earliest:    ${countRows[0].earliest}`)
  console.log(`  Latest:      ${countRows[0].latest}`)

  await conn.end()
  console.log()
  console.log('Done! vnstat data has been backfilled into the native bandwidth system.')
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
