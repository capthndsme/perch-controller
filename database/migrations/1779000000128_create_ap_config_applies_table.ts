import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * One AP job (docs/design/wifi controller.md sections 2 and 4.3): the columns
 * of `gateway_applies` (with the later 051/110 additions) with `ap_id`;
 * `kind` apply | revert | adopt (no package jobs, no post actions), plus:
 *
 * - `health` (JSON) and `health_checked_at`: the AP's health check
 *   (protocol.md section 4) as the last confirm attempt or result reported it;
 * - `cac_allowance_seconds`: radar-check time added to the window;
 * - `sealed`: passphrases travelled sealed (paired plain HTTP, decision D3);
 * - `rollout_id`: the fleet rollout the job belongs to (its foreign key to
 *   `wifi_rollouts` is added by migration 135, which creates that table).
 *
 * Also adds the foreign key of `ap_config_revisions.apply_id` (127).
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('ap_config_applies', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table
        .integer('ap_id')
        .unsigned()
        .notNullable()
        .references('ap_id')
        .inTable('ap_configs')
        .onDelete('CASCADE')
      table.string('apply_key', 40).notNullable()
      // apply | revert | adopt
      table.string('kind', 8).notNullable()
      // queued | sending | pending_confirm | confirmed | rolled_back | failed | expired | cancelled
      table.string('state', 16).notNullable()
      table.text('ops', 'mediumtext').notNullable()
      table.text('base_hashes').notNullable()
      table.text('perch_ids').notNullable()
      table.boolean('protected').notNullable().defaultTo(false)
      // agent | admin_and_agent
      table.string('confirm_mode', 16).notNullable()
      table.smallint('confirm_timeout_seconds').unsigned().notNullable()
      table
        .integer('requested_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.string('system_actor', 16).nullable()
      table.string('note', 500).nullable()
      table.datetime('requested_at').notNullable()
      table.datetime('sent_at').nullable()
      table.datetime('deadline_at').nullable()
      table.datetime('agent_reconnected_at').nullable()
      table.datetime('agent_confirmed_at').nullable()
      table.datetime('admin_confirmed_at').nullable()
      table
        .integer('admin_confirmed_by')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.datetime('finished_at').nullable()
      table.datetime('queue_expires_at').nullable()
      table.text('outcome').nullable()
      table.text('replaced_router_content', 'mediumtext').nullable()
      table.integer('revision_number').unsigned().nullable()
      table.text('written', 'mediumtext').nullable()
      table.text('ledger').nullable()
      table.text('secret_refs').nullable()
      table.text('configs').nullable()
      table.text('changes', 'mediumtext').nullable()
      table.text('chain_perch_ids').nullable()
      table.smallint('chain_step').unsigned().notNullable().defaultTo(0)
      table.boolean('retried').notNullable().defaultTo(false)
      table.boolean('signed').notNullable().defaultTo(false)
      table.text('health').nullable()
      table.datetime('health_checked_at').nullable()
      table.smallint('cac_allowance_seconds').unsigned().notNullable().defaultTo(0)
      table.boolean('sealed').notNullable().defaultTo(false)
      table.bigInteger('rollout_id').unsigned().nullable()

      table.unique(['apply_key'], 'ap_config_applies_apply_key_unique_idx')
      table.index(['ap_id', 'state'], 'ap_config_applies_ap_state_idx')
      table.index(['rollout_id'], 'ap_config_applies_rollout_idx')
    })

    this.schema.alterTable('ap_config_revisions', (table) => {
      table
        .foreign('apply_id', 'ap_config_revisions_apply_fk')
        .references('id')
        .inTable('ap_config_applies')
        .onDelete('SET NULL')
    })
  }

  async down() {
    this.schema.alterTable('ap_config_revisions', (table) => {
      table.dropForeign(['apply_id'], 'ap_config_revisions_apply_fk')
    })
    this.schema.dropTable('ap_config_applies')
  }
}
