import { BaseModel, column } from '@adonisjs/lucid/orm'
import type { DateTime } from 'luxon'

/** One try of a delivery. */
export default class AlertDeliveryAttempt extends BaseModel {
  static table = 'alert_delivery_attempts'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare deliveryId: number

  @column.dateTime()
  declare attemptedAt: DateTime

  @column()
  declare durationMs: number

  @column()
  declare statusCode: number | null

  @column()
  declare outcome: 'sent' | 'retry' | 'failed'

  @column()
  declare error: string | null

  @column()
  declare responseExcerpt: string | null
}
