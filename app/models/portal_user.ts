import { PortalUserSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'
import hash from '@adonisjs/core/services/hash'
import { beforeSave, column } from '@adonisjs/lucid/orm'

/**
 * A portal login (docs/gateway/portal.md section 5): never a controller
 * user. `password` is assigned in plain text and stored as a scrypt hash
 * (hashed on save); it is never serialized. `portalIds` null = every portal.
 */
export default class PortalUser extends PortalUserSchema {
  @column({ serializeAs: null })
  declare password: string

  @jsonColumn('portal_ids')
  declare portalIds: number[] | null

  @beforeSave()
  static async hashPassword(user: PortalUser) {
    if (user.$dirty.password) user.password = await hash.make(user.password)
  }

  async verifyPassword(plain: string): Promise<boolean> {
    return hash.verify(this.password, plain)
  }
}
