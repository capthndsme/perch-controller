import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Latest-only mirror of each device's top peer list. The poller wipes the
 * rows for a `(collector_id, mac, scope)` triple on every successful tick
 * and reinserts whatever the collector currently reports — there is no
 * historical retention for peers.
 *
 * `scope` distinguishes WAN (`top_peers` from the collector) from LAN
 * (`top_lan_peers`); see go-collector's FEATURES.md §2.1.
 *
 * The UNIQUE (collector_id, mac, peer_ip, scope) constraint protects the
 * wipe+insert from racing concurrent ticks for the same device — only one
 * upserter can win and the loser's INSERT raises an integrity error the
 * poller can ignore rather than producing duplicate peer rows.
 */
export default class extends BaseSchema {
  protected tableName = 'device_top_peers'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.bigIncrements('id').notNullable()

      table
        .integer('collector_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('collectors')
        .onDelete('CASCADE')

      table.string('mac', 17).notNullable()
      // peer_ip can be IPv4 (15 chars) or IPv6 (max 45 chars incl. zone id).
      table.string('peer_ip', 45).notNullable()
      table.string('scope', 8).notNullable() // 'wan' | 'lan'

      table.bigInteger('bytes_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('bytes_out').unsigned().notNullable().defaultTo(0)

      table.timestamp('updated_at').notNullable()

      table.unique(['collector_id', 'mac', 'peer_ip', 'scope'], 'device_top_peers_unique_idx')
      table.index(['collector_id', 'mac', 'scope'], 'device_top_peers_lookup_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
