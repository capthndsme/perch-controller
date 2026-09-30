import { ApConfigEventSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'

/**
 * Audit log of an AP's Wi-Fi plane (docs/design/wifi controller.md section
 * 2). Pruned after the Wi-Fi setting `auditRetentionDays`.
 */
export default class ApConfigEvent extends ApConfigEventSchema {
  @jsonColumn('detail')
  declare detail: Record<string, unknown> | null
}
