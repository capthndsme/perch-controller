import { GatewayConfigEventSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'

/**
 * Audit log of the config plane (docs/gateway/config-plane.md section 9;
 * event names in `GATEWAY_EVENTS`). Pruned after the `auditRetentionDays`
 * gateway setting by the daily retention task.
 */
export default class GatewayConfigEvent extends GatewayConfigEventSchema {
  @jsonColumn('detail')
  declare detail: Record<string, unknown> | null
}
