import { notBuilt } from '#services/gateway_config/gateway_sync_http'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Gateway sync: WAN uplinks, aliases and failover order (rest.md 3). Admin-only (start/routes/gateway_sync.ts).
 * Skeleton (B8): every route answers 501 `not_built` until work package B1
 * fills this controller in.
 */
export default class GatewayWanController {
  async index(ctx: HttpContext) {
    return notBuilt(ctx, 'B1')
  }

  async history(ctx: HttpContext) {
    return notBuilt(ctx, 'B1')
  }

  async order(ctx: HttpContext) {
    return notBuilt(ctx, 'B1')
  }

  async create(ctx: HttpContext) {
    return notBuilt(ctx, 'B1')
  }

  async show(ctx: HttpContext) {
    return notBuilt(ctx, 'B1')
  }

  async update(ctx: HttpContext) {
    return notBuilt(ctx, 'B1')
  }

  async destroy(ctx: HttpContext) {
    return notBuilt(ctx, 'B1')
  }

  async createAlias(ctx: HttpContext) {
    return notBuilt(ctx, 'B1')
  }

  async updateAlias(ctx: HttpContext) {
    return notBuilt(ctx, 'B1')
  }

  async deleteAlias(ctx: HttpContext) {
    return notBuilt(ctx, 'B1')
  }
}
