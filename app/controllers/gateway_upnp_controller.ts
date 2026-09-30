import { applyFlag, runSync } from '#services/gateway_config/gateway_sync_http'
import {
  createUpnpRule,
  deleteUpnpMappings,
  deleteUpnpRule,
  reorderUpnpAcl,
  setUpnpDeviceBlocked,
  updateUpnpConfig,
  updateUpnpRule,
  upnpConfigView,
} from '#services/gateway_config/upnp_service'
import {
  upnpAclCreateValidator,
  upnpAclOrderValidator,
  upnpAclPatchValidator,
  upnpConfigPatchValidator,
  upnpDeviceBlockValidator,
  upnpMappingsDeleteValidator,
} from '#validators/gateway_sync_services'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Gateway sync: miniupnpd's settings, its ordered ACL, live mappings and the
 * per-device block (docs/design/gateway-sync/rest.md 8, work package B5).
 * Admin-only (start/routes/gateway_sync.ts).
 */
export default class GatewayUpnpController {
  /** GET /api/v1/gateways/:id/upnp/config */
  async show(ctx: HttpContext) {
    return runSync(ctx, (_c, _u, gatewayId) => upnpConfigView(gatewayId))
  }

  /** PATCH /api/v1/gateways/:id/upnp/config[?apply=0] */
  async update(ctx: HttpContext) {
    const payload = await ctx.request.validateUsing(upnpConfigPatchValidator)
    return runSync(ctx, (c, userId, gatewayId) =>
      updateUpnpConfig(gatewayId, userId, payload, { apply: applyFlag(c.request) })
    )
  }

  /** POST /api/v1/gateways/:id/upnp/acl[?apply=0] */
  async createAcl(ctx: HttpContext) {
    const payload = await ctx.request.validateUsing(upnpAclCreateValidator)
    return runSync(
      ctx,
      (c, userId, gatewayId) =>
        createUpnpRule(gatewayId, userId, payload, { apply: applyFlag(c.request) }),
      201
    )
  }

  /** PATCH /api/v1/gateways/:id/upnp/acl/:perchId[?apply=0] */
  async updateAcl(ctx: HttpContext) {
    const payload = await ctx.request.validateUsing(upnpAclPatchValidator)
    return runSync(ctx, (c, userId, gatewayId) =>
      updateUpnpRule(gatewayId, userId, String(c.params.perchId), payload, {
        apply: applyFlag(c.request),
      })
    )
  }

  /** DELETE /api/v1/gateways/:id/upnp/acl/:perchId[?apply=0] */
  async deleteAcl(ctx: HttpContext) {
    return runSync(ctx, (c, userId, gatewayId) =>
      deleteUpnpRule(gatewayId, userId, String(c.params.perchId), { apply: applyFlag(c.request) })
    )
  }

  /** PUT /api/v1/gateways/:id/upnp/acl/order[?apply=0] */
  async orderAcl(ctx: HttpContext) {
    const { ids } = await ctx.request.validateUsing(upnpAclOrderValidator)
    return runSync(ctx, (c, userId, gatewayId) =>
      reorderUpnpAcl(gatewayId, userId, ids, { apply: applyFlag(c.request) })
    )
  }

  /** POST /api/v1/gateways/:id/upnp/mappings/delete (runtime, no apply) */
  async deleteMappings(ctx: HttpContext) {
    const { mappings } = await ctx.request.validateUsing(upnpMappingsDeleteValidator)
    return runSync(ctx, (_c, userId, gatewayId) => deleteUpnpMappings(gatewayId, userId, mappings))
  }

  /** PUT /api/v1/gateways/:id/upnp/devices/:mac[?apply=0] */
  async blockDevice(ctx: HttpContext) {
    const { blocked } = await ctx.request.validateUsing(upnpDeviceBlockValidator)
    return runSync(ctx, (c, userId, gatewayId) =>
      setUpnpDeviceBlocked(gatewayId, userId, String(c.params.mac), blocked, {
        apply: applyFlag(c.request),
      })
    )
  }
}
