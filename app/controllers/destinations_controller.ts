import {
  destinationHistoryExistsForMac,
  pickDestinationResolution,
  queryDestinationTraffic,
  queryDestinationsSummary,
} from '#services/destination_history'
import { resolveTimeWindow } from '#services/time_window'
import { destinationTrafficQueryValidator, destinationsQueryValidator } from '#validators/devices'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * "Where is the traffic going": bytes per destination name (TLS SNI / HTTP
 * Host / QUIC SNI the client asked for), grouped by registered domain and by
 * nDPI application category, attributed to the local device that was the
 * client of the flow. The mirror image of the Services API.
 */
export default class DestinationsController {
  /**
   * GET /api/v1/destinations?range=…|from&to&limit?=25&collectorId?=
   */
  async index({ request, response, serialize }: HttpContext) {
    const qs = await destinationsQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '24h')
    if (window.error) return response.badRequest(window.error)
    const limit = qs.limit ?? 25

    const summary = await queryDestinationsSummary({
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
   * GET /api/v1/devices/:mac/destinations?range=…&limit?=25
   *
   * 404 when the MAC has never had a destination row (it may still exist as
   * a plain device, or only ever have served).
   */
  async device({ request, params, response, serialize }: HttpContext) {
    const qs = await destinationsQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '24h')
    if (window.error) return response.badRequest(window.error)
    const limit = qs.limit ?? 25

    const summary = await queryDestinationsSummary({
      mac: params.mac,
      since: window.since,
      until: window.until,
      collectorId: qs.collectorId,
      limit,
    })
    if (summary.destinations.length === 0 && !(await destinationHistoryExistsForMac(params.mac))) {
      return response.notFound({
        error: 'mac_not_found',
        message: `MAC ${params.mac} has no destination history.`,
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
   * GET /api/v1/destinations/:serverName/traffic?range=…&resolution?=1h|1d
   */
  async traffic({ request, params, response, serialize }: HttpContext) {
    const qs = await destinationTrafficQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '7d')
    if (window.error) return response.badRequest(window.error)
    const resolutionSeconds = pickDestinationResolution(qs.resolution, window.since, window.until)

    const buckets = await queryDestinationTraffic({
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
      resolution: resolutionSeconds === 86400 ? '1d' : '1h',
      resolutionSeconds,
      buckets,
    })
  }
}
