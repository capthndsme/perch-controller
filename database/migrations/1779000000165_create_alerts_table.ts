import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Alerts (docs/design/alerts/README.md §3): one row per alert. A condition
 * (`pending → active → resolved`) holds for a while and is raised and
 * cleared; a notice (`posted`) is something that happened.
 *
 * `active_key` = `dedupe_key` while the alert is pending or active, NULL
 * otherwise: the UNIQUE index keeps one live alert per key (InnoDB allows
 * many NULLs). Subjects are soft references (`subject_kind`, `subject_ref`,
 * a `subject_label` snapshot), never foreign keys, so deleting or merging a
 * subject leaves its history readable. `raised_at` is the start of the
 * current (or last) episode, which the "was down 14:02–14:09" texts use.
 * Times are UTC.
 */
export default class extends BaseSchema {
  protected tableName = 'alerts'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table.string('type', 64).notNullable()
      table.string('category', 24).notNullable()
      table.enum('kind', ['condition', 'notice']).notNullable()
      table.enum('state', ['pending', 'active', 'resolved', 'posted']).notNullable()
      table.enum('severity', ['info', 'warning', 'critical']).notNullable()
      table.string('dedupe_key', 191).notNullable()
      table.string('active_key', 191).nullable()
      table.string('subject_kind', 16).notNullable()
      table.string('subject_ref', 64).notNullable().defaultTo('')
      table.string('subject_label', 160).nullable()
      table.string('title', 200).notNullable().defaultTo('')
      table.string('body', 600).notNullable().defaultTo('')
      table.string('path', 255).nullable()
      table.text('payload').nullable()
      table.datetime('first_raised_at').notNullable()
      table.datetime('raised_at').notNullable()
      table.datetime('last_event_at').notNullable()
      table.datetime('opened_at').nullable()
      table.datetime('resolved_at').nullable()
      table.datetime('notify_at').nullable()
      table.datetime('last_transition_at').nullable()
      table.datetime('next_reminder_at').nullable()
      table.datetime('recovery_due_at').nullable()
      table.boolean('quiet_resolve').notNullable().defaultTo(false)
      table.integer('event_count').unsigned().notNullable().defaultTo(0)
      table.integer('transitions').unsigned().notNullable().defaultTo(0)
      table.boolean('flapping').notNullable().defaultTo(false)
      table.boolean('muted').notNullable().defaultTo(false)
      table.boolean('notified').notNullable().defaultTo(false)
      table.datetime('bumped_at').notNullable()
      table.datetime('acknowledged_at').nullable()
      table
        .integer('acknowledged_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.string('ack_note', 300).nullable()
      table
        .integer('resolved_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.unique(['active_key'], 'alerts_active_key_unique')
      table.index(['state', 'severity'], 'alerts_state_severity_idx')
      table.index(['bumped_at', 'id'], 'alerts_bumped_idx')
      table.index(['type', 'first_raised_at'], 'alerts_type_time_idx')
      table.index(['subject_kind', 'subject_ref'], 'alerts_subject_idx')
      table.index(['dedupe_key', 'last_transition_at'], 'alerts_dedupe_transition_idx')
      table.index(['notify_at'], 'alerts_notify_at_idx')
      table.index(['recovery_due_at'], 'alerts_recovery_due_idx')
      table.index(['next_reminder_at'], 'alerts_next_reminder_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
