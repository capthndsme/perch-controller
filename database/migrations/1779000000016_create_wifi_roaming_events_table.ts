import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'wifi_roaming_events'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table.string('mac', 17).notNullable()
      table
        .integer('from_ap_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('wifi_access_points')
        .onDelete('SET NULL')
      table
        .integer('to_ap_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('wifi_access_points')
        .onDelete('SET NULL')

      table.string('from_ifname', 32).nullable()
      table.string('to_ifname', 32).nullable()
      table.string('from_ssid', 128).nullable()
      table.string('to_ssid', 128).nullable()
      table.string('from_band', 8).nullable()
      table.string('to_band', 8).nullable()

      // ap_roam | band_steer | interface_switch
      table.string('event_type', 24).notNullable()
      table.datetime('detected_at').notNullable()

      table.index(['mac', 'detected_at'], 'wifi_roaming_events_mac_time_idx')
      table.index(['to_ap_id', 'detected_at'], 'wifi_roaming_events_to_ap_time_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
