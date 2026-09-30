import { jsonColumn } from '#models/json_column'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import type { DateTime } from 'luxon'

export type WebhookFormat = 'standard' | 'ntfy' | 'gotify' | 'discord' | 'slack' | 'telegram'
export type WebhookState = 'active' | 'failing' | 'needs_secret'

/**
 * A webhook destination (docs/design/alerts/delivery.md §2). The encrypted
 * columns hold APP_KEY ciphertext as stored: the webhooks service decrypts
 * them at send time (and marks the row `needs_secret` when it cannot). None
 * of them is ever serialized.
 */
export default class AlertWebhook extends BaseModel {
  static table = 'alert_webhooks'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare name: string

  @column()
  declare format: WebhookFormat

  @column()
  declare preset: string | null

  @column({ serializeAs: null })
  declare urlEncrypted: string

  @column()
  declare urlDisplay: string

  @column({ serializeAs: null })
  declare secretEncrypted: string | null

  @column({ serializeAs: null })
  declare authEncrypted: string | null

  @jsonColumn('options')
  declare options: Record<string, unknown> | null

  /** `Filters` (api.md §2), JSON. */
  @jsonColumn('filters')
  declare filters: Record<string, unknown> | null

  @column()
  declare detail: 'full' | 'minimal'

  @column({ consume: (v) => Boolean(v) })
  declare respectQuietHours: boolean

  @column({ consume: (v) => Boolean(v) })
  declare enabled: boolean

  @column()
  declare state: WebhookState

  @column()
  declare consecutiveFailures: number

  @column.dateTime()
  declare lastSuccessAt: DateTime | null

  @column.dateTime()
  declare lastFailureAt: DateTime | null

  @column()
  declare lastError: string | null

  @column()
  declare createdByUserId: number | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
