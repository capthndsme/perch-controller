import {
  createDdnsService,
  ddnsOverview,
  ddnsUpdateNow,
  deleteDdnsService,
  updateDdnsService,
} from '#services/gateway_config/ddns_service'
import { applyFlag, runSync } from '#services/gateway_config/gateway_sync_http'
import {
  ddnsServiceCreateValidator,
  ddnsServicePatchValidator,
} from '#validators/gateway_sync_services'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Gateway sync: DDNS services (docs/design/gateway-sync/rest.md 9, work
 * package B6). Admin-only (start/routes/gateway_sync.ts). Passwords are
 * write-only and travel only over verified TLS.
 */
export default class GatewayDdnsController {
  /** GET /api/v1/gateways/:id/ddns */
  async index(ctx: HttpContext) {
    return runSync(ctx, (_c, _u, gatewayId) => ddnsOverview(gatewayId))
  }

  /** POST /api/v1/gateways/:id/ddns/services[?apply=0] */
  async createService(ctx: HttpContext) {
    const payload = await ctx.request.validateUsing(ddnsServiceCreateValidator)
    return runSync(
      ctx,
      (c, userId, gatewayId) =>
        createDdnsService(gatewayId, userId, payload, { apply: applyFlag(c.request) }),
      201
    )
  }

  /** PATCH /api/v1/gateways/:id/ddns/services/:perchId[?apply=0] */
  async updateService(ctx: HttpContext) {
    const payload = await ctx.request.validateUsing(ddnsServicePatchValidator)
    return runSync(ctx, (c, userId, gatewayId) =>
      updateDdnsService(gatewayId, userId, String(c.params.perchId), payload, {
        apply: applyFlag(c.request),
      })
    )
  }

  /** DELETE /api/v1/gateways/:id/ddns/services/:perchId[?apply=0] */
  async deleteService(ctx: HttpContext) {
    return runSync(ctx, (c, userId, gatewayId) =>
      deleteDdnsService(gatewayId, userId, String(c.params.perchId), {
        apply: applyFlag(c.request),
      })
    )
  }

  /** POST /api/v1/gateways/:id/ddns/services/:perchId/update-now */
  async updateNow(ctx: HttpContext) {
    return runSync(
      ctx,
      (c, userId, gatewayId) => ddnsUpdateNow(gatewayId, userId, String(c.params.perchId)),
      202
    )
  }
}
