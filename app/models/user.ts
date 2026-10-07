import { UserSchema } from '#database/schema'
import hash from '@adonisjs/core/services/hash'
import { compose } from '@adonisjs/core/helpers'
import { withAuthFinder } from '@adonisjs/auth/mixins/lucid'
import { type AccessToken, DbAccessTokensProvider } from '@adonisjs/auth/access_tokens'

/**
 * User roles, ordered loosely by privilege. Only `admin` may complete the
 * setup wizard and write to system settings / collectors today; the other
 * tiers exist so we can land RBAC without a follow-up migration.
 * `wifi_vendor` sells portal codes in Sell Mode and can do nothing else
 * (docs/gateway/portal.md section 15).
 */
export const USER_ROLES = ['admin', 'operator', 'viewer', 'wifi_vendor'] as const
export type UserRole = (typeof USER_ROLES)[number]

/** The roles that use the dashboard: `middleware.auth()` admits these unless a route says otherwise. */
export const DASHBOARD_ROLES: readonly UserRole[] = ['admin', 'operator', 'viewer']

/** Who may sell in Sell Mode. */
export const SELL_ROLES: readonly UserRole[] = ['admin', 'wifi_vendor']

export default class User extends compose(UserSchema, withAuthFinder(hash)) {
  static accessTokens = DbAccessTokensProvider.forModel(User)
  declare currentAccessToken?: AccessToken

  get initials() {
    const [first, last] = this.fullName ? this.fullName.split(' ') : this.email.split('@')
    if (first && last) {
      return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase()
    }
    return `${first.slice(0, 2)}`.toUpperCase()
  }

  get isAdmin() {
    return this.role === 'admin'
  }
}
