import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Sell Mode, desk sales (docs/gateway/portal.md section 15):
 *
 * - `portals.desk`: the desk method's settings (desk price table, code
 *   length), JSON. Whether desk sales are on stays in `portals.methods`.
 * - `hotspot_checkouts.channel`: `coin` (a router checkout, section 14) or
 *   `desk` (sold by hand in Sell Mode); `seller_user_id` = who sold it.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('portals', (table) => {
      table.text('desk').nullable()
    })
    this.schema.alterTable('hotspot_checkouts', (table) => {
      table.string('channel', 8).notNullable().defaultTo('coin')
      table
        .integer('seller_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.index(['seller_user_id', 'created_at'], 'hotspot_checkouts_seller_time_idx')
    })
  }

  async down() {
    this.schema.alterTable('hotspot_checkouts', (table) => {
      table.dropForeign(['seller_user_id'])
      table.dropIndex(['seller_user_id', 'created_at'], 'hotspot_checkouts_seller_time_idx')
      table.dropColumn('seller_user_id')
      table.dropColumn('channel')
    })
    this.schema.alterTable('portals', (table) => {
      table.dropColumn('desk')
    })
  }
}
