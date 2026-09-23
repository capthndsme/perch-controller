import { DateTime } from 'luxon'

/**
 * Rollup tier definitions and read-side tier selection — shared by every
 * controller that reads the bucket tables (devices + wifi) and by the
 * `rollup_maintainer` that builds the tiers, so grains, span gates and table
 * names have one source of truth.
 *
 * The ladder is native (~5 s traffic / 1 m protocol) → 5 m → hourly → daily.
 * Tiers are listed **coarsest first**; a read picks the first tier whose
 * grain is no finer than the requested resolution and whose `minSpanSeconds`
 * the window clears (the gate keeps the ≤1-slot boundary approximation
 * negligible).
 */

export const FIVE_MIN_ROLLUP_SECONDS = 300
export const HOURLY_ROLLUP_SECONDS = 3600
export const DAILY_ROLLUP_SECONDS = 86400

export type RollupTier = {
  grainSeconds: number
  minSpanSeconds: number
  timeColumn: string
  trafficTable: string
  protocolTable: string
  wifiTable: string
}

export const ROLLUP_TIERS: readonly RollupTier[] = [
  {
    grainSeconds: DAILY_ROLLUP_SECONDS,
    minSpanSeconds: 30 * 86400,
    timeColumn: 'day_start',
    trafficTable: 'device_traffic_buckets_daily',
    protocolTable: 'device_protocol_buckets_daily',
    wifiTable: 'wifi_interface_buckets_daily',
  },
  {
    grainSeconds: HOURLY_ROLLUP_SECONDS,
    minSpanSeconds: 2 * 86400,
    timeColumn: 'hour_start',
    trafficTable: 'device_traffic_buckets_hourly',
    protocolTable: 'device_protocol_buckets_hourly',
    wifiTable: 'wifi_interface_buckets_hourly',
  },
  {
    grainSeconds: FIVE_MIN_ROLLUP_SECONDS,
    minSpanSeconds: 6 * 3600,
    timeColumn: 'slot_start',
    trafficTable: 'device_traffic_buckets_5m',
    protocolTable: 'device_protocol_buckets_5m',
    wifiTable: 'wifi_interface_buckets_5m',
  },
] as const

export function windowSpanSeconds(since: DateTime, until: DateTime): number {
  return Math.max(0, until.toSeconds() - since.toSeconds())
}

/**
 * Pick the coarsest rollup tier that can serve a time-series read at this
 * resolution and window. Returns `null` to keep the read on the native table
 * (finer-than-5m grains, which are only ever requested over short windows the
 * native index handles).
 */
export function pickSeriesTier(
  resolutionSeconds: number,
  since: DateTime,
  until: DateTime
): RollupTier | null {
  const span = windowSpanSeconds(since, until)
  for (const tier of ROLLUP_TIERS) {
    if (resolutionSeconds >= tier.grainSeconds && span >= tier.minSpanSeconds) {
      return tier
    }
  }
  return null
}

/**
 * Window-aggregate reads (a single SUM over the whole window — a device-list
 * "Total", a protocol/ssid breakdown) have no time grain, so they switch
 * tiers purely on window width: daily for ≥ 60 days, hourly for ≥ 2 days,
 * native otherwise. Returns `null` for native.
 */
export function pickAggregateTier(since: DateTime, until: DateTime): RollupTier | null {
  const span = windowSpanSeconds(since, until)
  if (span >= 60 * 86400) return ROLLUP_TIERS[0]
  if (span >= 2 * 86400) return ROLLUP_TIERS[1]
  return null
}

/** Backwards-compatible boolean form of `pickAggregateTier`. */
export function useHourlyForAggregate(since: DateTime, until: DateTime): boolean {
  return pickAggregateTier(since, until) !== null
}

/**
 * Start of a window-total read on rows of `grainSeconds` (hour rows, 5-minute
 * slots): the start of the row that contains `since`, so its partial period
 * counts. `hour_start >= since` left it out: a "last hour" list read only
 * the minutes since the top of the hour (nothing at all right after it).
 * The list then covers up to one grain more than asked, never less; the
 * responses name that start as `coveredFrom`.
 */
export function coveredFrom(since: DateTime, grainSeconds: number): DateTime {
  const sec = Math.floor(since.toSeconds())
  return DateTime.fromSeconds(sec - (((sec % grainSeconds) + grainSeconds) % grainSeconds), {
    zone: 'utc',
  })
}
