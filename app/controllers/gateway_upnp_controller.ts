import { notBuilt } from '#services/gateway_config/gateway_sync_http'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Gateway sync: UPnP settings, ACL and mappings (rest.md 8). Admin-only (start/routes/gateway_sync.ts).
 * Skeleton (B8): every route answers 501 `not_built` until work package B5
 * fills this controller in.
 */
export default class GatewayUpnpController {
  async show(ctx: HttpContext) {
    return notBuilt(ctx, 'B5')
  }

  async update(ctx: HttpContext) {
    return notBuilt(ctx, 'B5')
  }

  async createAcl(ctx: HttpContext) {
    return notBuilt(ctx, 'B5')
  }

  async updateAcl(ctx: HttpContext) {
    return notBuilt(ctx, 'B5')
  }

  async deleteAcl(ctx: HttpContext) {
    return notBuilt(ctx, 'B5')
  }

  async orderAcl(ctx: HttpContext) {
    return notBuilt(ctx, 'B5')
  }

  async deleteMappings(ctx: HttpContext) {
    return notBuilt(ctx, 'B5')
  }

  async blockDevice(ctx: HttpContext) {
    return notBuilt(ctx, 'B5')
  }
}
