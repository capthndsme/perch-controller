import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'system_settings'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      // Single-key/value store for instance-wide settings such as `site_name`
      // and `timezone`. Values are JSON-stringified so callers can stash
      // arbitrary scalars/objects without per-key migrations.
      table.string('key', 191).notNullable().primary()
      table.text('value').notNullable()
      table.timestamp('updated_at').notNullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
