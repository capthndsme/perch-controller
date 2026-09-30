import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Perch-only WAN metadata (docs/design/gateway-sync/README.md 7, rest.md 3),
 * like `gateway_networks`: never in UCI. Keyed by the WAN's network name
 * (the UCI interface section), with its perch id when synced. `label` is
 * the name the dashboard shows, `role_override` turns a NAT link into an
 * internet uplink (or back), `check_targets` overrides Settings → Gateway
 * sync's targets for this WAN's checks.
 */
export default class extends BaseSchema {
  protected tableName = 'gateway_wans'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('gateway_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('gateways')
        .onDelete('CASCADE')
      table.string('network', 32).notNullable()
      table.string('interface_perch_id', 24).nullable()
      table.string('label', 80).notNullable()
      // internet | nat_link
      table.string('role_override', 16).nullable()
      table.text('check_targets').nullable()
      table.string('note', 200).nullable()
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.unique(['gateway_id', 'network'], 'gateway_wans_gateway_network_unique_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
