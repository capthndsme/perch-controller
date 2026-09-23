import { getDeviceLabel, getDeviceLabels } from '#services/device_labels'
import {
  devicePresence,
  stationConnectedSql,
  stationHeardAgoSql,
  type DeviceOnMap,
  type DevicePresence,
  type PresenceThresholds,
} from '#services/wifi_presence'
import db from '@adonisjs/lucid/services/db'

/**
 * The database side of `devicePresence` (`wifi_presence.ts`): the inputs the
 * device views and the infrastructure view decide "connected right now" from.
 * Every age is computed by the database against `UTC_TIMESTAMP()` and turned
 * into an instant here, so the result does not depend on the process zone.
 *
 * Where the network map puts a device (`DeviceOnMap`) comes from the caller:
 * `loadDeviceAttachments` in `infra_topology.ts`, or the infrastructure view's
 * own rows. It is a required argument so that no caller can forget it.
 */

export type WifiContextRow = {
  mac: string
  apId: number
  apName: string
  ssid: string | null
  band: string | null
  signalDbm: number | null
  snrDb: number | null
  txRateKbps: number | null
  rxRateKbps: number | null
  inactiveMs: number | null
  /** Connected right now (`wifi_presence.ts`); otherwise the AP it was last on. */
  connected: boolean
  /** When its AP last heard from it, epoch ms. */
  heardAt: number
}

function rawRows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result[0] : result) as T[]
}

/**
 * Wi-Fi context of these devices: the AP each one is connected to, or for one
 * that is not (it left, or its AP stopped reporting) the AP it was last heard
 * on. The latest table keeps that for the snapshot retention (14 d).
 */
export async function queryLatestWifiContext(
  macs: string[],
  thresholds: PresenceThresholds
): Promise<Map<string, WifiContextRow>> {
  const normalized = [...new Set(macs.map((mac) => mac.toLowerCase()))]
  if (normalized.length === 0) return new Map()

  const placeholders = normalized.map(() => '?').join(', ')
  const sql = `
    SELECT
      s.mac                                  AS mac,
      s.ap_id                                AS apId,
      COALESCE(ap.friendly_name, ap.name)    AS apName,
      s.ssid                                 AS ssid,
      s.band                                 AS band,
      s.signal_dbm                           AS signalDbm,
      s.snr_db                               AS snrDb,
      s.tx_rate_kbps                         AS txRateKbps,
      s.rx_rate_kbps                         AS rxRateKbps,
      s.inactive_ms                          AS inactiveMs,
      ${stationConnectedSql(thresholds, 's', 'ap')} AS connected,
      ${stationHeardAgoSql('s')}             AS heardAgoSeconds
    FROM wifi_station_latest s
    INNER JOIN wifi_access_points ap ON ap.id = s.ap_id
    WHERE s.mac IN (${placeholders})
  `

  const rows = rawRows<
    Omit<WifiContextRow, 'connected' | 'heardAt'> & {
      connected: unknown
      heardAgoSeconds: number | string
    }
  >(await db.rawQuery(sql, normalized))
  const now = Date.now()
  const byMac = new Map<string, WifiContextRow>()
  for (const { heardAgoSeconds, ...row } of rows) {
    byMac.set(row.mac.toLowerCase(), {
      ...row,
      connected: Number(row.connected) === 1,
      heardAt: now - Number(heardAgoSeconds) * 1000,
    })
  }
  return byMac
}

/**
 * Presence of one device, whichever collector saw it: its Wi-Fi row, its most
 * recent traffic, its Ethernet mark and where the map puts it (`onMap`, null
 * when no node carries it). The database computes the age of that traffic.
 * `thresholds`: the request's Settings → Presence.
 */
export async function queryDevicePresence(
  mac: string,
  thresholds: PresenceThresholds,
  onMap: DeviceOnMap | null
): Promise<DevicePresence> {
  const [wifiByMac, trafficSeenAt, label] = await Promise.all([
    queryLatestWifiContext([mac], thresholds),
    queryTrafficSeenAt([mac]),
    getDeviceLabel(mac),
  ])
  const wifi = wifiByMac.get(mac.toLowerCase())
  const seen = [...trafficSeenAt.values()]
  return devicePresence(
    {
      wifi: wifi ? { connected: wifi.connected, heardAt: wifi.heardAt } : null,
      trafficAt: seen.length > 0 ? Math.max(...seen) : null,
      ethernet: label?.connection === 'ethernet',
      onMap,
    },
    thresholds
  )
}

/**
 * `queryDevicePresence` for many devices at once: one query each for the
 * Wi-Fi rows and the traffic times, one cached label read. Keyed by lowercase
 * MAC; every requested MAC gets an answer (a device never seen reads
 * disconnected). `onMap` is keyed by lowercase MAC too; a MAC it lacks is not
 * on the map.
 */
export async function queryDevicePresences(
  macs: string[],
  thresholds: PresenceThresholds,
  onMap: ReadonlyMap<string, DeviceOnMap>
): Promise<Map<string, DevicePresence>> {
  const normalized = [...new Set(macs.map((mac) => mac.toLowerCase()))]
  const out = new Map<string, DevicePresence>()
  if (normalized.length === 0) return out

  const [wifiByMac, trafficSeenAt, labels] = await Promise.all([
    queryLatestWifiContext(normalized, thresholds),
    queryTrafficSeenAt(normalized),
    getDeviceLabels(normalized),
  ])
  // Most recent traffic per MAC, whichever collector saw it.
  const latestTraffic = new Map<string, number>()
  for (const [key, at] of trafficSeenAt) {
    const mac = key.slice(key.indexOf(':') + 1)
    latestTraffic.set(mac, Math.max(at, latestTraffic.get(mac) ?? at))
  }
  const now = Date.now()
  for (const mac of normalized) {
    const wifi = wifiByMac.get(mac)
    out.set(
      mac,
      devicePresence(
        {
          wifi: wifi ? { connected: wifi.connected, heardAt: wifi.heardAt } : null,
          trafficAt: latestTraffic.get(mac) ?? null,
          ethernet: labels.get(mac)?.connection === 'ethernet',
          onMap: onMap.get(mac) ?? null,
        },
        thresholds,
        now
      )
    )
  }
  return out
}

/**
 * When each collector last saw these devices' traffic, epoch ms, keyed
 * `collectorId:mac`. The database computes the age; the instant is fixed here.
 */
export async function queryTrafficSeenAt(macs: string[]): Promise<Map<string, number>> {
  const normalized = [...new Set(macs.map((mac) => mac.toLowerCase()))]
  if (normalized.length === 0) return new Map()

  const placeholders = normalized.map(() => '?').join(', ')
  const rows = rawRows<{ collectorId: number; mac: string; agoSeconds: number | string | null }>(
    await db.rawQuery(
      `SELECT collector_id AS collectorId, mac,
              TIMESTAMPDIFF(SECOND, last_seen_at, UTC_TIMESTAMP()) AS agoSeconds
       FROM device_identities
       WHERE mac IN (${placeholders})`,
      normalized
    )
  )
  const now = Date.now()
  const seenAt = new Map<string, number>()
  for (const row of rows) {
    if (row.agoSeconds === null) continue
    seenAt.set(`${row.collectorId}:${row.mac.toLowerCase()}`, now - Number(row.agoSeconds) * 1000)
  }
  return seenAt
}
