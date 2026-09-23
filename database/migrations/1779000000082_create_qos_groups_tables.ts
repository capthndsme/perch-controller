import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * QoS groups (docs/gateway/qos.md section 4; plan 3 decision D4): admin-only
 * sets of MACs that share an assignment. They are not device tags: tag
 * writes are open to every signed-in user, and tags must never decide who is
 * capped.
 *
 * A MAC is in at most one group per gateway (unique `gateway_id, mac`), so
 * a device's cap is never ambiguous. MACs are lowercase colon form
 * (`normalizeMac`); joins with other MAC columns happen in JS (collation note
 * in CLAUDE.md).
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('qos_groups', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('gateway_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('gateways')
        .onDelete('CASCADE')
      table.string('name', 64).notNullable()
      table.string('notes', 500).nullable()
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.unique(['gateway_id', 'name'], 'qos_groups_gateway_name_unique_idx')
    })

    this.schema.createTable('qos_group_members', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('gateway_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('gateways')
        .onDelete('CASCADE')
      table
        .integer('group_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('qos_groups')
        .onDelete('CASCADE')
      table.string('mac', 17).notNullable()
      table.datetime('created_at').notNullable()

      table.unique(['gateway_id', 'mac'], 'qos_group_members_gateway_mac_unique_idx')
      table.index(['group_id'], 'qos_group_members_group_idx')
    })
  }

  async down() {
    this.schema.dropTable('qos_group_members')
    this.schema.dropTable('qos_groups')
  }
}
