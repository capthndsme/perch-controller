import { GatewaySchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'
import type {
  GatewayCapabilities,
  GatewayEnforcement,
  GatewayMode,
  GatewaySyncState,
  ManagementPath,
} from '#services/gateway_config/types'

export type { GatewayEnforcement, GatewayMode, GatewaySyncState }

/**
 * A managed gateway (docs/gateway/config-plane.md sections 2 and 9): the
 * controller-side row of a collector that runs on an OpenWrt router and
 * carries the `gateway_config` capability. `collectorId` null = detached
 * (its collector was deleted; history stays, it can be re-bound).
 *
 * Unions (`mode`, `enforcement`, `syncState`, `agentAccess`) are plain
 * strings enforced in the app layer; the JSON columns are parsed here.
 */
export default class Gateway extends GatewaySchema {
  @jsonColumn('pinned_hashes')
  declare pinnedHashes: Record<string, string> | null

  @jsonColumn('capabilities')
  declare capabilities: GatewayCapabilities | null

  @jsonColumn('observed_hashes')
  declare observedHashes: Record<string, string> | null

  @jsonColumn('management_path')
  declare managementPath: ManagementPath | null
}
