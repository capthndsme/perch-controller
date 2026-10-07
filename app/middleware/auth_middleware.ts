import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import type { Authenticators } from '@adonisjs/auth/types'
import { DASHBOARD_ROLES, type UserRole } from '#models/user'

/**
 * Auth middleware is used authenticate HTTP requests and deny
 * access to unauthenticated users.
 *
 * `roles` lists who may use the route; the default is the dashboard roles,
 * so a narrow role (`wifi_vendor`, docs/gateway/portal.md section 15.2) is
 * refused everywhere a route does not admit it by name.
 */
export default class AuthMiddleware {
  async handle(
    ctx: HttpContext,
    next: NextFn,
    options: {
      guards?: (keyof Authenticators)[]
      roles?: readonly UserRole[]
    } = {}
  ) {
    await ctx.auth.authenticateUsing(options.guards)
    const roles = options.roles ?? DASHBOARD_ROLES
    const role = ctx.auth.user?.role as UserRole | undefined
    if (!role || !roles.includes(role)) {
      return ctx.response.forbidden({
        error: 'role_forbidden',
        message: 'Your account cannot use this endpoint.',
      })
    }
    return next()
  }
}
