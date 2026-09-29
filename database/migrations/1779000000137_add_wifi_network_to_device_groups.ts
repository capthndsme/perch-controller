import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * `device_groups.wifi_network_id` (docs/design/wifi controller.md section
 * 2, used by the phase-4 fold, S7): the shared SSID carrying a group's keys
 * on plane-managed APs (it replaces Settings → Device groups `ssids` there).
 * SET NULL when the network is deleted.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('device_groups', (table) => {
      table
        .integer('wifi_network_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('wifi_networks')
        .onDelete('SET NULL')
    })
  }

  async down() {
    this.schema.alterTable('device_groups', (table) => {
      table.dropForeign(['wifi_network_id'])
      table.dropColumn('wifi_network_id')
    })
  }
}
