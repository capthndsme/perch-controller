import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Adds a `(bucket_start)`-leading index to `device_traffic_buckets`.
 *
 * The all-device read paths (home bandwidth chart, top-talker totals) filter
 * on `bucket_start` alone — no MAC, no collector. Without this index those
 * queries full-scan the whole table for *any* window, so even a 1-hour view
 * cost ~14 s. With it, short/medium windows (≤ ~1 day) range-scan just their
 * slice (~0.2–0.5 s). Wider windows at hour/5-minute resolution are served
 * from the rollup tables instead; see `…_hourly` / `…_5m`.
 *
 * `device_protocol_buckets` already has `(bucket_start, protocol)`, so it does
 * not need an equivalent.
 */
export default class extends BaseSchema {
  protected tableName = 'device_traffic_buckets'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.index(['bucket_start'], 'device_traffic_buckets_time_idx')
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropIndex(['bucket_start'], 'device_traffic_buckets_time_idx')
    })
  }
}
