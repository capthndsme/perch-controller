import { notBuilt } from '#services/gateway_config/gateway_sync_http'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Gateway sync: multi-WAN read view (rest.md 10). Admin-only (start/routes/gateway_sync.ts).
 * Skeleton (B8): every route answers 501 `not_built` until work package B7a
 * fills this controller in.
 */
export default class GatewayMultiwanController {
  async show(ctx: HttpContext) {
    return notBuilt(ctx, 'B7a')
  }
}
