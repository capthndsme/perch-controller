import { alignToBucket, deltaBytesArePlausible } from '#services/bucket_writer'
import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'

export type WifiInterfaceDelta = {
  ifname: string
  ssid: string | null
  radio: string | null
  band: string | null
  bytesIn: number
  bytesOut: number
  packetsIn: number
  packetsOut: number
  errsIn: number
  errsOut: number
  dropsIn: number
  dropsOut: number
}

/** Latest-state row shapes the poller hands to `upsertWifiLatest`. */
export type WifiStationLatestInput = {
  mac: string
  ifname: string
  ssid: string | null
  radio: string | null
  channel: number | null
  frequencyMhz: number | null
  band: string | null
  signalDbm: number | null
  snrDb: number | null
  txRateKbps: number | null
  rxRateKbps: number | null
  expectedThroughputKbps: number | null
  inactiveMs: number | null
  txBytes: number | null
  rxBytes: number | null
  txPackets: number | null
  rxPackets: number | null
}

export type WifiNetworkLatestInput = {
  ifname: string
  ssid: string
  bssid: string
  radio: string
  channel: number | null
  frequencyMhz: number | null
  band: string | null
  quality: number | null
  signalDbm: number | null
  noiseDbm: number | null
  bitrateKbps: number | null
}

export type ApSystemLatestInput = {
  load1: number | null
  load5: number | null
  load15: number | null
  memTotal: number | null
  memAvailable: number | null
  conntrackEntries: number | null
  conntrackLimit: number | null
  uptimeSeconds: number | null
}

/**
 * How long a `wifi_station_latest` row may go without a refresh before any
 * AP's report is allowed to take it over, regardless of `inactive_ms`.
 */
const STALE_TAKEOVER_SECONDS = 120

/**
 * UPSERTs per-interface deltas into fixed-size AP buckets on the native table.
 * The 5 m / hourly / daily rollups are rebuilt from these rows by
 * `rollup_maintainer`; nothing fans out here any more.
 */
export async function writeWifiInterfaceBuckets(
  apId: number,
  intervalSec: number,
  pollAt: DateTime,
  deltas: WifiInterfaceDelta[]
): Promise<number> {
  const nonZero = deltas.filter(
    (delta) =>
      delta.bytesIn > 0 ||
      delta.bytesOut > 0 ||
      delta.packetsIn > 0 ||
      delta.packetsOut > 0 ||
      delta.errsIn > 0 ||
      delta.errsOut > 0 ||
      delta.dropsIn > 0 ||
      delta.dropsOut > 0
  )
  const sane = nonZero.filter((d) => {
    if (deltaBytesArePlausible(d.bytesIn, d.bytesOut)) return true
    logger.warn(
      { apId, ifname: d.ifname, bytesIn: d.bytesIn, bytesOut: d.bytesOut },
      'wifi_bucket_writer: dropping implausible delta (counter reset?)'
    )
    return false
  })
  if (sane.length === 0) return 0

  const bucketStartSql = alignToBucket(pollAt, intervalSec).toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
  const nowSql = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')

  const rows = sane.map((d) => ({
    ap_id: apId,
    ifname: d.ifname,
    bucket_start: bucketStartSql,
    ssid: d.ssid,
    radio: d.radio,
    band: d.band,
    bytes_in: d.bytesIn,
    bytes_out: d.bytesOut,
    packets_in: d.packetsIn,
    packets_out: d.packetsOut,
    errs_in: d.errsIn,
    errs_out: d.errsOut,
    drops_in: d.dropsIn,
    drops_out: d.dropsOut,
    created_at: nowSql,
    updated_at: nowSql,
  }))

  const sum = (col: string) => db.raw('?? + VALUES(??)', [col, col])
  await db
    .insertQuery()
    .table('wifi_interface_buckets')
    .multiInsert(rows)
    .onConflict(['ap_id', 'ifname', 'bucket_start'])
    .merge({
      ssid: db.raw('VALUES(??)', ['ssid']),
      radio: db.raw('VALUES(??)', ['radio']),
      band: db.raw('VALUES(??)', ['band']),
      bytes_in: sum('bytes_in'),
      bytes_out: sum('bytes_out'),
      packets_in: sum('packets_in'),
      packets_out: sum('packets_out'),
      errs_in: sum('errs_in'),
      errs_out: sum('errs_out'),
      drops_in: sum('drops_in'),
      drops_out: sum('drops_out'),
      updated_at: nowSql,
    })

  return rows.length
}

/**
 * Refresh the three "latest state" tables for one AP poll. One UPSERT per
 * table, so the WiFi pages never have to derive "latest per key" from the
 * append-only snapshot history.
 *
 * Station rows are keyed by MAC across APs. A different AP may only take over
 * a station's row when its report is fresher (lower `inactive_ms`) or the
 * existing row has not been refreshed for `STALE_TAKEOVER_SECONDS`; the same
 * AP always refreshes its own row. Two APs that both still list a client that
 * roamed between them therefore converge on the one it is actually using.
 */
