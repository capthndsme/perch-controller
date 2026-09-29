import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Fleet Wi-Fi networks (docs/design/wifi controller.md sections 2 and 5.1):
 * a template (SSID, security, passphrase ref, hidden, isolation, binding,
 * bands, roaming, advanced) plus a scope (`ap_scope` all | selected); the
 * per-AP part lives in `wifi_network_aps`.
 *
 * - `ssid` is `varbinary(32)`: SSIDs are bytes, compared exactly (the
 *   table's `utf8mb4_unicode_ci` would fold case and trailing spaces).
 * - `security` open | owe | wpa2 | wpa2_wpa3 | wpa3 | wpa_wpa2 (imported only).
 * - `passphrase_ref` → `wifi_secrets.ref` (SET NULL): null = no passphrase
 *   (open, OWE) or an unknown one (adopted, never typed, decision D13).
 * - JSON (text): `binding` {kind: lan | vlan | ap_network, …}, `bands`,
 *   `roaming` {ft, mobilityDomain, rrm, btm}, `advanced` {pmf,
 *   multicastToUnicast, maxClients, dtimPeriod}.
 * - `origin` perch | import | router; `revision` counts template edits.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('wifi_networks', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table.string('name', 64).notNullable()
      table.binary('ssid', 32).notNullable()
      table.boolean('enabled').notNullable().defaultTo(true)
      table.string('security', 12).notNullable()
      table
        .string('passphrase_ref', 48)
        .nullable()
        .references('ref')
        .inTable('wifi_secrets')
        .onDelete('SET NULL')
      table.boolean('hidden').notNullable().defaultTo(false)
      table.boolean('isolate').notNullable().defaultTo(false)
      table.text('binding').notNullable()
      table.text('bands').notNullable()
      table.string('ap_scope', 8).notNullable().defaultTo('all')
      table.text('roaming').notNullable()
      table.text('advanced').notNullable()
      table.boolean('groups').notNullable().defaultTo(false)
      table.string('origin', 8).notNullable().defaultTo('perch')
      table.integer('revision').unsigned().notNullable().defaultTo(1)
      table
        .integer('created_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table
        .integer('updated_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.index(['ssid'], 'wifi_networks_ssid_idx')
    })
  }

  async down() {
    this.schema.dropTable('wifi_networks')
  }
}
