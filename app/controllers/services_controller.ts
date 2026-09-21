import {
  pickServiceResolution,
  queryDeviceServices,
  queryServiceTraffic,
  queryServicesSummary,
  resolutionLabel,
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
   * GET /api/v1/services/:serverName/traffic?range=…&resolution?=1h|1d
   *
   * Served / received history for one name. 5-minute for recent short
   * windows, hourly otherwise, daily when hourly points would exceed the
   * chart budget (see `pickServiceResolution`).
   */
  async traffic({ request, params, response, serialize }: HttpContext) {
    const qs = await serviceTrafficQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '7d')
    if (window.error) return response.badRequest(window.error)
    const resolutionSeconds = pickServiceResolution(qs.resolution, window.since, window.until)

    const buckets = await queryServiceTraffic({
      serverName: params.serverName,
      since: window.since,
      until: window.until,
      resolutionSeconds,
      collectorId: qs.collectorId,
    })

    return serialize({
      serverName: params.serverName,
      range: window.range,
      from: window.since.toISO(),
      to: window.until.toISO(),
      resolution: resolutionLabel(resolutionSeconds),
      resolutionSeconds,
      buckets,
    })
  }
}
