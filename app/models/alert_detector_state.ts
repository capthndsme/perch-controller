import { BaseModel, column } from '@adonisjs/lucid/orm'
import type { DateTime } from 'luxon'

/**
 * One key of a detector's state (`alert_detector_states`, primary key
 * `(detector, state_key)`). Lucid models have a single primary key, so reads
 * and writes go through `app/services/alerts/detector_context.ts` (query
 * builder, upsert); this class exists for typed reads.
 */
export default class AlertDetectorState extends BaseModel {
  static table = 'alert_detector_states'

  @column({ isPrimary: true })
  declare detector: string

  @column()
  declare stateKey: string

  /** JSON text. */
  @column()
  declare value: string

  @column.dateTime()
  declare updatedAt: DateTime | null
}
