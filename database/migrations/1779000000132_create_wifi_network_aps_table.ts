import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * A network's membership of one AP (docs/design/wifi controller.md sections
 * 2 and 5.1): `included` null = follow the network's scope (all: carried
 * unless false; selected: carried only when true); `bands` / `radios` narrow
 * where the network lands on this AP; `overrides` (enabled, hidden,
 * isolate, apNetwork, keepKey, maxClients, dtimPeriod) and
 * `radio_overrides` ({<radio>: {enabled}}) are JSON.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('wifi_network_aps', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('network_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('wifi_networks')
        .onDelete('CASCADE')
      table
        .integer('ap_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('wifi_access_points')
        .onDelete('CASCADE')
      table.boolean('included').nullable()
      table.text('bands').nullable()
      table.text('radios').nullable()
      table.text('overrides').nullable()
      table.text('radio_overrides').nullable()
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.unique(['network_id', 'ap_id'], 'wifi_network_aps_network_ap_unique_idx')
      table.index(['ap_id'], 'wifi_network_aps_ap_idx')
    })
  }

  async down() {
    this.schema.dropTable('wifi_network_aps')
  }
}
