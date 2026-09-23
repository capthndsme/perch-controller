import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The persisted order of ordered section types (docs/gateway/firewall.md
 * section 3; config-plane.md section 5.1): firewall `rule` and `redirect`
 * sections are evaluated top to bottom, so their order is part of the state
 * the controller syncs two-way and enforces under Authoritative Mode.
 *
 * One row per (gateway, config, type):
 * - `base_order` (JSON, perch ids): the order both sides last agreed on (B);
 * - `desired_order` (JSON, perch ids): the controller's order (C);
 * - the router's order (R) is not stored: it is the rows' `position`.
 * - `status`: in_sync | ahead | conflict | drift; `conflict` (JSON)
 *   `{router, detectedAt}` when both sides reordered differently (two-way);
 *   `drift_since` when the router reordered under Authoritative Mode.
 */
export default class extends BaseSchema {
  protected tableName = 'gateway_section_orders'

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
      table.string('config', 32).notNullable()
      table.string('section_type', 32).notNullable()
      table.text('base_order', 'mediumtext').notNullable()
      table.text('desired_order', 'mediumtext').notNullable()
      table.string('status', 12).notNullable().defaultTo('in_sync')
      table.text('conflict').nullable()
      table.datetime('drift_since').nullable()
      table
        .integer('updated_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.unique(
        ['gateway_id', 'config', 'section_type'],
        'gateway_section_orders_gateway_type_unique_idx'
      )
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
