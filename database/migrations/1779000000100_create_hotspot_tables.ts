import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Paid Hotspot (docs/gateway/portal.md section 14, owner decision 28).
 *
 * - `hotspot_price_tables`: an operator's rates (amount → minutes / data /
 *   speed tier), `entries` JSON. `revision` bumps on every change and each
 *   revision is kept in `hotspot_price_revisions`: a checkout is priced at
 *   the revision it started under (the router locks it) and the ledger row
 *   copies that revision's snapshot.
 * - `hotspot_terminals`: coin terminals (vending boxes), each bound to one
 *   portal, several per portal. The token (`perch_pt_…`) is the key the
 *   terminal signs its requests with: stored as SHA-256 (lookup, display
 *   prefix) and APP_KEY-encrypted (the router needs it to verify
 *   signatures). `mac` optionally pins the terminal's address. `status` is
 *   the router's last report (JSON).
 * - `hotspot_checkouts`: the payment ledger. One row per finalized checkout
 *   (`kind` payment, keyed by the router's checkout ref) and per coin the
 *   router could not credit (`kind` unclaimed: a late coin, a full checkout,
 *   an amount below the smallest rate). `event_key` makes ingest idempotent
 *   per gateway. `voucher_id` = the voucher minted from the payment (its
 *   reference code) or the one an admin credited for unclaimed coins.
 *   `state`: paid | voided | unclaimed | credited | dismissed. Guest MAC, IP
 *   and host name are cleared after the portal's retention (RA 10173); the
 *   amounts stay.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('hotspot_price_tables', (table) => {
      table.collate('utf8mb4_unicode_ci')
      table.increments('id').notNullable()
      table.string('name', 80).notNullable()
      table.specificType('currency', 'CHAR(3)').notNullable()
      table.smallint('decimals').unsigned().notNullable().defaultTo(0)
      table.string('duration_mode', 16).notNullable().defaultTo('wall_clock')
      table.text('entries').notNullable()
      table.integer('revision').unsigned().notNullable().defaultTo(1)
      table
        .integer('created_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()
    })

    this.schema.createTable('hotspot_price_revisions', (table) => {
      table.collate('utf8mb4_unicode_ci')
      table.increments('id').notNullable()
      table
        .integer('price_table_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('hotspot_price_tables')
        .onDelete('CASCADE')
      table.integer('revision').unsigned().notNullable()
      table.string('name', 80).notNullable()
      table.specificType('currency', 'CHAR(3)').notNullable()
      table.smallint('decimals').unsigned().notNullable()
      table.string('duration_mode', 16).notNullable()
      table.text('entries').notNullable()
      table.datetime('created_at').notNullable()
      table.unique(['price_table_id', 'revision'], 'hotspot_price_revisions_table_rev_unique_idx')
    })

    this.schema.createTable('hotspot_terminals', (table) => {
      table.collate('utf8mb4_unicode_ci')
      table.increments('id').notNullable()
      table
        .integer('portal_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('portals')
        .onDelete('CASCADE')
      table.string('name', 80).notNullable()
      table.string('token_prefix', 16).notNullable()
      table.specificType('token_hash', 'CHAR(64)').notNullable()
      table.text('token_encrypted').notNullable()
      table.specificType('mac', 'CHAR(17)').nullable()
      table.boolean('enabled').notNullable().defaultTo(true)
      table
        .integer('price_table_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('hotspot_price_tables')
        .onDelete('SET NULL')
      table.datetime('last_seen_at').nullable()
      table.text('status').nullable()
      table
        .integer('created_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()
      table.unique(['token_hash'], 'hotspot_terminals_token_hash_unique_idx')
      table.index(['portal_id'], 'hotspot_terminals_portal_idx')
    })

    this.schema.createTable('hotspot_checkouts', (table) => {
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
        .integer('portal_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('portals')
        .onDelete('SET NULL')
      table
        .integer('terminal_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('hotspot_terminals')
        .onDelete('SET NULL')
      table.string('terminal_name', 80).nullable()
      table.string('kind', 12).notNullable()
      table.string('state', 12).notNullable()
      table.string('event_key', 96).notNullable()
      table.string('checkout_ref', 64).nullable()
      table.specificType('mac', 'CHAR(17)').nullable()
      table.string('ip', 45).nullable()
      table.string('hostname', 255).nullable()
      table.bigInteger('amount').unsigned().notNullable()
      table.bigInteger('unused_amount').unsigned().notNullable().defaultTo(0)
      table.specificType('currency', 'CHAR(3)').nullable()
      table.smallint('decimals').unsigned().nullable()
      table.integer('price_table_id').unsigned().nullable()
      table.integer('price_revision').unsigned().nullable()
      table.text('price_snapshot').nullable()
      table.string('duration_mode', 16).nullable()
      table.integer('duration_seconds').unsigned().nullable()
      table.bigInteger('quota_bytes').unsigned().nullable()
      table.integer('down_kbps').unsigned().nullable()
      table.integer('up_kbps').unsigned().nullable()
      table.integer('coin_count').unsigned().notNullable().defaultTo(0)
      table.text('coins').nullable()
      table.string('reason', 16).nullable()
      table.datetime('opened_at').nullable()
      table.datetime('finalized_at').nullable()
      table.integer('key_epoch').unsigned().nullable()
      table.specificType('router_sig', 'CHAR(43)').nullable()
      table
        .integer('voucher_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('vouchers')
        .onDelete('SET NULL')
      table.bigInteger('refund_amount').unsigned().nullable()
      table.string('note', 200).nullable()
      table.datetime('resolved_at').nullable()
      table
        .integer('resolved_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()
      table.unique(['gateway_id', 'event_key'], 'hotspot_checkouts_gateway_event_unique_idx')
      table.index(['portal_id', 'finalized_at'], 'hotspot_checkouts_portal_time_idx')
      table.index(['terminal_id', 'finalized_at'], 'hotspot_checkouts_terminal_time_idx')
      table.index(['state'], 'hotspot_checkouts_state_idx')
      table.index(['mac'], 'hotspot_checkouts_mac_idx')
      table.index(['voucher_id'], 'hotspot_checkouts_voucher_idx')
      table.index(['created_at'], 'hotspot_checkouts_created_idx')
    })
  }

  async down() {
    this.schema.dropTable('hotspot_checkouts')
    this.schema.dropTable('hotspot_terminals')
    this.schema.dropTable('hotspot_price_revisions')
    this.schema.dropTable('hotspot_price_tables')
  }
}
