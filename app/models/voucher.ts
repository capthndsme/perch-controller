import { VoucherSchema } from '#database/schema'
import encryption from '@adonisjs/core/services/encryption'
import { column } from '@adonisjs/lucid/orm'

/**
 * One voucher (docs/gateway/portal.md section 4.1). `codeHash` is the HMAC
 * of the normalized code under the APP_KEY-derived lookup key
 * (`hashVoucherCode`); `code` is the same code encrypted with APP_KEY, for
 * reprints and for computing a gateway's offline verifiers. Both depend on
 * APP_KEY: after a rotation `code` reads null and the hash no longer matches
 * what guests type (`codes_unrecoverable`). Neither is ever serialized.
 */
export default class Voucher extends VoucherSchema {
  @column({ serializeAs: null })
  declare codeHash: string

  @column({
    columnName: 'code_encrypted',
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
  declare code: string | null
}
