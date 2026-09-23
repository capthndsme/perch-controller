import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Perch-only metadata of the per-device WAN block (docs/gateway/firewall.md
 * section 5; plan 2 section 4.3). The block itself is UCI: the MAC in the
 * `perch_block_wan` ipset's `entry` list. This table says who blocked it,
 * when and why, and the last conntrack flush's outcome; a MAC added to the
 * set in LuCI is blocked without a row here.
 */
export default class extends BaseSchema {
  protected tableName = 'gateway_wan_blocks'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('gateway_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('gateways')
        .onDelete('CASCADE')
      table.string('mac', 17).notNullable()
      table.datetime('blocked_at').notNullable()
      table
        .integer('blocked_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.string('note', 200).nullable()
      table.text('last_flush').nullable()
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.unique(['gateway_id', 'mac'], 'gateway_wan_blocks_gateway_mac_unique_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
