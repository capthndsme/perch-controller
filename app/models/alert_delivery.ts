import { jsonColumn } from '#models/json_column'
import type { DeliveryStatus, Severity, Transition } from '#services/alerts/model'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import type { DateTime } from 'luxon'

/** One notification to one destination (docs/design/alerts/delivery.md §3–5). */
export default class AlertDelivery extends BaseModel {
  static table = 'alert_deliveries'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare alertId: number | null

  @column()
  declare destinationKind: 'push' | 'webhook'

  @column()
  declare pushSubscriptionId: number | null

  @column()
  declare webhookId: number | null

  @column()
  declare transition: Transition

  @column()
  declare status: DeliveryStatus

  @column()
  declare holdReason: 'quiet_hours' | 'rate_limit' | null

  @column()
  declare groupKey: string | null

  /** Alert ids of a group or digest (≤ 50), JSON. */
  @jsonColumn('items')
  declare items: number[] | null

  @column()
  declare messageId: string

  @column()
  declare severity: Severity

  @column()
  declare attempts: number

  @column.dateTime()
  declare sendAfter: DateTime

  @column.dateTime()
  declare nextAttemptAt: DateTime | null

  @column.dateTime()
  declare expiresAt: DateTime

  @column()
  declare lastStatusCode: number | null

  @column()
  declare lastError: string | null

  @column.dateTime()
  declare sentAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