export async function upsertWifiLatest(
  apId: number,
  recordedAt: DateTime,
  input: {
    networks: WifiNetworkLatestInput[]
    stations: WifiStationLatestInput[]
    system: ApSystemLatestInput | null
  }
): Promise<void> {
  const nowSql = recordedAt.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')

  if (input.networks.length > 0) {
    const cols = [
      'ssid',
      'bssid',
      'radio',
      'channel',
      'frequency_mhz',
      'band',
      'quality',
      'signal_dbm',
      'noise_dbm',
      'bitrate_kbps',
      'recorded_at',
    ]
    const merge: Record<string, unknown> = {}
    for (const col of cols) merge[col] = db.raw('VALUES(??)', [col])
    await db
      .insertQuery()
      .table('wifi_network_latest')
      .multiInsert(
        input.networks.map((n) => ({
          ap_id: apId,
          ifname: n.ifname,
          ssid: n.ssid,
          bssid: n.bssid,
          radio: n.radio,
          channel: n.channel,
          frequency_mhz: n.frequencyMhz,
          band: n.band,
          quality: n.quality,
          signal_dbm: n.signalDbm,
          noise_dbm: n.noiseDbm,
          bitrate_kbps: n.bitrateKbps,
          recorded_at: nowSql,
        }))
      )
      .onConflict(['ap_id', 'ifname'])
      .merge(merge)
  }

  // One row per MAC: if the AP reports the same client on two interfaces
  // (mid-roam between its own radios), keep the more recently active one.
  const byMac = new Map<string, WifiStationLatestInput>()
  for (const s of input.stations) {
    const existing = byMac.get(s.mac)
    if (!existing || (s.inactiveMs ?? Infinity) < (existing.inactiveMs ?? Infinity)) {
      byMac.set(s.mac, s)
    }
  }
  if (byMac.size > 0) {
    const cols = [
      'ap_id',
      'ifname',
      'ssid',
      'radio',
      'channel',
      'frequency_mhz',
      'band',
      'signal_dbm',
      'snr_db',
      'tx_rate_kbps',
      'rx_rate_kbps',
      'expected_throughput_kbps',
      'inactive_ms',
      'tx_bytes',
      'rx_bytes',
      'tx_packets',
      'rx_packets',
      'recorded_at',
    ]
    // Take-over rule evaluated once per row via a session variable so every
    // column's IF() agrees (MySQL evaluates the assignments left to right,
    // and `ap_id` is the first column we would otherwise have overwritten).
    const merge: Record<string, unknown> = {
      ap_id: db.raw(
        `IF((@wsl_take := (ap_id = VALUES(ap_id)
            OR VALUES(inactive_ms) <= COALESCE(inactive_ms, 4294967295)
            OR recorded_at < VALUES(recorded_at) - INTERVAL ${STALE_TAKEOVER_SECONDS} SECOND)),
          VALUES(ap_id), ap_id)`
      ),
    }
    for (const col of cols.slice(1)) {
      merge[col] = db.raw('IF(@wsl_take, VALUES(??), ??)', [col, col])
    }
    await db
      .insertQuery()
      .table('wifi_station_latest')
      .multiInsert(
        [...byMac.values()].map((s) => ({
          mac: s.mac,
          ap_id: apId,
          ifname: s.ifname,
          ssid: s.ssid,
          radio: s.radio,
          channel: s.channel,
          frequency_mhz: s.frequencyMhz,
          band: s.band,
          signal_dbm: s.signalDbm,
          snr_db: s.snrDb,
          tx_rate_kbps: s.txRateKbps,
          rx_rate_kbps: s.rxRateKbps,
          expected_throughput_kbps: s.expectedThroughputKbps,
          inactive_ms: s.inactiveMs,
          tx_bytes: s.txBytes,
          rx_bytes: s.rxBytes,
          tx_packets: s.txPackets,
          rx_packets: s.rxPackets,
          recorded_at: nowSql,
        }))
      )
      .onConflict(['mac'])
      .merge(merge)
  }

  if (input.system) {
    const s = input.system
    const cols = [
      'load_1',
      'load_5',
      'load_15',
      'mem_total',
      'mem_available',
      'conntrack_entries',
      'conntrack_limit',
      'uptime_seconds',
      'recorded_at',
    ]
    const merge: Record<string, unknown> = {}
    for (const col of cols) merge[col] = db.raw('VALUES(??)', [col])
    await db
      .insertQuery()
      .table('ap_system_latest')
      .insert({
        ap_id: apId,
        load_1: s.load1,
        load_5: s.load5,
        load_15: s.load15,
        mem_total: s.memTotal,
        mem_available: s.memAvailable,
        conntrack_entries: s.conntrackEntries,
        conntrack_limit: s.conntrackLimit,
        uptime_seconds: s.uptimeSeconds,
        recorded_at: nowSql,
      })
      .onConflict(['ap_id'])
      .merge(merge)
  }
}

