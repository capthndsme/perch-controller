import { WifiRolloutStepSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'
import type { RolloutStepState } from '#services/wifi_config/types'

export type RolloutStepOutcome = { reason?: string; error?: string; message?: string }

/** One AP's step of a rollout (docs/design/wifi controller.md section 6.4). */
export default class WifiRolloutStep extends WifiRolloutStepSchema {
  declare state: RolloutStepState

  @jsonColumn('perch_ids')
  declare perchIds: string[]

  @jsonColumn('outcome')
  declare outcome: RolloutStepOutcome | null
}
