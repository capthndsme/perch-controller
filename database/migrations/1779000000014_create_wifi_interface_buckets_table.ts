import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'wifi_interface_buckets'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table
        .integer('ap_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('wifi_access_points')
        .onDelete('CASCADE')

      table.string('ifname', 32).notNullable()
      table.string('ssid', 128).nullable()
      table.string('radio', 32).nullable()
      table.string('band', 8).nullable()

      table.datetime('bucket_start').notNullable()

      table.bigInteger('bytes_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('bytes_out').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_out').unsigned().notNullable().defaultTo(0)
      table.bigInteger('errs_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('errs_out').unsigned().notNullable().defaultTo(0)
      table.bigInteger('drops_in').unsigned().notNullable().defaultTo(0)
      table.bigInteger('drops_out').unsigned().notNullable().defaultTo(0)

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.unique(['ap_id', 'ifname', 'bucket_start'], 'wifi_interface_buckets_unique_idx')
      table.index(['bucket_start'], 'wifi_interface_buckets_time_idx')
      table.index(['ssid', 'bucket_start'], 'wifi_interface_buckets_ssid_time_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
