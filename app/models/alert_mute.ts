import { BaseModel, column } from '@adonisjs/lucid/orm'
import type { DateTime } from 'luxon'

/** A mute or a maintenance window (docs/design/alerts/README.md §2.3 item 9). */
export default class AlertMute extends BaseModel {
  static table = 'alert_mutes'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare type: string | null

  @column()
  declare subjectKind: string | null

  @column()
  declare subjectRef: string | null

  /** Null = until removed. */
  @column.dateTime()
  declare until: DateTime | null

  @column()
  declare reason: 'manual' | 'maintenance'

  @column()
  declare source: string | null

  @column()
  declare note: string | null

  @column()
  declare createdByUserId: number | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
