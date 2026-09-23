import { GatewaySecretSchema } from '#database/schema'
import encryption from '@adonisjs/core/services/encryption'
import { column } from '@adonisjs/lucid/orm'

/**
 * A secret option value the controller set (docs/gateway/config-plane.md
 * section 11): write-only in the API, AES-encrypted at rest with APP_KEY
 * (the `collectors.api_key` pattern), sent to the router only inside an
 * apply over a secure session. Sections reference it by `ref` and compare
 * it by `fingerprint` (the router's `hmac:` form).
 */
export default class GatewaySecret extends GatewaySecretSchema {
  @column({
    columnName: 'value',
    serializeAs: null,
    prepare: (value: string | null) => (value ? encryption.encrypt(value) : null),
    consume: (value: string | null) => {
      if (!value) return null
      try {
        return encryption.decrypt<string>(value) ?? null
      } catch {
        // Tampered or pre-APP_KEY-rotation ciphertext: hide rather than crash.
        return null
      }
    },
  })
  declare value: string | null
}
