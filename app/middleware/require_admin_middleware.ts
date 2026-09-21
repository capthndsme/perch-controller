import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

/**
 * Requires that the authenticated user has role=admin. Must be chained
 * AFTER `middleware.auth()` so `ctx.auth.user` is populated. Yields 403
 * with a stable error code so the frontend can render a coherent message
 * (vs. the 401 that a missing token would produce).
 */
export default class RequireAdminMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const user = ctx.auth.user
    if (!user || !user.isAdmin) {
      return ctx.response.forbidden({
        error: 'admin_required',
        message: 'This endpoint requires an admin role.',
      })
    }
    return next()
  }
}
