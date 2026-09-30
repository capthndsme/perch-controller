import { applyFlag, runSync } from '#services/gateway_config/gateway_sync_http'
import { ipv6Overview, updateIpv6, updateIpv6Lan } from '#services/gateway_config/ipv6_service'
import { ipv6LanPatchValidator, ipv6PatchValidator } from '#validators/gateway_sync_services'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Gateway sync: IPv6 (docs/design/gateway-sync/rest.md 5, work package B4):
 * the ULA, each LAN's prefix assignment and RA/DHCPv6/NDP, the upstream as
 * the WAN page edits it. Admin-only (start/routes/gateway_sync.ts).
 */
export default class GatewayIpv6Controller {
  /** GET /api/v1/gateways/:id/ipv6 */
  async show(ctx: HttpContext) {
    return runSync(ctx, (_c, _u, gatewayId) => ipv6Overview(gatewayId))
  }

  /** PATCH /api/v1/gateways/:id/ipv6[?apply=0] */
  async update(ctx: HttpContext) {
    const payload = await ctx.request.validateUsing(ipv6PatchValidator)
    return runSync(ctx, (c, userId, gatewayId) =>
      updateIpv6(gatewayId, userId, payload, { apply: applyFlag(c.request) })
    )
  }

  /** PATCH /api/v1/gateways/:id/ipv6/lans/:network[?apply=0] */
  async updateLan(ctx: HttpContext) {
    const payload = await ctx.request.validateUsing(ipv6LanPatchValidator)
    return runSync(ctx, (c, userId, gatewayId) =>
      updateIpv6Lan(gatewayId, userId, String(c.params.network), payload, {
        apply: applyFlag(c.request),
        requestIp: c.request.ip(),
      })
    )
  }
}
