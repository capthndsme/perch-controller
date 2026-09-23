import { PortalGatewayStateSchema } from '#database/schema'

/**
 * Per-gateway portal state (docs/gateway/portal.md section 7): the journal
 * position and the gateway key epoch. Keyed by `gatewayId`.
 */
export default class PortalGatewayState extends PortalGatewayStateSchema {
  static primaryKey = 'gatewayId'
  static selfAssignPrimaryKey = true
}
