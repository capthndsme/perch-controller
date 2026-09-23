import { PortalAuthorizationSchema } from '#database/schema'

export const PORTAL_AUTHORIZATION_OUTCOMES = ['created', 'extended'] as const
export type PortalAuthorizationOutcome = (typeof PORTAL_AUTHORIZATION_OUTCOMES)[number]

/**
 * One accepted `POST /portal/authorizations` call (docs/gateway/portal.md
 * section 11.6): the idempotency ledger and audit trail of the authorize API.
 * `principal` is `c:<apiClientId>` or `u:<userId>`.
 */
export default class PortalAuthorization extends PortalAuthorizationSchema {
  declare outcome: PortalAuthorizationOutcome
  declare via: 'http' | 'relay'
}
