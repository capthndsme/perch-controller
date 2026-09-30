import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Watched devices (docs/design/alerts/events.md §3.5): `offline` raises
 * `device.offline`, `arrival` posts `device.arrived`. One row per device and
 * mode. MACs are lowercase colon form; joins with other MAC columns happen
 * in JS (collation note in CLAUDE.md).
 */
export default class extends BaseSchema {
  protected tableName = 'alert_watches'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table.string('subject_kind', 16).notNullable()
      table.string('subject_ref', 64).notNullable()
      table.enum('mode', ['offline', 'arrival']).notNullable()
      table.text('params').nullable()
      table
        .integer('created_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.unique(['subject_kind', 'subject_ref', 'mode'], 'alert_watches_subject_mode_unique')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
