import { jsonColumn } from '#models/json_column'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import type { DateTime } from 'luxon'

export type PushService = 'fcm' | 'mozilla' | 'apple' | 'wns' | 'other'
export type PushSubscriptionState = 'active' | 'failing' | 'gone'

/**
 * A browser's Web Push subscription (docs/design/alerts/delivery.md §1). The
 * behaviour (upsert, renew, sending) lives in `app/services/alerts/push/`.
 */
export default class AlertPushSubscription extends BaseModel {
  static table = 'alert_push_subscriptions'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare userId: number

  @column({ serializeAs: null })
  declare endpoint: string

  @column()
  declare endpointHash: string

  @column()
  declare pushService: PushService

  @column({ serializeAs: null })
  declare p256dh: string

  @column({ serializeAs: null })
  declare auth: string

  @column()
  declare vapidKeyId: string

  @column.dateTime()
  declare expirationAt: DateTime | null

  @column()
  declare label: string | null

  @column()
  declare platform: string | null

  /** `Filters` (api.md §2), JSON. */
  @jsonColumn('filters')
  declare filters: Record<string, unknown> | null

  @column({ consume: (v) => Boolean(v) })
  declare enabled: boolean

  @column()
  declare state: PushSubscriptionState

  @column()
  declare consecutiveFailures: number

  @column.dateTime()
  declare lastSuccessAt: DateTime | null

  @column.dateTime()
  declare lastFailureAt: DateTime | null

  @column()
  declare lastError: string | null

  @column({ serializeAs: null })
  declare renewTokenHash: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
