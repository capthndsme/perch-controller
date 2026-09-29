import { WifiDivergenceSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'
import type { RouterAuthor } from '#services/gateway_config/types'
import type { DivergenceKind, DivergenceResolution } from '#services/wifi_config/types'

/**
 * Where an AP differs from what the fleet renders for it (docs/design/wifi
 * controller.md section 5.3). Open while `resolvedAt` is null.
 */
export default class WifiDivergence extends WifiDivergenceSchema {
  declare kind: DivergenceKind
  declare resolution: DivergenceResolution | null

  @jsonColumn('fleet_value')
  declare fleetValue: unknown

  @jsonColumn('ap_value')
  declare apValue: unknown

  @jsonColumn('router_author')
  declare routerAuthor: RouterAuthor | null
}
