import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'wifi_network_snapshots'

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
      table.string('ssid', 128).notNullable()
      table.string('bssid', 17).notNullable()
      table.string('radio', 32).notNullable()
      table.smallint('channel').unsigned().nullable()
      table.integer('frequency_mhz').unsigned().nullable()
      table.string('band', 8).nullable()

      table.smallint('quality').unsigned().nullable()
      table.smallint('signal_dbm').nullable()
      table.smallint('noise_dbm').nullable()
      table.integer('bitrate_kbps').unsigned().nullable()

      table.datetime('recorded_at').notNullable()

      table.index(['ap_id', 'recorded_at'], 'wifi_network_snapshots_ap_time_idx')
      table.index(['ssid', 'recorded_at'], 'wifi_network_snapshots_ssid_time_idx')
      table.index(['ap_id', 'ifname', 'recorded_at'], 'wifi_network_snapshots_ifname_time_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