/**
 * Rebuild the three latest tables from the snapshot history (the same
 * statements the migration backfill runs). Used by tests that seed snapshots
 * directly and by the `wifi:rebuild-latest` maintenance path.
 */
export async function rebuildWifiLatestTables(): Promise<void> {
  await db.rawQuery(`
    INSERT INTO wifi_station_latest
      (mac, ap_id, ifname, ssid, radio, channel, frequency_mhz, band, signal_dbm, snr_db,
       tx_rate_kbps, rx_rate_kbps, expected_throughput_kbps, inactive_ms,
       tx_bytes, rx_bytes, tx_packets, rx_packets, recorded_at)
    SELECT
      s.mac, s.ap_id, s.ifname, s.ssid, s.radio, s.channel, s.frequency_mhz, s.band,
      s.signal_dbm, s.snr_db, s.tx_rate_kbps, s.rx_rate_kbps, s.expected_throughput_kbps,
      s.inactive_ms, s.tx_bytes, s.rx_bytes, s.tx_packets, s.rx_packets, s.recorded_at
    FROM wifi_station_snapshots s
    INNER JOIN (SELECT mac, MAX(id) AS max_id FROM wifi_station_snapshots GROUP BY mac) latest
      ON latest.max_id = s.id
    ON DUPLICATE KEY UPDATE
      ap_id = VALUES(ap_id), ifname = VALUES(ifname), ssid = VALUES(ssid), radio = VALUES(radio),
      channel = VALUES(channel), frequency_mhz = VALUES(frequency_mhz), band = VALUES(band),
      signal_dbm = VALUES(signal_dbm), snr_db = VALUES(snr_db), tx_rate_kbps = VALUES(tx_rate_kbps),
      rx_rate_kbps = VALUES(rx_rate_kbps),
      expected_throughput_kbps = VALUES(expected_throughput_kbps),
      inactive_ms = VALUES(inactive_ms), tx_bytes = VALUES(tx_bytes), rx_bytes = VALUES(rx_bytes),
      tx_packets = VALUES(tx_packets), rx_packets = VALUES(rx_packets),
      recorded_at = VALUES(recorded_at)
  `)

  await db.rawQuery(`
    INSERT INTO wifi_network_latest
      (ap_id, ifname, ssid, bssid, radio, channel, frequency_mhz, band, quality,
       signal_dbm, noise_dbm, bitrate_kbps, recorded_at)
    SELECT
      n.ap_id, n.ifname, n.ssid, n.bssid, n.radio, n.channel, n.frequency_mhz, n.band,
      n.quality, n.signal_dbm, n.noise_dbm, n.bitrate_kbps, n.recorded_at
    FROM wifi_network_snapshots n
    INNER JOIN (
      SELECT ap_id, ifname, MAX(id) AS max_id FROM wifi_network_snapshots GROUP BY ap_id, ifname
    ) latest ON latest.max_id = n.id
    ON DUPLICATE KEY UPDATE
      ssid = VALUES(ssid), bssid = VALUES(bssid), radio = VALUES(radio), channel = VALUES(channel),
      frequency_mhz = VALUES(frequency_mhz), band = VALUES(band), quality = VALUES(quality),
      signal_dbm = VALUES(signal_dbm), noise_dbm = VALUES(noise_dbm),
      bitrate_kbps = VALUES(bitrate_kbps), recorded_at = VALUES(recorded_at)
  `)

  await db.rawQuery(`
    INSERT INTO ap_system_latest
      (ap_id, load_1, load_5, load_15, mem_total, mem_available,
       conntrack_entries, conntrack_limit, uptime_seconds, recorded_at)
    SELECT
      s.ap_id, s.load_1, s.load_5, s.load_15, s.mem_total, s.mem_available,
      s.conntrack_entries, s.conntrack_limit, s.uptime_seconds, s.recorded_at
    FROM ap_system_snapshots s
    INNER JOIN (SELECT ap_id, MAX(id) AS max_id FROM ap_system_snapshots GROUP BY ap_id) latest
      ON latest.max_id = s.id
    ON DUPLICATE KEY UPDATE
      load_1 = VALUES(load_1), load_5 = VALUES(load_5), load_15 = VALUES(load_15),
      mem_total = VALUES(mem_total), mem_available = VALUES(mem_available),
      conntrack_entries = VALUES(conntrack_entries), conntrack_limit = VALUES(conntrack_limit),
      uptime_seconds = VALUES(uptime_seconds), recorded_at = VALUES(recorded_at)
  `)
}
