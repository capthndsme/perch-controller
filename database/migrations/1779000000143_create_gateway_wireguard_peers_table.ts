import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Perch-only WireGuard peer metadata (docs/design/gateway-sync/README.md 7,
 * rest.md 4): the device a peer belongs to, who made it and when its
 * one-time client config was handed out. Never in UCI (the peer's label is
 * UCI `description`). Keyed by interface and public key: a peer section the
 * router renames or re-creates keeps its row.
 */
export default class extends BaseSchema {
  protected tableName = 'gateway_wireguard_peers'

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
      table.string('peer_perch_id', 24).nullable()
      table.string('interface', 32).notNullable()
      table.string('public_key', 44).notNullable()
      table.string('device_mac', 17).nullable()
      table
        .integer('created_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.datetime('client_config_issued_at').nullable()
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.unique(
        ['gateway_id', 'interface', 'public_key'],
        'gateway_wireguard_peers_gateway_iface_key_unique_idx'
      )
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
