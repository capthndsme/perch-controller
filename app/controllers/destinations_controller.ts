import { getChartSettings } from '#services/chart_settings'
import {
  destinationHistoryExistsForMac,
  queryDestinationTraffic,
  queryDestinationsSummary,
} from '#services/destination_history'
import { parseBucketLabel } from '#services/series_buckets'
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
   * GET /api/v1/destinations/:serverName/traffic?range=…|from&to&resolution?&collectorId?
   *
   * Dense in/out series for one destination name (same contract as the
   * services series; destinations are stored per hour, so buckets are an
   * hour or wider).
   */
  async traffic({ request, params, response, serialize }: HttpContext) {
    const qs = await destinationTrafficQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '7d')
    if (window.error) return response.badRequest(window.error)

    const series = await queryDestinationTraffic({
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
