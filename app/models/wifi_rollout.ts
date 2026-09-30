import { WifiRolloutSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'
import type { ConfirmMode } from '#services/gateway_config/types'
import type {
  ImpactPreview,
  OfflinePolicy,
  RolloutKind,
  RolloutState,
  RolloutStop,
} from '#services/wifi_config/types'

/**
 * A fleet rollout (docs/design/wifi controller.md section 6): one AP at a
 * time in `apOrder`, stopping at the first failure (`stop`).
 */
export default class WifiRollout extends WifiRolloutSchema {
  declare kind: RolloutKind
  declare state: RolloutState
  declare confirmMode: ConfirmMode
  declare offlinePolicy: OfflinePolicy

  @jsonColumn('network_ids')
  declare networkIds: number[]

  @jsonColumn('ap_order')
  declare apOrder: number[]

  @jsonColumn('stop')
  declare stop: RolloutStop | null

  @jsonColumn('impact')
  declare impact: ImpactPreview | null
}
