import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Mutes (docs/design/alerts/README.md §2.3 item 9): at notify time a
 * matching mute (type and/or subject, until a time or forever) marks the
 * alert muted and creates no deliveries. Maintenance windows of other areas
 * (`suppressAlerts`) are rows with `reason = 'maintenance'`.
 */
export default class extends BaseSchema {
  protected tableName = 'alert_mutes'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table.string('type', 64).nullable()
      table.string('subject_kind', 16).nullable()
      table.string('subject_ref', 64).nullable()
      table.datetime('until').nullable()
      table.enum('reason', ['manual', 'maintenance']).notNullable().defaultTo('manual')
      table.string('source', 48).nullable()
      table.string('note', 200).nullable()
      table
        .integer('created_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.datetime('created_at').notNullable()

      table.index(['until'], 'alert_mutes_until_idx')
      table.index(['subject_kind', 'subject_ref'], 'alert_mutes_subject_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
