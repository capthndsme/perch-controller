import { WifiNetworkApSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'
import type { NetworkOverrides, RadioOverrides, WifiBand } from '#services/wifi_config/types'

/**
 * A network's membership of one AP (docs/design/wifi controller.md section
 * 5.1): `included` null = follow the network's scope.
 */
export default class WifiNetworkAp extends WifiNetworkApSchema {
  @jsonColumn('bands')
  declare bands: WifiBand[] | null

  @jsonColumn('radios')
  declare radios: string[] | null

  @jsonColumn('overrides')
  declare overrides: NetworkOverrides | null

  @jsonColumn('radio_overrides')
  declare radioOverrides: RadioOverrides | null
}
