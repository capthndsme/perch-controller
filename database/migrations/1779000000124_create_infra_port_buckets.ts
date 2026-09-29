import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Port accounting of the infrastructure view (docs/infrastructure-view.md,
 * amendment A6.2): the bytes each agent port received from and sent into its
 * cable, per 5-minute slot and per hour. Both are written at ingest by
 * `infra_port_traffic.ts` from the deltas of the agents' cumulative counters
 * (no rollup job), and pruned with the other 5-minute and hourly tiers.
 */
export default class extends BaseSchema {
  async up() {
    for (const [tableName, timeColumn] of [
      ['infra_port_buckets_5m', 'slot_start'],
      ['infra_port_buckets_hourly', 'hour_start'],
    ] as const) {
      this.schema.createTable(tableName, (table) => {
        table.collate('utf8mb4_unicode_ci')

        table
          .integer('port_id')
          .unsigned()
          .notNullable()
          .references('id')
          .inTable('infra_ports')
          .onDelete('CASCADE')
        table.datetime(timeColumn).notNullable()
        table.bigInteger('rx_bytes').unsigned().notNullable().defaultTo(0)
        table.bigInteger('tx_bytes').unsigned().notNullable().defaultTo(0)

        table.primary(['port_id', timeColumn])
        // Retention prunes by time alone.
        table.index([timeColumn], `${tableName}_time_idx`)
      })
    }
  }

  async down() {
    this.schema.dropTable('infra_port_buckets_hourly')
    this.schema.dropTable('infra_port_buckets_5m')
  }
}
