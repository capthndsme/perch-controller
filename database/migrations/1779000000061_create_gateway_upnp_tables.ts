import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * UPnP IGD port mappings the router's miniupnpd holds (observation part
 * `upnp`, docs/gateway/observation.md; plan-2-native-sync.md section 3).
 *
 * - `gateway_upnp_mappings`: runtime mirror, one row per (collector, proto,
 *   external port), replaced by every changed report. `mac` is resolved at
 *   ingest from the host mirror (the internal address's lease or neighbour).
 *   Listed in `NON_HISTORY_TABLES` of `collectors:merge` (keeps `--into`'s).
 * - `gateway_upnp_events`: history of mappings opened and closed, pruned
 *   after `upnpEventRetentionDays` (default 90). Moves with a merge.
 *
 * Both CASCADE with their collector.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('gateway_upnp_mappings', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('collector_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('collectors')
        .onDelete('CASCADE')
      table.string('proto', 4).notNullable()
      table.integer('ext_port').unsigned().notNullable()
      table.string('int_ip', 45).notNullable()
      table.integer('int_port').unsigned().notNullable()
      table.string('mac', 17).nullable()
      table.string('description', 128).nullable()
      // Null = no lease time (permanent until removed).
      table.datetime('expires_at').nullable()
      table.datetime('first_seen_at').notNullable()
      table.datetime('last_seen_at').notNullable()

      table.unique(['collector_id', 'proto', 'ext_port'], 'gateway_upnp_mappings_key_unique_idx')
      table.index(['mac'], 'gateway_upnp_mappings_mac_idx')
    })

    this.schema.createTable('gateway_upnp_events', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table
        .integer('collector_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('collectors')
        .onDelete('CASCADE')
      // 'opened' | 'closed'
      table.string('event', 8).notNullable()
      table.string('proto', 4).notNullable()
      table.integer('ext_port').unsigned().notNullable()
      table.string('int_ip', 45).notNullable()
      table.integer('int_port').unsigned().notNullable()
      table.string('mac', 17).nullable()
      table.string('description', 128).nullable()
      table.datetime('at').notNullable()

      table.index(['collector_id', 'at'], 'gateway_upnp_events_collector_at_idx')
      table.index(['mac', 'at'], 'gateway_upnp_events_mac_at_idx')
      table.index(['at'], 'gateway_upnp_events_at_idx')
    })
  }

  async down() {
    this.schema.dropTable('gateway_upnp_events')
    this.schema.dropTable('gateway_upnp_mappings')
  }
}
