import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

/**
 * Blocks any API call (except the password-change and logout endpoints)
 * when the authenticated user has `must_change_password = true`. This forces
 * users created via admin invite to set their own password before using the
 * dashboard.
 *
 * Must be chained AFTER `middleware.auth()`.
 */
export default class RequirePasswordChangeMiddleware {
  /**
   * Routes that are exempt from the password-change gate. These are
   * matched against `ctx.route?.pattern` which is the registered pattern
   * string (e.g. `/api/v1/account/password`).
   */
  private static readonly EXEMPT_PATTERNS = new Set([
    '/api/v1/account/password',
    '/api/v1/account/logout',
  ])

  async handle(ctx: HttpContext, next: NextFn) {
    const user = ctx.auth.user
    if (!user) {
      return next()
    }

    const routePattern = ctx.route?.pattern
    if (
      user.mustChangePassword &&
      routePattern &&
      !RequirePasswordChangeMiddleware.EXEMPT_PATTERNS.has(routePattern)
    ) {
      return ctx.response.forbidden({
        error: 'password_change_required',
        message: 'You must change your temporary password before continuing.',
      })
    }

    return next()
  }
}
