import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Fleet rollouts (docs/design/wifi controller.md section 6): a change goes
 * to the APs one at a time, in `ap_order`, stopping at the first failure.
 *
 * - `kind` change | radios | catch_up | revert | adopt | rejoin;
 *   `state` running | paused | stopped | completed | cancelled (one running
 *   rollout fleet-wide, enforced in the app).
 * - `confirm_mode` agent | admin_and_agent; `offline_policy` skip | wait.
 * - JSON: `network_ids`, `ap_order`, `stop` {apId, reason, applyId,
 *   message}, `impact` (the preview shown when it started).
 *
 * Also adds the foreign key of `ap_config_applies.rollout_id` (128).
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('wifi_rollouts', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table.string('kind', 12).notNullable()
      table.string('state', 12).notNullable()
      table
        .integer('requested_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.string('system_actor', 16).nullable()
      table.string('note', 500).nullable()
      table.string('confirm_mode', 16).notNullable()
      table.string('offline_policy', 8).notNullable()
      table.text('network_ids').notNullable()
      table.text('ap_order').notNullable()
      table.text('stop').nullable()
      table.text('impact', 'mediumtext').nullable()
      table.datetime('created_at').notNullable()
      table.datetime('finished_at').nullable()

      table.index(['state'], 'wifi_rollouts_state_idx')
    })

    this.schema.alterTable('ap_config_applies', (table) => {
      table
        .foreign('rollout_id', 'ap_config_applies_rollout_fk')
        .references('id')
        .inTable('wifi_rollouts')
        .onDelete('SET NULL')
    })
  }

  async down() {
    this.schema.alterTable('ap_config_applies', (table) => {
      table.dropForeign(['rollout_id'], 'ap_config_applies_rollout_fk')
    })
    this.schema.dropTable('wifi_rollouts')
  }
}
