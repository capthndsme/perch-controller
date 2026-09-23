import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * WAN SQM queues (docs/gateway/qos.md section 2; plan 3 sections 2 and 4):
 * the controller's mirror of each `sqm` `queue` section on a managed
 * gateway. It hangs off `gateways` (README 3.1: only `gateways` references
 * `collectors`), so `collectors:merge` moves it with its gateway and needs
 * no entry of its own.
 *
 * - `options`: the section's full UCI option map as JSON, verbatim. The API
 *   fields are views over it (`app/services/sqm_mapping.ts`), and options
 *   Perch does not model survive every write.
 * - `origin`: `router` for a queue first seen on the router (the live
 *   gateway's hand-made queue is imported as it is), `controller` for one
 *   an admin created.
 * - `router_paused_at` (owner decision 15): set when the router turned an
 *   enabled queue off (`sqm enabled=0`). That is a safety pause Authoritative
 *   Mode never reverts, and the dashboard shows it loudly. Cleared when the
 *   router turns it back on.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('qos_wan_queues', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('gateway_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('gateways')
        .onDelete('CASCADE')
      // Null until the queue exists on the router (a controller-created one
      // gets `perch_<perchId>` from the config plane on its first apply).
      table.string('uci_section', 64).nullable()
      table.string('perch_id', 24).nullable()
      // Linux device (`wan`, `pppoe-wan`): IFNAMSIZ - 1.
      table.string('device', 15).notNullable()
      table.boolean('enabled').notNullable().defaultTo(false)
      table.text('options', 'mediumtext').notNullable()
      table.string('origin', 12).notNullable().defaultTo('router')
      table.datetime('router_updated_at').nullable()
      table.datetime('router_paused_at').nullable()
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      // Many NULLs are allowed: controller-created queues not applied yet.
      table.unique(['gateway_id', 'uci_section'], 'qos_wan_queues_gateway_section_unique_idx')
      table.unique(['gateway_id', 'perch_id'], 'qos_wan_queues_gateway_perch_unique_idx')
      table.index(['gateway_id', 'device'], 'qos_wan_queues_gateway_device_idx')
    })
  }

  async down() {
    this.schema.dropTable('qos_wan_queues')
  }
}
