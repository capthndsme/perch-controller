import { GatewayBackupSchema } from '#database/schema'
import { column } from '@adonisjs/lucid/orm'

/**
 * A `sysupgrade -b` archive pulled from the router (`gateway.backup`,
 * docs/gateway/observation.md). `content` is encrypted with the app key and
 * is only ever decrypted for an admin download. Written by
 * `app/services/gateway_backups.ts`.
 */
export default class GatewayBackup extends GatewayBackupSchema {
  /** The default naming strategy would read `sha_256`. */
  @column({ columnName: 'sha256' })
  declare sha256: string
}
