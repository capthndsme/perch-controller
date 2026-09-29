import { notBuilt } from '#services/gateway_config/gateway_sync_http'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Gateway sync: DDNS services (rest.md 9). Admin-only (start/routes/gateway_sync.ts).
 * Skeleton (B8): every route answers 501 `not_built` until work package B6
 * fills this controller in.
 */
export default class GatewayDdnsController {
  async index(ctx: HttpContext) {
    return notBuilt(ctx, 'B6')
  }

  async createService(ctx: HttpContext) {
    return notBuilt(ctx, 'B6')
  }

  async updateService(ctx: HttpContext) {
    return notBuilt(ctx, 'B6')
  }

  async deleteService(ctx: HttpContext) {
    return notBuilt(ctx, 'B6')
  }

  async updateNow(ctx: HttpContext) {
    return notBuilt(ctx, 'B6')
  }
}
