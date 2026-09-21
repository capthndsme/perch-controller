import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Hourly peer history: how many bytes each device exchanged with each peer IP
 * per hour, split by scope (WAN vs LAN). This is the "where is the traffic
 * going" table the looking-glass views read — `device_top_peers` only ever
 * held the *latest* heap, so there was no way to ask "who did the NAS talk to
 * last night".
 *
 * Rows are byte *deltas* between consecutive poller snapshots of the
 * collector's per-device peer heaps, SUMmed into the hour via
 * ON DUPLICATE KEY UPDATE (see `bucket_writer.writePeerBuckets`). A peer that
 * is evicted from the collector's bounded heap and later re-enters is
 * re-baselined, so eviction never produces a negative or inflated delta.
 *
 * Retention is its own horizon (`PEER_HOURLY_RETENTION_DAYS`, default 90 d):
 * active devices × peers × hours is a larger cardinality than the traffic
 * rollups, and 90 days answers every "recently" question the UI asks.
 */
export default class extends BaseSchema {
  protected tableName = 'device_peer_buckets_hourly'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.collate('utf8mb4_unicode_ci')

      table
        .integer('collector_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('collectors')
        .onDelete('CASCADE')
      table.string('mac', 17).notNullable()
      table.string('scope', 8).notNullable() // 'wan' | 'lan'
      // IPv4 (15) or IPv6 with zone id (45).
      table.string('peer_ip', 45).notNullable()
      table.datetime('hour_start').notNullable()

      table.bigInteger('bytes_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('bytes_out').unsigned().notNullable().defaultTo(0)

      table.timestamp('updated_at').notNullable()

      table.primary(['collector_id', 'mac', 'scope', 'peer_ip', 'hour_start'])
      // Network-wide "top destinations over a window" (scope + time range scan).
      table.index(['scope', 'hour_start'], 'device_peer_buckets_hourly_scope_time_idx')
      // Per-device history regardless of collector.
      table.index(['mac', 'hour_start'], 'device_peer_buckets_hourly_mac_time_idx')
      // "Who on the LAN talked to this peer?"
      table.index(['peer_ip', 'hour_start'], 'device_peer_buckets_hourly_peer_time_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
