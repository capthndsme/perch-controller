import { notBuilt } from '#services/gateway_config/gateway_sync_http'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Gateway sync: firewall `defaults` (rest.md 7). Admin-only (start/routes/gateway_sync.ts).
 * Skeleton (B8): every route answers 501 `not_built` until work package B3
 * fills this controller in.
 */
export default class GatewayFirewallDefaultsController {
  async show(ctx: HttpContext) {
    return notBuilt(ctx, 'B3')
  }

  async update(ctx: HttpContext) {
    return notBuilt(ctx, 'B3')
  }
}
