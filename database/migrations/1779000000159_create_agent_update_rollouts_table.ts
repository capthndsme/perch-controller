import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Agent updates (docs/design/agent-updates/controller.md section 2.5): a staged
 * update of many devices of one product to one release: canary → observe →
 * batches → completed, paused on a failure, by an admin or when the release
 * is withdrawn.
 *
 * Differences from the design's table:
 * - `release_id` is SET NULL (like `agent_update_jobs.release_id`): a release
 *   may be deleted once no open rollout uses it; `version` keeps what the
 *   rollout installed.
 * - `accept_unrecoverable`: the rollout request's flag, handed to every job
 *   it starts (a RAM rollback copy without a re-fetch source).
 * - `auto` rollouts are created by auto-update inside the maintenance window.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('agent_update_rollouts', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table.string('product', 32).notNullable()
      table
        .integer('release_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('agent_releases')
        .onDelete('SET NULL')
      table.string('version', 64).notNullable()
      table.string('state', 16).notNullable()
      table.string('method', 8).notNullable()
      table.smallint('batch_size').unsigned().notNullable()
      table.integer('batch_gap_seconds').unsigned().notNullable()
      table.integer('canary_observe_minutes').unsigned().notNullable()
      table.integer('offline_wait_minutes').unsigned().notNullable()
      table.boolean('stop_on_failure').notNullable()
      table.boolean('respect_window').notNullable()
      table.boolean('auto').notNullable().defaultTo(false)
      table.boolean('accept_unrecoverable').notNullable().defaultTo(false)
      table.string('waiting_for', 16).nullable()
      table.string('paused_reason', 48).nullable()
      table.string('paused_detail', 500).nullable()
      table
        .integer('created_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.datetime('created_at').notNullable()
      table.datetime('started_at').nullable()
      table.datetime('canary_confirmed_at').nullable()
      table.datetime('next_action_at').nullable()
      table.datetime('finished_at').nullable()
      table.datetime('updated_at').notNullable()

      table.index(['product', 'state'], 'agent_update_rollouts_product_state_idx')
      table.index(['release_id'], 'agent_update_rollouts_release_idx')
    })
  }

  async down() {
    this.schema.dropTable('agent_update_rollouts')
  }
}
