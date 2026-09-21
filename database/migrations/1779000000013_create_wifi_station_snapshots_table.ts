import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'wifi_station_snapshots'

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

      table.string('mac', 17).notNullable()
      table.string('ifname', 32).notNullable()
      table.string('ssid', 128).nullable()
      table.string('radio', 32).nullable()
      table.smallint('channel').unsigned().nullable()
      table.integer('frequency_mhz').unsigned().nullable()
      table.string('band', 8).nullable()

      table.smallint('signal_dbm').nullable()
      table.smallint('snr_db').nullable()

      table.integer('tx_rate_kbps').unsigned().nullable()
      table.integer('rx_rate_kbps').unsigned().nullable()
      table.integer('expected_throughput_kbps').unsigned().nullable()

      table.integer('inactive_ms').unsigned().nullable()

      table.bigInteger('tx_bytes').unsigned().nullable()
      table.bigInteger('rx_bytes').unsigned().nullable()
      table.bigInteger('tx_packets').unsigned().nullable()
      table.bigInteger('rx_packets').unsigned().nullable()

      table.datetime('recorded_at').notNullable()

      table.index(['mac', 'recorded_at'], 'wifi_station_snapshots_mac_time_idx')
      table.index(['ap_id', 'recorded_at'], 'wifi_station_snapshots_ap_time_idx')
      table.index(['ap_id', 'ifname', 'recorded_at'], 'wifi_station_snapshots_ifname_time_idx')
      table.index(['ap_id', 'mac', 'recorded_at'], 'wifi_station_snapshots_ap_mac_time_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
