import { PortalGrantSchema } from '#database/schema'
import type {
  DurationMode,
  GrantDelivery,
  GrantEndReason,
  GrantSource,
  GrantState,
} from '#services/portal/types'

/**
 * One MAC authorized on one portal (docs/gateway/portal.md section 4.2).
 * Lifecycle in `services/portal/grant_lifecycle.ts`.
 */
export default class PortalGrant extends PortalGrantSchema {
  declare source: GrantSource
  declare state: GrantState
  declare delivery: GrantDelivery
  declare durationMode: DurationMode
  declare endReason: GrantEndReason | null
}
