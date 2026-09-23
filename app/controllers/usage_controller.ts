import { normalizeMac } from '#services/device_labels'
import { resolveTimeWindow } from '#services/time_window'
import {
  pickUsageInterval,
  queryUsageIntervals,
  queryUsageReport,
  type UsagePeriod,
} from '#services/usage_history'
import { usageIntervalsQueryValidator, usageQueryValidator } from '#validators/devices'
import type { HttpContext } from '@adonisjs/core/http'

/** Default look-back per period when neither `range` nor `from`/`to` is given. */
const DEFAULT_RANGE: Record<UsagePeriod, string> = {
  day: '30d',
  week: '182d',
  month: '365d',
}

/**
 * vnstat-style usage overview: bytes per local day / week / month with the
 * active-device count, Wi-Fi client avg/peak and the top protocols of each
 * bucket. See `usage_history.ts` for the alignment rules.
 *
 * `?mac=` narrows either endpoint to one device (the device page's Usage
 * card): same buckets from that MAC's rows, `activeDevices` / `wifiClients`
 * `null`, and the normalised `mac` echoed. An unknown MAC is a 200 with
 * every bucket at zero, like any quiet window.
 */
export default class UsageController {
  /**
   * GET /api/v1/usage?period=day|week|month&range=…|from&to&scope=all|wan|lan
   *                  &collectorId?=&protocols?=6&mac?=
   */
  async index({ request, response, serialize }: HttpContext) {
    const qs = await usageQueryValidator.validate(request.qs())
    const period: UsagePeriod = qs.period ?? 'day'
    const window = resolveTimeWindow(qs, DEFAULT_RANGE[period])
    if (window.error) return response.badRequest(window.error)

    const report = await queryUsageReport({
      period,
      since: window.since,
      until: window.until,
      scope: qs.scope ?? 'all',
      collectorId: qs.collectorId,
      mac: normalizeMac(qs.mac) ?? undefined,
      protocolsLimit: qs.protocols ?? 6,
    })

    return serialize({ range: window.range, ...report })
  }

  /**
   * GET /api/v1/usage/intervals?range=7d|from&to&interval=auto|1h|4h|8h|12h
   *                            &scope=all|wan|lan&collectorId?=&mac?=
   *
   * The hourly breakdown under the daily view: sub-day slots aligned to
   * local midnight, coarser as the window grows (auto: 1 h ≤ 7 d, 4 h ≤ 14 d,
   * 8 h ≤ 30 d, else 12 h).
   */
  async intervals({ request, response, serialize }: HttpContext) {
    const qs = await usageIntervalsQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '7d')
    if (window.error) return response.badRequest(window.error)
    const intervalSeconds = pickUsageInterval(qs.interval, window.since, window.until)

    const report = await queryUsageIntervals({
      since: window.since,
      until: window.until,
      scope: qs.scope ?? 'all',
      collectorId: qs.collectorId,
      mac: normalizeMac(qs.mac) ?? undefined,
      intervalSeconds,
    })

    return serialize({
      range: window.range,
      interval: `${intervalSeconds / 3600}h`,
      ...report,
    })
  }
}
