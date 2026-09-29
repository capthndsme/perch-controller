import { notBuilt } from '#services/gateway_config/gateway_sync_http'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Gateway sync: Settings → Gateway sync (rest.md 11). Admin-only (start/routes/gateway_sync.ts).
 * Skeleton (B8): every route answers 501 `not_built` until work package B1
 * fills this controller in.
 */
export default class GatewaySyncSettingsController {
  async show(ctx: HttpContext) {
    return notBuilt(ctx, 'B1')
  }

  async update(ctx: HttpContext) {
    return notBuilt(ctx, 'B1')
  }
}
