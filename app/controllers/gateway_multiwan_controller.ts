import { runSync } from '#services/gateway_config/gateway_sync_http'
import { multiwanView } from '#services/gateway_config/multiwan_view'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Gateway sync: multi-WAN, read only (docs/design/gateway-sync/rest.md 10,
 * work package B7a). Admin-only (start/routes/gateway_sync.ts). Owner
 * decision 12 stands: there is no write route.
 */
export default class GatewayMultiwanController {
  /** GET /api/v1/gateways/:id/multiwan */
  async show(ctx: HttpContext) {
    return runSync(ctx, (_c, _u, gatewayId) => multiwanView(gatewayId))
  }
}
