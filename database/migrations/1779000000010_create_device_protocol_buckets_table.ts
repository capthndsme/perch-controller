import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Per-device, per-protocol time-series buckets written by the poller.
 * Upsert key: (collector_id, mac, protocol, bucket_start).
 */
export default class extends BaseSchema {
  protected tableName = 'device_protocol_buckets'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.bigIncrements('id')
      table
        .integer('collector_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('collectors')
        .onDelete('CASCADE')
      table.string('mac', 17).notNullable()
      table.string('protocol', 30).notNullable()
      table.dateTime('bucket_start').notNullable()
      table.bigInteger('bytes_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('bytes_out').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_out').unsigned().notNullable().defaultTo(0)
      table.dateTime('created_at').notNullable()
      table.dateTime('updated_at').notNullable()

      table.unique(
        ['collector_id', 'mac', 'protocol', 'bucket_start'],
        'device_protocol_buckets_unique_idx'
      )
      table.index(['mac', 'bucket_start'], 'device_protocol_buckets_mac_time_idx')
      table.index(['bucket_start', 'protocol'], 'device_protocol_buckets_time_proto_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
