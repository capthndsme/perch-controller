import type { CollectorStatus } from '#models/collector'
import { BaseTransformer } from '@adonisjs/core/transformers'
import { DateTime } from 'luxon'

/**
 * Joined row shape for the `/api/v1/devices` index endpoint. Not a Lucid
 * model — the controller builds it from a windowed SUM over
 * `device_traffic_buckets` re-joined to the latest in-window bucket so we
 * can return *both* shapes the dashboard needs:
 *
 *   - `window*` counters: bytes/packets summed across the selected time
 *     window. Drive the "Total" column on the devices table and stay in
 *     sync with `/api/v1/protocols` (which sums the same window).
 *   - `latest*` counters: bytes from the single most recent bucket in
 *     the window. Drive the Mbps columns — they divide latest bytes by
 *     `resolutionSeconds` to surface the device's current rate, not the
 *     window-averaged rate.
 *
 * Collector context is included so the UI can disambiguate when the same
 * MAC appears under multiple collectors (e.g. a roaming laptop on two
 * LAN segments).
 *
 * `customName` / `deviceType` / `tags` / `notes` come from `device_labels` —
 * what an operator called this device, as opposed to `hostname`, which is
 * what DHCP calls it. The dashboard prefers the former when both exist.
 */
export type DeviceSummaryRow = {
  mac: string
  hostname?: string | null
  hostnameSource?: string | null
  /** Operator-supplied identity (`device_labels`), null when unnamed. */
  customName?: string | null
  deviceType?: string | null
  tags?: string[] | null
  notes?: string | null
  windowBytesIn: bigint | number
  windowBytesOut: bigint | number
  windowPacketsIn: bigint | number
  windowPacketsOut: bigint | number
  windowBytesInWan: bigint | number | null
  windowBytesOutWan: bigint | number | null
  windowBytesInLan: bigint | number | null
  windowBytesOutLan: bigint | number | null
  latestBytesIn: bigint | number
  latestBytesOut: bigint | number
  latestBytesInWan: bigint | number | null
  latestBytesOutWan: bigint | number | null
  latestBytesInLan: bigint | number | null
  latestBytesOutLan: bigint | number | null
  bucketStart: Date | string
  resolutionSeconds: number
  primaryIp: string | null
  ips: string | null
  identityLastSeenAt: Date | string | null
  collectorId: number
  collectorName: string
  collectorLastStatus: string | null
  wifiApId?: number | null
  wifiApName?: string | null
  wifiSsid?: string | null
  wifiBand?: string | null
  wifiSignalDbm?: number | null
  wifiSignalQuality?: string | null
  wifiSnrDb?: number | null
  wifiTxRateKbps?: number | null
  wifiRxRateKbps?: number | null
  wifiInactiveMs?: number | null
  wifiRecordedAt?: Date | string | null
}

/**
 * Coerces a counter column to a JSON-safe `number`. mysql2 returns either
 * `number` (typical) or `bigint` (>2^53) for BIGINT UNSIGNED. The wire
 * shape must be a plain number because JSON.stringify doesn't know how to
 * serialise bigint — losing precision past 2^53 is theoretical for 15 s
 * of LAN traffic.
 */
function toNumber(value: bigint | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') return Number(value)
  return value
}

/**
 * Best-effort JSON parse for the encrypted-at-rest `last_status` column.
 * The Collector model parses it transparently on hydration; this endpoint
 * does a raw Knex query (no model hydration), so we have to repeat the
 * parse here.
 */
function parseStatus(raw: string | null): CollectorStatus | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as CollectorStatus
  } catch {
    return null
  }
}

function parseIps(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((ip): ip is string => typeof ip === 'string') : []
  } catch {
    return []
  }
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null
  if (value instanceof Date) return DateTime.fromJSDate(value, { zone: 'utc' }).toISO()
  const sql = DateTime.fromSQL(value, { zone: 'utc' })
  if (sql.isValid) return sql.toISO()
  const iso = DateTime.fromISO(value, { setZone: true })
  return iso.isValid ? iso.toUTC().toISO() : String(value)
}

