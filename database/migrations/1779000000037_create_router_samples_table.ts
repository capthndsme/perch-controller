import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Gateway health samples scraped from the edge router's node_exporter
 * (`ROUTER_METRICS_URL`, every 30 s): conntrack table fill, established TCP
 * connections, load, memory and the WAN interface counters with the rate
 * derived between consecutive samples. One row per scrape; retention
 * `ROUTER_SAMPLE_RETENTION_DAYS` (default 90). Read side groups on
 * `recorded_at` (PK) so any window is one range scan.
 */
export default class extends BaseSchema {
  protected tableName = 'router_samples'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.collate('utf8mb4_unicode_ci')
      table.datetime('recorded_at').primary()
      table.integer('conntrack_entries').unsigned().nullable()
      table.integer('conntrack_limit').unsigned().nullable()
      table.integer('tcp_established').unsigned().nullable()
      table.decimal('load1', 8, 2).nullable()
      table.bigInteger('mem_total').unsigned().nullable()
      table.bigInteger('mem_available').unsigned().nullable()
      table.bigInteger('wan_rx_bytes').unsigned().nullable()
      table.bigInteger('wan_tx_bytes').unsigned().nullable()
      table.bigInteger('wan_rx_bps').unsigned().nullable()
      table.bigInteger('wan_tx_bps').unsigned().nullable()
      table.integer('scrape_ms').unsigned().nullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
