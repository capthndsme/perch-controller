import { ambiguityOverview, resolveAmbiguities } from '#services/gateway_config/ambiguity_service'
import { applyFlag, runSync } from '#services/gateway_config/gateway_sync_http'
import { ambiguityResolveValidator } from '#validators/gateway_sync'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Gateway sync: ambiguous sections (docs/design/gateway-sync/rest.md 6, work
 * package B3). Admin-only (start/routes/gateway_sync.ts). The resolve starts
 * an apply of the promoted members unless `?apply=0`.
 */
export default class GatewayAmbiguitiesController {
  /** GET /api/v1/gateways/:id/ambiguities */
  async index(ctx: HttpContext) {
    return runSync(ctx, (_c, _u, gatewayId) => ambiguityOverview(gatewayId))
  }

  /** POST /api/v1/gateways/:id/ambiguities/resolve[?apply=0] */
  async resolve(ctx: HttpContext) {
    const payload = await ctx.request.validateUsing(ambiguityResolveValidator)
    return runSync(ctx, (c, userId, gatewayId) =>
      resolveAmbiguities(gatewayId, userId, { ...payload, apply: applyFlag(c.request) })
    )
  }
}
