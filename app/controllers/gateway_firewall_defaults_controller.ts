import {
  firewallDefaultsView,
  updateFirewallDefaults,
} from '#services/gateway_config/firewall_defaults_service'
import { applyFlag, runSync } from '#services/gateway_config/gateway_sync_http'
import { firewallDefaultsPatchValidator } from '#validators/gateway_sync'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Gateway sync: the firewall `defaults` section (docs/design/gateway-sync/
 * rest.md 7, work package B3). Admin-only (start/routes/gateway_sync.ts).
 * A write is always a protected job (longer confirm window).
 */
export default class GatewayFirewallDefaultsController {
  /** GET /api/v1/gateways/:id/firewall/defaults */
  async show(ctx: HttpContext) {
    return runSync(ctx, (_c, _u, gatewayId) => firewallDefaultsView(gatewayId))
  }

  /** PATCH /api/v1/gateways/:id/firewall/defaults[?apply=0] */
  async update(ctx: HttpContext) {
    const payload = await ctx.request.validateUsing(firewallDefaultsPatchValidator)
    return runSync(ctx, (c, userId, gatewayId) =>
      updateFirewallDefaults(gatewayId, userId, payload, { apply: applyFlag(c.request) })
    )
  }
}
