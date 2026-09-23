import { PortalGatewayStateSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'

/** The hello's `portal` object (docs/gateway/portal.md section 13.2). */
export type PortalRouterCapabilities = {
  version: number | null
  keyEpoch: number | null
  configRevision: number | null
  enforcement: Record<string, unknown> | null
  storage: Record<string, unknown> | null
  port: number | null
  maxPortals: number | null
}

/** The gateway-level part of the last `portal.configure` result. */
export type PortalRouterStatus = {
  enforcement: Record<string, unknown> | null
  storage: Record<string, unknown> | null
  issues: string[]
  at: string
}

/**
 * Per-gateway portal state (docs/gateway/portal.md sections 7 and 13): the
 * journal position, the gateway key epoch, the configure revision, the
 * router's portal capabilities and the delivery retry state. Keyed by
 * `gatewayId`.
 */
export default class PortalGatewayState extends PortalGatewayStateSchema {
  static primaryKey = 'gatewayId'
  static selfAssignPrimaryKey = true

  /** null = the router is not portal-capable (or never said). */
  @jsonColumn('capabilities')
  declare capabilities: PortalRouterCapabilities | null

  @jsonColumn('router_status')
  declare routerStatus: PortalRouterStatus | null
}
