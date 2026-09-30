import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The event log of the alerts engine (docs/design/alerts/README.md §3): every
 * raise, clear and notice it processed, with what it did about it
 * (`outcome`: opened, updated, escalated, reopened, resolved, blip, posted,
 * merged, disabled, unknown_type, invalid_subject, boot_grace, no_active,
 * withheld_mass). Pruned after `retention.eventDays`.
 */
export default class extends BaseSchema {
  protected tableName = 'alert_events'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table.string('type', 64).notNullable()
      table.enum('phase', ['raise', 'clear', 'instant']).notNullable()
      table.enum('severity', ['info', 'warning', 'critical']).notNullable()
      table.string('category', 24).notNullable().defaultTo('')
      table.string('subject_kind', 16).notNullable()
      table.string('subject_ref', 64).notNullable().defaultTo('')
      table.string('dedupe_key', 191).notNullable()
      table.text('payload').nullable()
      table.string('source', 48).nullable()
      table.datetime('occurred_at').notNullable()
      table.datetime('recorded_at').notNullable()
      table
        .bigInteger('alert_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('alerts')
        .onDelete('SET NULL')
      table.string('outcome', 24).notNullable()

      table.index(['occurred_at'], 'alert_events_occurred_idx')
      table.index(['dedupe_key', 'occurred_at'], 'alert_events_dedupe_idx')
      table.index(['alert_id'], 'alert_events_alert_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
