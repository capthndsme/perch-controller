import { BaseModel, column } from '@adonisjs/lucid/orm'
import type { DateTime } from 'luxon'

/** A user's inbox read marker: alerts bumped after `readAt` are unread for them. */
export default class AlertUserState extends BaseModel {
  static table = 'alert_user_states'

  @column({ isPrimary: true })
  declare userId: number

  @column.dateTime()
  declare readAt: DateTime | null

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
