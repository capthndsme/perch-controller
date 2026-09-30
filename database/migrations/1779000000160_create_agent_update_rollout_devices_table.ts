import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Agent updates (docs/design/agent-updates/controller.md section 2.6): the
 * devices of a rollout in order (the canary is position 0) and how far each
 * got. Exactly one of `ap_id` / `collector_id` is set; a device row goes with
 * its device (CASCADE), the job it ran survives (SET NULL keeps the job).
 *
 * Not in the design's table: `device_name` (snapshot for the rollout view),
 * `detail` (why a device failed or was skipped, in words) and `updated_at`.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('agent_update_rollout_devices', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('rollout_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('agent_update_rollouts')
        .onDelete('CASCADE')
      table
        .integer('ap_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('wifi_access_points')
        .onDelete('CASCADE')
      table
        .integer('collector_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('collectors')
        .onDelete('CASCADE')
      table.string('device_name', 120).notNullable()
      table.smallint('position').unsigned().notNullable()
      table.boolean('is_canary').notNullable().defaultTo(false)
      table.string('state', 16).notNullable()
      table.string('skip_reason', 48).nullable()
      table.string('detail', 500).nullable()
      table
        .bigInteger('job_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('agent_update_jobs')
        .onDelete('SET NULL')
      table.datetime('offline_since').nullable()
      table.datetime('updated_at').notNullable()

      table.unique(['rollout_id', 'ap_id'], 'agent_update_rollout_devices_ap_unique_idx')
      table.unique(
        ['rollout_id', 'collector_id'],
        'agent_update_rollout_devices_collector_unique_idx'
      )
      table.index(['rollout_id', 'position'], 'agent_update_rollout_devices_position_idx')
    })
  }

  async down() {
    this.schema.dropTable('agent_update_rollout_devices')
  }
}
