import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Vouchers (docs/gateway/portal.md sections 4.1 and 5).
 *
 * - `voucher_batches`: the limits every voucher of the batch shares.
 *   `portal_id` null = valid on any portal until first redeemed; such
 *   vouchers are never handed to a gateway for offline redemption.
 * - `vouchers`: `code_hash` = HMAC-SHA256 of the normalized code under the
 *   APP_KEY-derived lookup key (never a plain hash, never APP_KEY itself);
 *   `code_encrypted` = the code encrypted with APP_KEY, for reprint and for
 *   computing a gateway's offline verifiers. `time_used_seconds` /
 *   `bytes_used` are the voucher's totals, which outlive pruned grant rows.
 *   `revision` bumps whenever a fact the router holds changes.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('voucher_batches', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('portal_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('portals')
        .onDelete('CASCADE')
      table.string('name', 80).notNullable()
      table.string('note', 500).nullable()
      table.integer('count').unsigned().notNullable()
      table.smallint('code_length').unsigned().notNullable()
      table.integer('duration_minutes').unsigned().nullable()
      table.string('duration_mode', 16).notNullable().defaultTo('wall_clock')
      table.string('start_mode', 16).notNullable().defaultTo('first_use')
      table.bigInteger('quota_bytes').unsigned().nullable()
      table.integer('down_kbps').unsigned().nullable()
      table.integer('up_kbps').unsigned().nullable()
      table.smallint('max_devices').unsigned().notNullable().defaultTo(1)
      table.datetime('redeem_by').nullable()
      table
        .integer('created_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.datetime('revoked_at').nullable()
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.index(['portal_id'], 'voucher_batches_portal_idx')
    })

    this.schema.createTable('vouchers', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('batch_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('voucher_batches')
        .onDelete('CASCADE')
      table.specificType('code_hash', 'CHAR(64)').notNullable()
      table.text('code_encrypted').notNullable()
      table.specificType('hint', 'CHAR(4)').notNullable()
      table
        .integer('bound_portal_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('portals')
        .onDelete('SET NULL')
      table.datetime('first_used_at').nullable()
      table.datetime('starts_at').nullable()
      table.datetime('expires_at').nullable()
      table.integer('time_used_seconds').unsigned().notNullable().defaultTo(0)
      table.bigInteger('bytes_used').unsigned().notNullable().defaultTo(0)
      table.integer('revision').unsigned().notNullable().defaultTo(1)
      table.datetime('revoked_at').nullable()
      table.datetime('exhausted_at').nullable()
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.unique(['code_hash'], 'vouchers_code_hash_unique_idx')
      table.index(['batch_id'], 'vouchers_batch_idx')
      table.index(['bound_portal_id'], 'vouchers_bound_portal_idx')
    })
  }

  async down() {
    this.schema.dropTable('vouchers')
    this.schema.dropTable('voucher_batches')
  }
}
