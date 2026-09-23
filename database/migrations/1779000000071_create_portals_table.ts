import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Guest portals (docs/gateway/portal.md section 5). Several per gateway
 * (owner decision 19), at most one live portal per network: the unique index
 * is on `active_network`, a generated column that is the network while the
 * row is not soft-deleted and NULL after (NULLs never collide).
 *
 * The row holds Perch's application data only. openNDS's own settings
 * (enabled, timeouts, walled garden, …) stay native config, read from and
 * written through the config plane; `network_perch_id` is the ledger id of
 * the `interface` section the portal sits on (stable across renames), and
 * `instance` the openNDS section serving it (null until the first apply).
 * `enforcement`: `opennds`, or `perch_nft` if the M1 spike finds openNDS
 * cannot run one instance per network.
 *
 * `portals` references `gateways`, not `collectors`: it follows its gateway
 * through `collectors:merge` without a rule of its own.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('portals', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('gateway_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('gateways')
        .onDelete('CASCADE')
      table.string('name', 80).notNullable()
      table.string('network_perch_id', 24).notNullable()
      table.string('instance', 64).nullable()
      table.string('enforcement', 16).notNullable().defaultTo('opennds')
      // {voucher: boolean, password: boolean}
      table.text('methods').notNullable()
      table
        .integer('template_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('portal_templates')
        .onDelete('SET NULL')
      // string[]
      table.text('csp_connect_src').nullable()
      table.text('privacy_notice').nullable()
      table.integer('revision').unsigned().notNullable().defaultTo(1)
      table.integer('applied_revision').unsigned().nullable()
      // Last `portal.configure` result.
      table.text('status').nullable()
      table.datetime('deleted_at').nullable()
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.index(['gateway_id'], 'portals_gateway_idx')
    })
    this.schema.raw(
      'ALTER TABLE portals ADD COLUMN active_network VARCHAR(24) ' +
        'AS (IF(deleted_at IS NULL, network_perch_id, NULL)) PERSISTENT'
    )
    this.schema.raw(
      'CREATE UNIQUE INDEX portals_gateway_active_network_unique_idx ' +
        'ON portals (gateway_id, active_network)'
    )
  }

  async down() {
    this.schema.dropTable('portals')
  }
}
