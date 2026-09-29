import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Where an AP differs from what the fleet renders for it (docs/design/wifi
 * controller.md section 5.3, decisions D5/D6): `kind` option | removed |
 * added | unassigned | country; `option` for option divergences;
 * `fleet_value` / `ap_value` JSON (secrets only as `{fingerprint}`);
 * `router_author` who changed it on the AP. Open while `resolved_at` is
 * null; `resolution` fleet | override | revert | split | auto.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('wifi_divergences', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('ap_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('wifi_access_points')
        .onDelete('CASCADE')
      table
        .integer('network_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('wifi_networks')
        .onDelete('CASCADE')
      table.string('perch_id', 24).nullable()
      table.string('radio', 32).nullable()
      table.string('kind', 12).notNullable()
      table.string('option', 64).nullable()
      table.text('fleet_value').nullable()
      table.text('ap_value').nullable()
      table.text('router_author').nullable()
      table.datetime('detected_at').notNullable()
      table.datetime('resolved_at').nullable()
      table.string('resolution', 10).nullable()
      table
        .integer('resolved_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')

      table.index(['ap_id', 'resolved_at'], 'wifi_divergences_ap_resolved_idx')
      table.index(['network_id', 'resolved_at'], 'wifi_divergences_network_resolved_idx')
    })
  }

  async down() {
    this.schema.dropTable('wifi_divergences')
  }
}
