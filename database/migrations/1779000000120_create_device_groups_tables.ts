import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Device groups (docs/gateway/device-groups.md; owner decisions 30 and 31):
 * per-gateway groups of devices with a network, Wi-Fi keys, a speed limit,
 * internet access and a portal bypass.
 *
 * - `device_group_members`: the bound members (an admin's, or a portal
 *   sign-in's). A MAC is in one group per gateway at most. MACs are
 *   lowercase colon form; joins with other MAC columns happen in JS
 *   (collation note in CLAUDE.md).
 * - `device_group_keys`: per-group Wi-Fi passphrases, encrypted with
 *   APP_KEY; the SHA-256 keeps a passphrase unique per gateway (one
 *   passphrase names one VLAN on the access points).
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('device_groups', (table) => {
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
      table.string('network_perch_id', 64).nullable()
      table.boolean('internet').notNullable().defaultTo(true)
      table.boolean('portal_bypass').notNullable().defaultTo(false)
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.unique(['gateway_id', 'name'], 'device_groups_gateway_name_unique_idx')
      table.index(['gateway_id', 'network_perch_id'], 'device_groups_gateway_network_idx')
    })

    this.schema.createTable('device_group_members', (table) => {
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
        .inTable('device_groups')
        .onDelete('CASCADE')
      table.string('mac', 17).notNullable()
      table.string('source', 8).notNullable().defaultTo('manual')
      table
        .integer('portal_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('portal_users')
        .onDelete('SET NULL')
      table
        .integer('created_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.datetime('created_at').notNullable()

      table.unique(['gateway_id', 'mac'], 'device_group_members_gateway_mac_unique_idx')
      table.index(['group_id'], 'device_group_members_group_idx')
      table.index(['portal_user_id'], 'device_group_members_portal_user_idx')
    })

    this.schema.createTable('device_group_keys', (table) => {
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
        .inTable('device_groups')
        .onDelete('CASCADE')
      table.string('label', 64).notNullable()
      table.text('passphrase_encrypted').notNullable()
      table.string('passphrase_digest', 64).notNullable()
      table
        .integer('created_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.datetime('created_at').notNullable()

      table.unique(
        ['gateway_id', 'passphrase_digest'],
        'device_group_keys_gateway_digest_unique_idx'
      )
      table.index(['group_id'], 'device_group_keys_group_idx')
    })
  }

  async down() {
    this.schema.dropTable('device_group_keys')
    this.schema.dropTable('device_group_members')
    this.schema.dropTable('device_groups')
  }
}
