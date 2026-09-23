import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The observation channel's host mirror (docs/gateway/observation.md;
 * docs/design/gateway/plan-2-native-sync.md section 3): `gateway_hosts`
 * (migration 046, DHCP only) also mirrors the router's neighbour table, and
 * keeps the sightings presence reads.
 *
 * - `has_lease`: the row has an IPv4 lease right now (`ipv4` may also come
 *   from a static host without one).
 * - `dhcp_present` / `neighbor_present`: the latest report of that kind
 *   lists the MAC. A row in neither is kept (with its sightings) until the
 *   retention task drops it `hostRetentionDays` after `last_reported_at`,
 *   unless it never had a sighting, which is dropped at once.
 * - `dhcp_seen_at`: the last DHCP exchange the controller can date (a lease
 *   whose expiry moved forward, or expiry minus a known lease time of at
 *   most 24 h). `neighbor_seen_at`: the last report listing the MAC as
 *   reachable in the neighbour table. Presence reads the later of the two
 *   (presence setting `gatewaySightings`). `neighbor_reachable`: the latest
 *   neighbour report's state for it.
 * - `network`: the router's logical network (`lan`, `guest`, …) the address
 *   belongs to, from the latest `interfaces` report.
 *
 * `gateway_observations.payload` grows to MEDIUMTEXT: it now holds the
 * latest report of the blob kinds (interfaces, mwan3, system, …).
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('gateway_hosts', (table) => {
      table.boolean('has_lease').notNullable().defaultTo(false)
      table.boolean('dhcp_present').notNullable().defaultTo(false)
      table.datetime('dhcp_seen_at').nullable()
      table.boolean('neighbor_present').notNullable().defaultTo(false)
      table.datetime('neighbor_seen_at').nullable()
      // The latest neighbour report listed it as reachable (REACHABLE/DELAY/PROBE/PERMANENT).
      table.boolean('neighbor_reachable').notNullable().defaultTo(false)
      table.string('neighbor_ipv4', 15).nullable()
      // JSON array of the MAC's IPv6 neighbour addresses.
      table.text('neighbor_ipv6').nullable()
      table.string('neighbor_device', 32).nullable()
      table.string('network', 32).nullable()
      table.datetime('last_reported_at').nullable()

      table.index(['last_reported_at'], 'gateway_hosts_last_reported_idx')
    })

    // Every existing row came from a DHCP report.
    this.defer(async (db) => {
      await db.rawQuery(
        `UPDATE gateway_hosts
            SET dhcp_present = 1, last_reported_at = updated_at,
                has_lease = (lease_expires_at IS NOT NULL OR lease_infinite = 1)`
      )
    })

    this.schema.alterTable('gateway_observations', (table) => {
      table.text('payload', 'mediumtext').nullable().alter()
    })
  }

  async down() {
    this.schema.alterTable('gateway_observations', (table) => {
      table.text('payload').nullable().alter()
    })
    this.schema.alterTable('gateway_hosts', (table) => {
      table.dropIndex(['last_reported_at'], 'gateway_hosts_last_reported_idx')
      table.dropColumn('has_lease')
      table.dropColumn('dhcp_present')
      table.dropColumn('dhcp_seen_at')
      table.dropColumn('neighbor_present')
      table.dropColumn('neighbor_seen_at')
      table.dropColumn('neighbor_reachable')
      table.dropColumn('neighbor_ipv4')
      table.dropColumn('neighbor_ipv6')
      table.dropColumn('neighbor_device')
      table.dropColumn('network')
      table.dropColumn('last_reported_at')
    })
  }
}
