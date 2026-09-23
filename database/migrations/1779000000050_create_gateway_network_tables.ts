import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Multi-LAN / VLAN data (docs/gateway/config-plane.md sections 8, 9).
 *
 * - `gateway_networks`: Perch-only metadata of a network (label, purpose
 *   lan | guest | iot | management | custom, capture flag), keyed by the
 *   `perch_id` of its `interface` section. Never written into UCI.
 * - `gateway_network_samples`: per-network counters from the gateway report
 *   (netifd + /proc/net/dev), one row per 30 s at most, with the rate since
 *   the previous one. Pruned with `router_samples` (same data class,
 *   ROUTER_SAMPLE_RETENTION_DAYS).
 * - `device_network_latest`: the capture network a MAC was last an endpoint
 *   on, written on change only. No history (README 7.8: per-device-per-network
 *   history ships with M5 as its own table).
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('gateway_networks', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('gateway_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('gateways')
        .onDelete('CASCADE')
      table.string('interface_perch_id', 24).notNullable()
      table.string('label', 80).notNullable()
      table.string('purpose', 16).notNullable().defaultTo('lan')
      table.boolean('capture').notNullable().defaultTo(true)
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.unique(
        ['gateway_id', 'interface_perch_id'],
        'gateway_networks_gateway_iface_unique_idx'
      )
    })

    this.schema.createTable('gateway_network_samples', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table
        .integer('gateway_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('gateways')
        .onDelete('CASCADE')
      table.string('network', 15).notNullable()
      table.datetime('recorded_at').notNullable()
      table.bigInteger('rx_bytes').unsigned().notNullable()
      table.bigInteger('tx_bytes').unsigned().notNullable()
      table.bigInteger('rx_bps').unsigned().nullable()
      table.bigInteger('tx_bps').unsigned().nullable()

      table.primary(['gateway_id', 'network', 'recorded_at'])
      table.index(['recorded_at'], 'gateway_network_samples_time_idx')
    })

    this.schema.createTable('device_network_latest', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table
        .integer('gateway_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('gateways')
        .onDelete('CASCADE')
      table.string('mac', 17).notNullable()
      table.string('network', 15).notNullable()
      table.datetime('seen_at').notNullable()

      table.primary(['gateway_id', 'mac'])
      table.index(['mac'], 'device_network_latest_mac_idx')
    })
  }

  async down() {
    this.schema.dropTable('device_network_latest')
    this.schema.dropTable('gateway_network_samples')
    this.schema.dropTable('gateway_networks')
  }
}
