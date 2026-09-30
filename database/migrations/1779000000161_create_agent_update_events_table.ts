import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Agent updates (docs/design/agent-updates/controller.md section 2.7): the
 * audit trail, like `gateway_config_events`: who did what (a user or
 * `system_actor`), and what the device did. Event names are README section
 * 16's `agent_update.*` plus the audit-only ones (`job_created`,
 * `release_imported`, …). Pruned after the `historyDays` setting.
 *
 * `rollout_id` gets its foreign key in migration 162 (`agent_update_rollouts`
 * is 159).
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('agent_update_events', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table.datetime('created_at').notNullable()
      table.string('event', 48).notNullable()
      table.string('severity', 8).notNullable()
      table
        .integer('ap_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('wifi_access_points')
        .onDelete('SET NULL')
      table
        .integer('collector_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('collectors')
        .onDelete('SET NULL')
      table.string('device_name', 120).nullable()
      table
        .bigInteger('job_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('agent_update_jobs')
        .onDelete('SET NULL')
      table.integer('rollout_id').unsigned().nullable()
      table
        .integer('release_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('agent_releases')
        .onDelete('SET NULL')
      table
        .integer('user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.string('system_actor', 32).nullable()
      table.text('detail').nullable()

      table.index(['created_at'], 'agent_update_events_created_idx')
      table.index(['ap_id', 'created_at'], 'agent_update_events_ap_created_idx')
      table.index(['collector_id', 'created_at'], 'agent_update_events_collector_created_idx')
      table.index(['job_id'], 'agent_update_events_job_idx')
      table.index(['rollout_id'], 'agent_update_events_rollout_idx')
    })
  }

  async down() {
    this.schema.dropTable('agent_update_events')
  }
}
