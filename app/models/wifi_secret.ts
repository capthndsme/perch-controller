import { WifiSecretSchema } from '#database/schema'
import encryption from '@adonisjs/core/services/encryption'
import { column } from '@adonisjs/lucid/orm'

/**
 * A Wi-Fi passphrase the controller knows (docs/design/wifi controller.md
 * section 4.4): write-only in the API (revealing is its own audited admin
 * route), AES-encrypted at rest with APP_KEY, sent to an AP only inside an
 * apply over verified TLS or sealed on a paired session. Networks reference
 * it by `ref`; APs compare it by the unbound `fingerprint`; the PSK guard by
 * `digest`.
 */
export default class WifiSecret extends WifiSecretSchema {
  @column({
    columnName: 'value',
    serializeAs: null,
    prepare: (value: string | null) => (value ? encryption.encrypt(value) : null),
    consume: (value: string | null) => {
      if (!value) return null
      try {
        return encryption.decrypt<string>(value) ?? null
      } catch {
        return null
      }
    },
  })
  declare value: string | null
}
