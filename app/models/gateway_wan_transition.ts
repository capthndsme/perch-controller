import { GatewayWanTransitionSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'

export const WAN_TRANSITION_EVENTS = [
  'down',
  'up',
  'failover',
  'ip_changed',
  'prefix_changed',
] as const
export type WanTransitionEvent = (typeof WAN_TRANSITION_EVENTS)[number]

/**
 * One WAN transition the `interfaces` observation showed (migration 142):
 * the WAN page's history and the alerts area's source. Pruned after
 * Settings → Gateway sync `transitionRetentionDays`.
 */
export default class GatewayWanTransition extends GatewayWanTransitionSchema {
  @jsonColumn('detail')
  declare detail: Record<string, unknown> | null
}
