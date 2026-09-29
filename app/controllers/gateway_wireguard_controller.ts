import { notBuilt } from '#services/gateway_config/gateway_sync_http'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Gateway sync: WireGuard interfaces and peers (rest.md 4). Admin-only (start/routes/gateway_sync.ts).
 * Skeleton (B8): every route answers 501 `not_built` until work package B2
 * fills this controller in.
 */
export default class GatewayWireguardController {
  async index(ctx: HttpContext) {
    return notBuilt(ctx, 'B2')
  }

  async createInterface(ctx: HttpContext) {
    return notBuilt(ctx, 'B2')
  }

  async updateInterface(ctx: HttpContext) {
    return notBuilt(ctx, 'B2')
  }

  async deleteInterface(ctx: HttpContext) {
    return notBuilt(ctx, 'B2')
  }

  async rotateKey(ctx: HttpContext) {
    return notBuilt(ctx, 'B2')
  }

  async createPeer(ctx: HttpContext) {
    return notBuilt(ctx, 'B2')
  }

  async updatePeer(ctx: HttpContext) {
    return notBuilt(ctx, 'B2')
  }

  async deletePeer(ctx: HttpContext) {
    return notBuilt(ctx, 'B2')
  }
}
