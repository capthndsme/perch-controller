import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The Gateway agent's DHCP observation (docs/collector-agent.md section 4.3;
 * the `observe.dhcp` part of the observation channel sketched in
 * docs/design/gateway/plan-2-native-sync.md section 3, trimmed to DHCP).
 *
 * - `gateway_hosts`: runtime mirror, one row per (collector, MAC) the
 *   router's DHCP knows: the lease's hostname and addresses and the name of
 *   a static `host` section. Replaced as a whole by every report that
 *   changed; no history. Neighbour and network columns come with the later
 *   observation parts.
 * - `gateway_observations`: per collector and kind (`dhcp` today) when the
 *   agent last reported it and the fingerprint of what was written, so an
 *   unchanged report costs no row writes after a restart either, and so the
 *   hostname lookup knows which collectors provide the data.
 *
 * Both CASCADE with their collector (runtime state dies with its source)
 * and are listed in `NON_HISTORY_TABLES` of `collectors:merge`.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('gateway_hosts', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('collector_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('collectors')
        .onDelete('CASCADE')
      table.string('mac', 17).notNullable()
      // The lease's hostname (dnsmasq/odhcpd), null when the client sent none.
      table.string('hostname', 253).nullable()
      // The `name` of a static UCI `host` section for this MAC: ranks above
      // the lease's hostname, like the command-execution path always did.
      table.string('static_name', 253).nullable()
      table.string('ipv4', 15).nullable()
      // JSON array of addresses (DHCPv6 leases, whose DUID carries this MAC).
      table.text('ipv6').nullable()
      table.datetime('lease_expires_at').nullable()
      table.boolean('lease_infinite').notNullable().defaultTo(false)
      table.datetime('first_seen_at').notNullable()
      table.datetime('updated_at').notNullable()

      table.unique(['collector_id', 'mac'], 'gateway_hosts_collector_mac_unique_idx')
      table.index(['mac'], 'gateway_hosts_mac_idx')
    })

    this.schema.createTable('gateway_observations', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table
        .integer('collector_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('collectors')
        .onDelete('CASCADE')
      table.string('kind', 24).notNullable()
      // Counts and small facts about the report (JSON), for the settings page.
      table.text('payload').nullable()
      table.string('fingerprint', 64).notNullable()
      table.datetime('observed_at').notNullable()
      table.datetime('changed_at').notNullable()

      table.primary(['collector_id', 'kind'])
    })
  }

  async down() {
    this.schema.dropTable('gateway_observations')
    this.schema.dropTable('gateway_hosts')
  }
}
