import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

export type DeviceIdentityInput = {
  mac: string
  ips?: string[]
  firstSeen?: string | null
  lastSeen?: string | null
}

function normalizeIps(ips: string[] | undefined): string[] {
  return [...new Set((ips ?? []).map((ip) => ip.trim()).filter(Boolean))].sort()
}

function parseTimestamp(value: string | null | undefined, fallback: DateTime): string {
  if (!value) return fallback.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')

  const parsed = DateTime.fromISO(value, { setZone: true })
  if (!parsed.isValid) return fallback.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')

  return parsed.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
}

export async function upsertDeviceIdentities(
  collectorId: number,
  devices: DeviceIdentityInput[],
  now: DateTime = DateTime.utc()
): Promise<number> {
  if (devices.length === 0) return 0

  const nowSql = now.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
  const rows = devices.map((device) => {
    const ips = normalizeIps(device.ips)

    return {
      collector_id: collectorId,
      mac: device.mac,
      primary_ip: ips[0] ?? null,
      ips: JSON.stringify(ips),
      first_seen_at: parseTimestamp(device.firstSeen, now),
      last_seen_at: parseTimestamp(device.lastSeen, now),
      created_at: nowSql,
      updated_at: nowSql,
    }
  })

  await db
    .insertQuery()
    .table('device_identities')
    .multiInsert(rows)
    .onConflict(['collector_id', 'mac'])
    .merge({
      primary_ip: db.raw('VALUES(??)', ['primary_ip']),
      ips: db.raw('VALUES(??)', ['ips']),
      last_seen_at: db.raw('VALUES(??)', ['last_seen_at']),
      updated_at: nowSql,
    })

  return rows.length
}
