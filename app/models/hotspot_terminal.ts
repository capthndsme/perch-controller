import { HotspotTerminalSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'
import encryption from '@adonisjs/core/services/encryption'
import { column } from '@adonisjs/lucid/orm'

/** The router's last report about a terminal (`portal.terminals`). */
export type HotspotTerminalStatus = {
  online: boolean
  acceptor: string | null
  firmware: string | null
  error: string | null
  checkout: { checkoutRef: string; state: string; amount: number; openedAt: number | null } | null
  at: string
}

/**
 * A coin terminal bound to one portal (docs/gateway/portal.md section 14.3).
 * `tokenHash` (SHA-256) finds and identifies it; `token` is the same token
 * encrypted with APP_KEY, which the router needs to verify the terminal's
 * request signatures (it is the HMAC key). Neither is ever serialized.
 */
export default class HotspotTerminal extends HotspotTerminalSchema {
  @column({ serializeAs: null })
  declare tokenHash: string

  @column({
    columnName: 'token_encrypted',
    serializeAs: null,
    prepare: (value: string) => encryption.encrypt(value),
    consume: (value: string | null) => {
      if (!value) return null
      try {
        return encryption.decrypt<string>(value) ?? null
      } catch {
        return null
      }
    },
  })
  declare token: string | null

  @jsonColumn('status')
  declare status: HotspotTerminalStatus | null
}
