import { PortalTemplateFileSchema } from '#database/schema'
import { column } from '@adonisjs/lucid/orm'

/** One file of a portal template. `content` is never serialized. */
export default class PortalTemplateFile extends PortalTemplateFileSchema {
  @column({ serializeAs: null })
  declare content: Buffer
}
