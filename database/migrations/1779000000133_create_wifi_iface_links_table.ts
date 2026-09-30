import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Which network an AP's `wifi-iface` section belongs to (docs/design/wifi
 * controller.md sections 2, 5.2 and 5.3), by the section's perch id: one
 * row per rendered or adopted slot (network × radio). `origin` adopted |
 * created | router; `network_id` SET NULL when a network is deleted before
 * its slots are gone. `dynamic_vlan_was` keeps the router's value when the
 * device-groups fold (phase 4) takes the option over.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('wifi_iface_links', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('ap_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('wifi_access_points')
        .onDelete('CASCADE')
      table.string('perch_id', 24).notNullable()
      table
        .integer('network_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('wifi_networks')
        .onDelete('SET NULL')
      table.string('radio', 32).notNullable()
      table.string('origin', 8).notNullable()
      table.string('dynamic_vlan_was', 4).nullable()
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.unique(['ap_id', 'perch_id'], 'wifi_iface_links_ap_perch_unique_idx')
      table.index(['network_id'], 'wifi_iface_links_network_idx')
    })
  }

  async down() {
    this.schema.dropTable('wifi_iface_links')
  }
}
