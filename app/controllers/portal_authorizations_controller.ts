import {
  type PortalPrincipal,
  authorizeDevice,
  deauthorizeDevice,
  deviceAuthorization,
} from '#services/portal_authorize'
import { authorizationQueryValidator, authorizeValidator } from '#validators/portal'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * The per-MAC authorize API (docs/gateway/portal.md section 11.6), behind
 * `portalApiAuth`: API clients with their own scoped tokens (a paid-hotspot
 * integration such as a coin-operated vending box), or an admin's token. Answers are never cached.
 */
export default class PortalAuthorizationsController {
  /** POST /api/v1/portal/authorizations */
  async store(ctx: HttpContext) {
    const payload = await ctx.request.validateUsing(authorizeValidator)
    const result = await authorizeDevice(principal(ctx), payload, context(ctx))
    ctx.response.header('Cache-Control', 'no-store')
    ctx.response.status(result.status)
    return {
      data: { grant: result.grant, delivery: result.delivery, outcome: result.outcome },
    }
  }

  /** GET /api/v1/portal/authorizations/:mac?portalId= */
  async show(ctx: HttpContext) {
    const { portalId } = await authorizationQueryValidator.validate(ctx.request.qs())
    ctx.response.header('Cache-Control', 'no-store')
    return {
      data: await deviceAuthorization(
        principal(ctx),
        portalId,
        String(ctx.params.mac),
        context(ctx)
      ),
    }
  }

  /** DELETE /api/v1/portal/authorizations/:mac?portalId= */
  async destroy(ctx: HttpContext) {
    const { portalId } = await authorizationQueryValidator.validate(ctx.request.qs())
    ctx.response.header('Cache-Control', 'no-store')
    return {
      data: await deauthorizeDevice(principal(ctx), portalId, String(ctx.params.mac), context(ctx)),
    }
  }
}

function principal(ctx: HttpContext): PortalPrincipal {
  if (!ctx.portalPrincipal) throw new Error('portalApiAuth middleware missing on this route')
  return ctx.portalPrincipal
}

function context(ctx: HttpContext) {
  return { via: 'http' as const, address: ctx.request.ip() }
}
