import { GatewayWanSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'

/** A WAN's role (docs/design/gateway-sync/rest.md 3). */
export const WAN_ROLES = ['internet', 'nat_link'] as const
export type WanRole = (typeof WAN_ROLES)[number]

/**
 * Perch-only metadata of one WAN (migration 141), keyed by its network name
 * and never written into UCI: the dashboard's label, a role override and
 * this WAN's own check targets.
 */
export default class GatewayWan extends GatewayWanSchema {
  /** Overrides Settings → Gateway sync `checkTargets` for this WAN; null = the setting. */
  @jsonColumn('check_targets')
  declare checkTargets: string[] | null
}
