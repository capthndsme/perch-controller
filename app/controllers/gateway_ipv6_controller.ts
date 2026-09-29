import { notBuilt } from '#services/gateway_config/gateway_sync_http'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Gateway sync: IPv6: ULA, LAN RA/DHCPv6, upstream (rest.md 5). Admin-only (start/routes/gateway_sync.ts).
 * Skeleton (B8): every route answers 501 `not_built` until work package B4
 * fills this controller in.
 */
export default class GatewayIpv6Controller {
  async show(ctx: HttpContext) {
    return notBuilt(ctx, 'B4')
  }

  async update(ctx: HttpContext) {
    return notBuilt(ctx, 'B4')
  }

  async updateLan(ctx: HttpContext) {
    return notBuilt(ctx, 'B4')
  }
}
