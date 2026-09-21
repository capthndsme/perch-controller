import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import encryption from '@adonisjs/core/services/encryption'

export const AP_JOIN_TOKEN_STATUSES = ['active', 'expired', 'revoked', 'exhausted'] as const
export type ApJoinTokenStatus = (typeof AP_JOIN_TOKEN_STATUSES)[number]

/**
 * A token an access point trades for Perch AP Daemon credentials at
 * `POST /api/v1/ap-agent/join` (docs/ap-controller.md section 1.1).
 *
 * `token_hash` (SHA-256 hex) is what a join is matched against;
 * `token_encrypted` is the same token encrypted with APP_KEY so an admin can
 * copy the install command again. Neither is ever serialized.
 */
export default class ApJoinToken extends BaseModel {
  static table = 'ap_join_tokens'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare label: string | null

  @column({ serializeAs: null })
  declare tokenHash: string

  @column()
  declare tokenPrefix: string

  @column({
    columnName: 'token_encrypted',
    serializeAs: null,
    prepare: (value: string) => encryption.encrypt(value),
    consume: (value: string | null) => {
      if (!value) return null
      try {
        return encryption.decrypt<string>(value) ?? null
      } catch {
        // APP_KEY rotated since the token was created: it can still be
        // matched by hash, it just cannot be shown again.
        return null
      }
    },
  })
  declare token: string | null

  @column()
  declare createdByUserId: number | null

  @column.dateTime()
  declare expiresAt: DateTime | null

  @column()
  declare maxUses: number | null

  @column()
  declare useCount: number

  @column.dateTime()
  declare lastUsedAt: DateTime | null

  @column.dateTime()
  declare revokedAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null

  /** Revoked beats expired beats used up; anything else can still join. */
  statusAt(now: DateTime = DateTime.utc()): ApJoinTokenStatus {
    if (this.revokedAt) return 'revoked'
    if (this.expiresAt && this.expiresAt <= now) return 'expired'
    if (this.maxUses !== null && this.maxUses !== undefined && this.useCount >= this.maxUses) {
      return 'exhausted'
    }
    return 'active'
  }
}
