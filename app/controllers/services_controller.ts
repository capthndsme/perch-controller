import { getChartSettings } from '#services/chart_settings'
import { parseBucketLabel } from '#services/series_buckets'
import {
  queryDeviceServices,
  queryServiceTraffic,
  queryServicesSummary,
  serviceHistoryExistsForMac,
} from '#services/service_history'
import { resolveTimeWindow } from '#services/time_window'
import { serviceTrafficQueryValidator, servicesQueryValidator } from '#validators/devices'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * "How many GB did my servers push": bytes served per TLS SNI / HTTP Host /
 * QUIC SNI, attributed to the local device that was the server of the flow.
 */
export default class ServicesController {
  /**
   * GET /api/v1/services?range=…|from&to&limit?=25&collectorId?=
   *
   * Every served name across the network in the window, with the servers
   * behind each name, plus per-server totals. `limit` caps the names list
   * (servers are always complete — there are only a handful).
   */
  async index({ request, response, serialize }: HttpContext) {
    const qs = await servicesQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '24h')
    if (window.error) return response.badRequest(window.error)
    const limit = qs.limit ?? 25

    const summary = await queryServicesSummary({
      since: window.since,
      until: window.until,
      collectorId: qs.collectorId,
      limit,
    })

    return serialize({
      range: window.range,
      from: window.since.toISO(),
      to: window.until.toISO(),
      limit,
      ...summary,
    })
  }

  /**
   * GET /api/v1/devices/:mac/services?range=…&limit?=25
   *
   * The names one device served in the window. 404 when the MAC has never
   * served anything (it may still exist as a plain client).
   */
  async device({ request, params, response, serialize }: HttpContext) {
    const qs = await servicesQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '24h')
    if (window.error) return response.badRequest(window.error)
    const limit = qs.limit ?? 25

    const summary = await queryDeviceServices({
      mac: params.mac,
      since: window.since,
      until: window.until,
      collectorId: qs.collectorId,
      limit,
    })
    if (summary.services.length === 0 && !(await serviceHistoryExistsForMac(params.mac))) {
      return response.notFound({
        error: 'mac_not_found',
        message: `MAC ${params.mac} has not served any named traffic.`,
      })
    }

    return serialize({
      mac: params.mac,
      range: window.range,
      from: window.since.toISO(),
      to: window.until.toISO(),
      limit,
      ...summary,
    })
  }

  /**
   * GET /api/v1/services/:serverName/traffic?range=…|from&to&resolution?&collectorId?
   *
   * Served / received history for one name as a dense series: every bucket
   * of the window, empty ones as zero, with the seconds each covers and its
   * rate. The bucket width comes from the admin floor (Settings → Charts,
   * default 15 s) and point cap; `resolution` asks for a coarser one. Fine
   * buckets need the per-poll table (30 days), older windows use the 5-minute
   * or hourly detail (see `series_buckets.ts`).
   */
  async traffic({ request, params, response, serialize }: HttpContext) {
    const qs = await serviceTrafficQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '7d')
    if (window.error) return response.badRequest(window.error)

    const series = await queryServiceTraffic({
      serverName: params.serverName,
      since: window.since,
      until: window.until,
      collectorId: qs.collectorId,
      requestedSeconds: qs.resolution ? parseBucketLabel(qs.resolution) : undefined,
      settings: await getChartSettings(),
    })

    return serialize({
      serverName: params.serverName,
      range: window.range,
      from: window.since.toISO(),
      to: window.until.toISO(),
      resolution: series.resolution,
      resolutionSeconds: series.bucketSeconds,
      bucketSeconds: series.bucketSeconds,
      source: series.source,
      floorSeconds: series.floorSeconds,
      maxPoints: series.maxPoints,
      buckets: series.buckets,
    })
  }
}
