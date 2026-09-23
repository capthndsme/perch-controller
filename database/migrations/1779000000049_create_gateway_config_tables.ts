import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The config plane's state (docs/gateway/config-plane.md sections 2, 5, 9).
 *
 * - `gateway_sections`: one row per UCI section the controller knows on the
 *   router. For synced sections: `base_content` (B, last content both sides
 *   agreed on), `router_content` (R, last read) and `desired_content` (C, what
 *   the controller wants), all canonical JSON `{type, options, secrets?}`, null
 *   = absent. `ownership` (JSON, null = the whole section) is option-level
 *   ownership inside a shared section (README 3.2). `issue` names why a
 *   section cannot be managed (ambiguous identity, no round trip).
 * - `gateway_secrets`: write-only secret values, APP_KEY-encrypted like
 *   `collectors.api_key`; sections carry only `ref` + fingerprint.
 * - `gateway_applies`: one row per apply job (wire `applyId` = `apply_key`).
 *   `protected` marks the management-path job (README 3.8).
 * - `gateway_revisions`: linear history of agreed states. `confirmed_at` is
 *   set once that state is known to work on the router (a confirmed apply, or
 *   a router state a live agent reported); a re-joined gateway is offered the
 *   last confirmed revision, never the newest (README 3.7). Pruned to the
 *   `keepRevisions` setting, always keeping the newest confirmed one.
 * - `gateway_config_events`: audit log (the `wifi_command_audits` shape),
 *   pruned after `auditRetentionDays`.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('gateway_sections', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table
        .integer('gateway_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('gateways')
        .onDelete('CASCADE')
      table.string('perch_id', 24).notNullable()
      table.string('config', 32).notNullable()
      table.string('section_name', 64).notNullable()
      table.string('section_type', 32).notNullable()
      table.boolean('anonymous').notNullable().defaultTo(false)
      // synced | excluded | unmodeled
      table.string('scope', 12).notNullable()
      table.string('domain', 32).nullable()
      table.text('ownership').nullable()
      table.string('issue', 24).nullable()
      table.text('base_content', 'mediumtext').nullable()
      table.integer('base_revision').unsigned().nullable()
      table.text('router_content', 'mediumtext').nullable()
      table.text('router_author').nullable()
      table.datetime('router_changed_at').nullable()
      table.text('desired_content', 'mediumtext').nullable()
      // in_sync | ahead | pending | conflict | drift | reverting
      table.string('status', 12).notNullable().defaultTo('in_sync')
      table.text('conflict').nullable()
      table.datetime('drift_since').nullable()
      table.integer('position').nullable()
      table
        .integer('updated_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.unique(['gateway_id', 'perch_id'], 'gateway_sections_gateway_perch_unique_idx')
      table.unique(
        ['gateway_id', 'config', 'section_name'],
        'gateway_sections_gateway_section_unique_idx'
      )
      table.index(['gateway_id', 'status'], 'gateway_sections_gateway_status_idx')
    })

    this.schema.createTable('gateway_secrets', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('gateway_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('gateways')
        .onDelete('CASCADE')
      table.string('ref', 48).notNullable()
      table.text('value').notNullable()
      table.string('fingerprint', 40).notNullable()
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.unique(['gateway_id', 'ref'], 'gateway_secrets_gateway_ref_unique_idx')
    })

    this.schema.createTable('gateway_applies', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table
        .integer('gateway_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('gateways')
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
      table.string('note', 500).nullable()
      table.datetime('requested_at').notNullable()
      table.datetime('sent_at').nullable()
      table.datetime('deadline_at').nullable()
      table.datetime('agent_reconnected_at').nullable()
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

      table.unique(['apply_key'], 'gateway_applies_apply_key_unique_idx')
      table.index(['gateway_id', 'state'], 'gateway_applies_gateway_state_idx')
    })

    this.schema.createTable('gateway_revisions', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table
        .integer('gateway_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('gateways')
        .onDelete('CASCADE')
      table.integer('number').unsigned().notNullable()
      // import | router | controller | merge | revert | rollback
      table.string('source', 12).notNullable()
      table
        .integer('author_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.text('router_author').nullable()
      table.string('summary', 255).notNullable()
      table.string('note', 500).nullable()
      table.text('snapshot', 'longtext').notNullable()
      table.text('diff', 'mediumtext').notNullable()
      table.text('hashes').notNullable()
      table
        .bigInteger('apply_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('gateway_applies')
        .onDelete('SET NULL')
      table.datetime('confirmed_at').nullable()
      table.datetime('created_at').notNullable()

      table.unique(['gateway_id', 'number'], 'gateway_revisions_gateway_number_unique_idx')
      table.index(['gateway_id', 'confirmed_at'], 'gateway_revisions_gateway_confirmed_idx')
    })

    this.schema.createTable('gateway_config_events', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table
        .integer('gateway_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('gateways')
        .onDelete('CASCADE')
      table
        .integer('user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table
        .bigInteger('apply_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('gateway_applies')
        .onDelete('SET NULL')
      table.integer('revision_number').unsigned().nullable()
      table.string('event', 32).notNullable()
      table.text('detail').nullable()
      table.datetime('created_at').notNullable()

      table.index(['gateway_id', 'created_at'], 'gateway_config_events_gateway_time_idx')
      table.index(['created_at'], 'gateway_config_events_time_idx')
    })
  }

  async down() {
    this.schema.dropTable('gateway_config_events')
    this.schema.dropTable('gateway_revisions')
    this.schema.dropTable('gateway_applies')
    this.schema.dropTable('gateway_secrets')
    this.schema.dropTable('gateway_sections')
  }
}
