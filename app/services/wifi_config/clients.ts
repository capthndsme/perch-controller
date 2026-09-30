import { getPresenceSettings } from '#services/presence_settings'
import { stationConnectedSql } from '#services/wifi_presence'
import db from '@adonisjs/lucid/services/db'

/**
 * Who is connected where, for the Wi-Fi plane's views and rollouts
 * (docs/design/wifi controller.md sections 6.2 and 6.3): connected clients
 * per AP, SSID and radio, and the AP serving the requesting admin's device.
 * "Connected" is `stationConnectedSql()` (CLAUDE.md: never raw
 * `wifi_station_latest` rows).
 */

export type ConnectedStation = {
  apId: number
  mac: string
  ssid: string | null
  radio: string | null
  band: string | null
  ifname: string | null
}

function rawRows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result[0] : []) as T[]
}

/** Every connected station (optionally of some APs). */
export async function connectedStations(apIds?: number[]): Promise<ConnectedStation[]> {
  if (apIds && apIds.length === 0) return []
  const thresholds = await getPresenceSettings()
  const where = apIds ? `AND s.ap_id IN (${apIds.map(() => '?').join(',')})` : ''
  const rows = rawRows<{
    apId: number
    mac: string
    ssid: string | null
    radio: string | null
    band: string | null
    ifname: string | null
  }>(
    await db.rawQuery(
      `SELECT s.ap_id AS apId, s.mac AS mac, s.ssid AS ssid, s.radio AS radio, s.band AS band,
              s.ifname AS ifname
         FROM wifi_station_latest s
         INNER JOIN wifi_access_points ap ON ap.id = s.ap_id
        WHERE ${stationConnectedSql(thresholds, 's', 'ap')} ${where}`,
      apIds ?? []
    )
  )
  return rows.map((r) => ({ ...r, apId: Number(r.apId) }))
}

/** Connected clients on one BSS: an AP's SSID on a radio (null radio = any). */
export function countClients(
  stations: ConnectedStation[],
  where: { apId: number; ssid?: string | null; radio?: string | null }
): number {
  return stations.filter(
    (s) =>
      s.apId === where.apId &&
      (where.ssid === undefined || s.ssid === where.ssid) &&
      (where.radio === undefined ||
        where.radio === null ||
        s.radio === null ||
        s.radio === where.radio)
  ).length
}

/**
 * The requesting admin's device (controller.md 6.2 step 4): the request's
 * client address → a MAC (the gateway's DHCP mirror) → the AP listing it as
 * connected. Unknown (a proxy without TRUST_PROXY, a wired admin) → null.
 */
export async function adminDeviceOf(
  address: string | null | undefined,
  stations?: ConnectedStation[]
): Promise<{ mac: string; apId: number; ssid: string; radio: string | null } | null> {
  if (!address || !/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return null
  const hosts = rawRows<{ mac: string }>(
    await db.rawQuery(
      'SELECT mac FROM gateway_hosts WHERE ipv4 = ? ORDER BY dhcp_seen_at DESC LIMIT 1',
      [address]
    )
  )
  const mac = hosts[0]?.mac?.toLowerCase()
  if (!mac) return null
  const list = stations ?? (await connectedStations())
  const station = list.find((s) => s.mac.toLowerCase() === mac)
  if (!station) return null
  return { mac, apId: station.apId, ssid: station.ssid ?? '', radio: station.radio }
}
