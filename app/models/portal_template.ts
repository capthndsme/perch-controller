import { PortalTemplateSchema } from '#database/schema'
import { column } from '@adonisjs/lucid/orm'

/**
 * A set of portal page files (docs/gateway/portal.md section 9). `builtin`
 * rows are read-only; the seeded one has no files and stands for the pages
 * compiled into the collector.
 */
export default class PortalTemplate extends PortalTemplateSchema {
  /** The naming strategy would read `sha256` as `sha_256`. */
  @column({ columnName: 'sha256' })
  declare sha256: string
}
