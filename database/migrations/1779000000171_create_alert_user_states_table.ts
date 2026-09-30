import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Per-user inbox state (docs/design/alerts/README.md §2.3): an alert is
 * unread for a user when its `bumped_at` is later than the user's `read_at`.
 */
export default class extends BaseSchema {
  protected tableName = 'alert_user_states'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.collate('utf8mb4_unicode_ci')

      table
        .integer('user_id')
        .unsigned()
        .notNullable()
        .primary()
        .references('id')
        .inTable('users')
        .onDelete('CASCADE')
      table.datetime('read_at').nullable()
      table.datetime('updated_at').nullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
