import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Operator-supplied identity for a device: a personal name, a device type
 * from a fixed taxonomy, free-form tags and notes.
 *
 * Keyed by MAC **alone**, not by (collector, mac) like `device_identities`:
 * a name is a property of the thing on the network, not of the collector
 * that happened to see it, and it must survive a collector being deleted
 * and re-registered (identity rows CASCADE with the collector).
 */
export default class extends BaseSchema {
  protected tableName = 'device_labels'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.bigIncrements('id').notNullable()

      table.string('mac', 17).notNullable()
      table.string('name', 80).nullable()
      table.string('device_type', 32).nullable()
      /** JSON array of normalized tag strings. */
      table.text('tags').nullable()
      table.text('notes').nullable()

      table
        .integer('updated_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.unique(['mac'], 'device_labels_mac_unique_idx')
      table.index(['device_type'], 'device_labels_device_type_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
