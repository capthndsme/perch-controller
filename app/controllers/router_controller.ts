import {
  gatewaySource,
  latestRouterSample,
  pickRouterResolution,
  queryRouterSeries,
} from '#services/router_metrics'
import { resolveTimeWindow } from '#services/time_window'
import { routerQueryValidator } from '#validators/devices'
import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'

/**
 * Gateway health as the collector on the router reports it
 * (docs/collector-agent.md section 4).
 */
export default class RouterController {
  /**
   * GET /api/v1/router?range=24h|from&to&resolution=auto|1m|5m|15m|1h
   *
   * `source` names the collector the numbers come from (null when no adopted
   * collector reports gateway stats); `latest` and `series` read whatever is
   * in `router_samples`, so history stays visible without a current source.
   */
  async index({ request, response, serialize }: HttpContext) {
    const qs = await routerQueryValidator.validate(request.qs())
    const window = resolveTimeWindow(qs, '24h')
    if (window.error) return response.badRequest(window.error)
    const resolutionSeconds = pickRouterResolution(qs.resolution, window.since, window.until)

    const source = await gatewaySource()
    const wanIfaces = source?.wanInterfaces ?? []
    const [latest, series] = await Promise.all([
      latestRouterSample(wanIfaces),
      queryRouterSeries({ since: window.since, until: window.until, resolutionSeconds }),
    ])

    const ageSeconds = latest
      ? Math.max(
          0,
          Math.round(DateTime.utc().diff(DateTime.fromISO(latest.recordedAt), 'seconds').seconds)
        )
      : null
    const conntrackPct =
      latest && latest.conntrackEntries !== null && latest.conntrackLimit
        ? Math.round((latest.conntrackEntries / latest.conntrackLimit) * 1000) / 10
        : null

    return serialize({
      source,
      wanIfaces,
      range: window.range,
      from: window.since.toISO(),
      to: window.until.toISO(),
      resolution: `${resolutionSeconds / 60}m`,
      resolutionSeconds,
      latest: latest
        ? {
            ...latest,
            ageSeconds,
            conntrackPct,
            wanRxMbps:
              latest.wanRxBps === null ? null : Math.round((latest.wanRxBps / 1e6) * 100) / 100,
            wanTxMbps:
              latest.wanTxBps === null ? null : Math.round((latest.wanTxBps / 1e6) * 100) / 100,
          }
        : null,
      series,
    })
  }
}
