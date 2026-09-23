import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Networks, part two (docs/gateway/networks.md; plan 1 sections 8 and 9,
 * README 7.8 and 7.21).
 *
 * - `gateway_networks` gains `network` (the netifd / UCI interface name):
 *   a network the collector reports is known by name before (or without)
 *   the config plane, so the capture toggle (README 7.21) works on a
 *   gateway in mode `off` too. A row is matched by `interface_perch_id`
 *   first (survives a rename on the router), else by name; the two are kept
 *   in step. `interface_perch_id` becomes nullable for report-only rows.
 * - `gateway_scope_changes`: when a gateway's accounting scope rule changed
 *   (`routed` = routed LAN↔LAN and router-address traffic count as LAN,
 *   `legacy` = the old rule; README 7.8: charts mark the change date).
 *   Written on a change only.
 * - `device_network_history`: which network a MAC was on, as intervals
 *   (written on change only, beside `device_network_latest`; README 7.8
 *   per-device-per-network history). The open interval has `ended_at`
 *   NULL; closed ones are pruned after the hourly retention.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('gateway_networks', (table) => {
      table.string('network', 15).nullable().after('interface_perch_id')
      table.string('interface_perch_id', 24).nullable().alter()
      table
        .integer('capture_changed_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.datetime('capture_changed_at').nullable()
      table.unique(['gateway_id', 'network'], 'gateway_networks_gateway_network_unique_idx')
    })

    this.schema.createTable('gateway_scope_changes', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table
        .integer('gateway_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('gateways')
        .onDelete('CASCADE')
      table.string('scope', 12).notNullable()
      table.datetime('changed_at').notNullable()

      table.index(['gateway_id', 'changed_at'], 'gateway_scope_changes_gateway_time_idx')
    })

    this.schema.createTable('device_network_history', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table
        .integer('gateway_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('gateways')
        .onDelete('CASCADE')
      table.string('mac', 17).notNullable()
      table.string('network', 15).notNullable()
      table.datetime('started_at').notNullable()
      table.datetime('ended_at').nullable()

      table.index(['gateway_id', 'mac', 'ended_at'], 'device_network_history_open_idx')
      table.index(['mac', 'started_at'], 'device_network_history_mac_idx')
      table.index(['ended_at'], 'device_network_history_ended_idx')
    })
  }

  async down() {
    this.schema.dropTable('device_network_history')
    this.schema.dropTable('gateway_scope_changes')
    this.schema.alterTable('gateway_networks', (table) => {
      table.dropUnique(['gateway_id', 'network'], 'gateway_networks_gateway_network_unique_idx')
      table.dropForeign(['capture_changed_by_user_id'])
      table.dropColumn('capture_changed_at')
      table.dropColumn('capture_changed_by_user_id')
      table.dropColumn('network')
    })
    this.schema.alterTable('gateway_networks', (table) => {
      table.string('interface_perch_id', 24).notNullable().alter()
    })
  }
}
