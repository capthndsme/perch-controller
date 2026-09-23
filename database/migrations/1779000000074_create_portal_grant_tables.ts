import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Grants and sessions (docs/gateway/portal.md sections 4.2 and 5).
 *
 * - `portal_grants`: one MAC authorized on one portal. `group_key`
 *   (`v:<voucherId>`, `u:<portalUserId>`, `g:<grantId>`) names the group
 *   whose limits apply; a `g:` group's limits are this row's own
 *   (`duration_mode`, `expires_at`, `time_budget_seconds`, `quota_bytes`,
 *   `down_kbps`, `up_kbps`); for `u:` grants `expires_at` is the login's
 *   deadline. `state` queued | pending_device | active | paused | ended,
 *   `delivery` applied | pending (router acknowledged `revision` or not).
 *   Counters are cumulative for the grant; `time_used_seconds` is the
 *   active time charged to it. `local_ref` is the router's reference of a
 *   grant it created during an offline redemption (unique per portal).
 *   `external_ref`: the API client's idempotency key.
 * - `portal_sessions`: one row per stretch the device was active; bytes are
 *   the grant's counters at the end minus `start_bytes_*`.
 *
 * MAC columns are CHAR(17) lower-case; joins with the Wi-Fi tables (other
 * collation) happen in JS or with an explicit COLLATE.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('portal_grants', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table
        .integer('portal_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('portals')
        .onDelete('CASCADE')
      table.specificType('mac', 'CHAR(17)').notNullable()
      table.string('ip', 45).nullable()
      table.string('hostname', 255).nullable()
      table.string('source', 12).notNullable()
      table.string('group_key', 24).notNullable()
      table
        .integer('voucher_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('vouchers')
        .onDelete('SET NULL')
      table
        .integer('portal_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('portal_users')
        .onDelete('SET NULL')
      table
        .integer('api_client_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('portal_api_clients')
        .onDelete('SET NULL')
      table
        .integer('created_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.string('external_ref', 64).nullable()
      table.string('local_ref', 64).nullable()
      table.string('duration_mode', 16).notNullable().defaultTo('wall_clock')
      table.datetime('started_at').nullable()
      table.datetime('expires_at').nullable()
      table.integer('time_budget_seconds').unsigned().nullable()
      table.integer('time_used_seconds').unsigned().notNullable().defaultTo(0)
      table.bigInteger('quota_bytes').unsigned().nullable()
      table.bigInteger('bytes_up').unsigned().notNullable().defaultTo(0)
      table.bigInteger('bytes_down').unsigned().notNullable().defaultTo(0)
      table.integer('down_kbps').unsigned().nullable()
      table.integer('up_kbps').unsigned().nullable()
      table.string('state', 16).notNullable()
      table.string('delivery', 8).notNullable().defaultTo('pending')
      table.integer('revision').unsigned().notNullable().defaultTo(1)
      table.datetime('last_seen_at').nullable()
      table.datetime('ended_at').nullable()
      table.string('end_reason', 24).nullable()
      table.string('note', 200).nullable()
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.index(['portal_id', 'state'], 'portal_grants_portal_state_idx')
      table.index(['mac'], 'portal_grants_mac_idx')
      table.index(['voucher_id'], 'portal_grants_voucher_idx')
      table.index(['state', 'ended_at'], 'portal_grants_state_ended_idx')
      table.unique(['api_client_id', 'external_ref'], 'portal_grants_client_ref_unique_idx')
      table.unique(['portal_id', 'local_ref'], 'portal_grants_portal_local_ref_unique_idx')
    })

    this.schema.createTable('portal_sessions', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table
        .bigInteger('grant_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('portal_grants')
        .onDelete('CASCADE')
      table
        .integer('portal_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('portals')
        .onDelete('CASCADE')
      table.specificType('mac', 'CHAR(17)').notNullable()
      table.string('ip', 45).nullable()
      table.datetime('started_at').notNullable()
      table.datetime('ended_at').nullable()
      table.bigInteger('start_bytes_up').unsigned().notNullable().defaultTo(0)
      table.bigInteger('start_bytes_down').unsigned().notNullable().defaultTo(0)
      table.bigInteger('bytes_up').unsigned().notNullable().defaultTo(0)
      table.bigInteger('bytes_down').unsigned().notNullable().defaultTo(0)
      table.string('end_reason', 24).nullable()

      table.index(['grant_id', 'ended_at'], 'portal_sessions_grant_open_idx')
      table.index(['portal_id', 'started_at'], 'portal_sessions_portal_time_idx')
      table.index(['mac'], 'portal_sessions_mac_idx')
      table.index(['ended_at'], 'portal_sessions_ended_idx')
    })
  }

  async down() {
    this.schema.dropTable('portal_sessions')
    this.schema.dropTable('portal_grants')
  }
}
