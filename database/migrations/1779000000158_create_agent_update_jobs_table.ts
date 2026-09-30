import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Agent updates (docs/design/agent-updates/controller.md section 2.4): one row
 * per update or rollback of one device.
 *
 * - `update_key` is the wire `updateId` (`u-` + 16 hex).
 * - `active_key` (`ap:4`, `collector:1`) is set while the job is open and
 *   NULL once it is final: the unique index allows one open job per device
 *   (MariaDB allows many NULLs in a unique index).
 * - Devices are SET NULL on delete: the history outlives them
 *   (`device_name` is a snapshot).
 * - `release_id` is SET NULL rather than the design's RESTRICT: a release may
 *   be deleted once nothing open uses it; a final job keeps `to_version`.
 * - `rollout_id` gets its foreign key in migration 162, after
 *   `agent_update_rollouts` (159) exists.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('agent_update_jobs', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table.specificType('update_key', 'char(18)').notNullable()
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
      table.string('active_key', 24).nullable()
      table.string('device_name', 120).notNullable()
      table.string('product', 32).notNullable()
      table.integer('rollout_id').unsigned().nullable()
      table
        .integer('release_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('agent_releases')
        .onDelete('SET NULL')
      table.string('source', 8).notNullable()
      table.string('from_version', 64).notNullable()
      table.string('to_version', 64).notNullable()
      table.string('method', 8).notNullable()
      table.string('rollback_store', 8).nullable()
      table.string('state', 24).notNullable()
      table.string('reason', 48).nullable()
      table.string('detail', 1000).nullable()
      table.text('preflight').nullable()
      table.bigInteger('progress_bytes').unsigned().nullable()
      table.bigInteger('progress_total').unsigned().nullable()
      table.boolean('accept_unrecoverable').notNullable().defaultTo(false)
      table.boolean('respect_window').notNullable().defaultTo(false)
      table.tinyint('restage_count').unsigned().notNullable().defaultTo(0)
      table
        .integer('requested_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.string('system_actor', 32).nullable()
      table.datetime('created_at').notNullable()
      table.datetime('not_before').nullable()
      table.datetime('staged_at').nullable()
      table.datetime('install_sent_at').nullable()
      table.datetime('deadline_at').nullable()
      table.datetime('reconnected_at').nullable()
      table.datetime('confirmed_at').nullable()
      table.datetime('finished_at').nullable()
      table.datetime('updated_at').notNullable()
      table.datetime('candidate_connected_at').nullable()
      table.smallint('pushes_seen').unsigned().notNullable().defaultTo(0)

      table.unique(['update_key'], 'agent_update_jobs_update_key_unique_idx')
      table.unique(['active_key'], 'agent_update_jobs_active_key_unique_idx')
      table.index(['ap_id', 'created_at'], 'agent_update_jobs_ap_created_idx')
      table.index(['collector_id', 'created_at'], 'agent_update_jobs_collector_created_idx')
      table.index(['state'], 'agent_update_jobs_state_idx')
      table.index(['rollout_id'], 'agent_update_jobs_rollout_idx')
    })
  }

  async down() {
    this.schema.dropTable('agent_update_jobs')
  }
}