export default class DeviceSummaryTransformer extends BaseTransformer<DeviceSummaryRow> {
  toObject() {
    const windowBytesIn = toNumber(this.resource.windowBytesIn)
    const windowBytesOut = toNumber(this.resource.windowBytesOut)
    const windowBytesInWan = toNumber(this.resource.windowBytesInWan)
    const windowBytesOutWan = toNumber(this.resource.windowBytesOutWan)
    const windowBytesInLan = toNumber(this.resource.windowBytesInLan)
    const windowBytesOutLan = toNumber(this.resource.windowBytesOutLan)
    const latestBytesIn = toNumber(this.resource.latestBytesIn)
    const latestBytesOut = toNumber(this.resource.latestBytesOut)
    const latestBytesInWan = toNumber(this.resource.latestBytesInWan)
    const latestBytesOutWan = toNumber(this.resource.latestBytesOutWan)
    const latestBytesInLan = toNumber(this.resource.latestBytesInLan)
    const latestBytesOutLan = toNumber(this.resource.latestBytesOutLan)
    const resolutionSeconds = Number(this.resource.resolutionSeconds ?? 15)
    // Mbps columns express "current rate" — they divide the latest
    // bucket's bytes by the poll interval. The byte columns themselves
    // express "windowed total" so the UI can render both a live rate
    // and a total over the selected range from one response.
    const bitsPerSec = (bytes: number) => (bytes * 8) / resolutionSeconds / 1_000_000

    return {
      mac: this.resource.mac,
      hostname: this.resource.hostname ?? null,
      hostnameSource: this.resource.hostnameSource ?? null,
      customName: this.resource.customName ?? null,
      deviceType: this.resource.deviceType ?? null,
      tags: this.resource.tags ?? [],
      notes: this.resource.notes ?? null,
      primaryIp: this.resource.primaryIp,
      ips: parseIps(this.resource.ips),
      bytesIn: windowBytesIn,
      bytesOut: windowBytesOut,
      bytesInWan: windowBytesInWan,
      bytesOutWan: windowBytesOutWan,
      bytesInLan: windowBytesInLan,
      bytesOutLan: windowBytesOutLan,
      packetsIn: toNumber(this.resource.windowPacketsIn),
      packetsOut: toNumber(this.resource.windowPacketsOut),
      mbpsIn: bitsPerSec(latestBytesIn),
      mbpsOut: bitsPerSec(latestBytesOut),
      mbpsInWan: bitsPerSec(latestBytesInWan),
      mbpsOutWan: bitsPerSec(latestBytesOutWan),
      mbpsInLan: bitsPerSec(latestBytesInLan),
      mbpsOutLan: bitsPerSec(latestBytesOutLan),
      resolutionSeconds,
      lastBucketStart: this.resource.bucketStart,
      lastSeenAt: this.resource.identityLastSeenAt ?? this.resource.bucketStart,
      collector: {
        id: this.resource.collectorId,
        name: this.resource.collectorName,
        lastStatus: parseStatus(this.resource.collectorLastStatus),
      },
      wifi:
        this.resource.wifiApId !== null && this.resource.wifiApId !== undefined
          ? {
              connected: true,
              apId: this.resource.wifiApId,
              ap: this.resource.wifiApName ?? 'Unknown AP',
              ssid: this.resource.wifiSsid ?? null,
              band: this.resource.wifiBand ?? null,
              signalDbm: this.resource.wifiSignalDbm ?? null,
              signalQuality: this.resource.wifiSignalQuality ?? null,
              snrDb: this.resource.wifiSnrDb ?? null,
              txRateKbps: this.resource.wifiTxRateKbps ?? null,
              rxRateKbps: this.resource.wifiRxRateKbps ?? null,
              inactiveMs: this.resource.wifiInactiveMs ?? null,
              lastSeenAt: toIso(this.resource.wifiRecordedAt),
            }
          : {
              connected: false,
            },
    }
  }
}
