import { notBuilt } from '#services/gateway_config/gateway_sync_http'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Gateway sync: ambiguous sections: list and resolve (rest.md 6). Admin-only (start/routes/gateway_sync.ts).
 * Skeleton (B8): every route answers 501 `not_built` until work package B3
 * fills this controller in.
 */
export default class GatewayAmbiguitiesController {
  async index(ctx: HttpContext) {
    return notBuilt(ctx, 'B3')
  }

  async resolve(ctx: HttpContext) {
    return notBuilt(ctx, 'B3')
  }
}
