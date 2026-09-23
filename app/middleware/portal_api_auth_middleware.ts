import { authenticatePortalApiToken, isPortalApiToken } from '#services/portal_api_clients'
import {
  consumePortalApiRequest,
  portalApiAuthBudget,
  recordPortalApiAuthFailure,
} from '#services/portal_api_rate_limit'
import { type PortalPrincipal, clientPrincipal, userPrincipal } from '#services/portal_authorize'
import { getPortalSettings } from '#services/portal_settings'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

declare module '@adonisjs/core/http' {
  interface HttpContext {
    /** Set by `portalApiAuth` on the authorize API routes. */
    portalPrincipal?: PortalPrincipal
  }
}

/**
 * `portalApiAuth` (docs/gateway/portal.md section 11.6): authentication of
 * the authorize API, which sits outside `auth()` because integrations are not
 * controller users.
 *
 * - `Authorization: Bearer perch_pa_…`: an active API client. Its scope and
 *   portals are checked per route by the service.
 * - Any other bearer: a controller access token, accepted only for an admin
 *   who has no pending password change (an admin authorizes their own
 *   devices from the dashboard).
 * - Nothing, or anything invalid: 401 `invalid_api_token`, charged against the
 *   caller's address (20 failures in 15 min → 429 `rate_limited`).
 * - Every authenticated request counts against its principal's
 *   `apiRequestsPerClientPerMinute` (429 `rate_limited` + `Retry-After`).
 */
export default class PortalApiAuthMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const { request, response } = ctx
    const address = request.ip()
    const budget = portalApiAuthBudget(address)
    if (!budget.allowed) return tooMany(ctx, budget.retryAfterSeconds)

    const header = request.header('authorization') ?? ''
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
    const token = match?.[1] ?? ''

    let principal: PortalPrincipal | null = null
    if (token && isPortalApiToken(token)) {
      const client = await authenticatePortalApiToken(token)
      if (client) principal = clientPrincipal(client)
    } else if (token) {
      try {
        const user = await ctx.auth.use('api').authenticate()
        if (!user.isAdmin) {
          return response.forbidden({
            error: 'admin_required',
            message: 'Only an admin token or a portal API token may use this endpoint.',
          })
        }
        if (user.mustChangePassword) {
          return response.forbidden({
            error: 'password_change_required',
            message: 'You must change your temporary password before continuing.',
          })
        }
        principal = userPrincipal(user)
      } catch {
        principal = null
      }
    }
    if (!principal) {
      recordPortalApiAuthFailure(address)
      return response.unauthorized({
        error: 'invalid_api_token',
        message: 'A valid portal API token (Bearer perch_pa_…) or admin token is required.',
      })
    }

    const settings = await getPortalSettings()
    const allowed = consumePortalApiRequest(principal.key, settings.apiRequestsPerClientPerMinute)
    if (!allowed.allowed) return tooMany(ctx, allowed.retryAfterSeconds)

    ctx.portalPrincipal = principal
    return next()
  }
}

function tooMany(ctx: HttpContext, retryAfterSeconds: number) {
  ctx.response.header('Retry-After', String(retryAfterSeconds))
  return ctx.response.tooManyRequests({
    error: 'rate_limited',
    message: 'Too many requests; retry later.',
    retryAfterSeconds,
  })
}
