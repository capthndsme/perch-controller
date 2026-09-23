import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Decision 31: a portal user may belong to a device group; signing in then
 * binds the device to that group (docs/gateway/device-groups.md section 6).
 */
export default class extends BaseSchema {
  protected tableName = 'portal_users'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table
        .integer('device_group_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('device_groups')
        .onDelete('SET NULL')
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropForeign(['device_group_id'])
      table.dropColumn('device_group_id')
    })
  }
}
