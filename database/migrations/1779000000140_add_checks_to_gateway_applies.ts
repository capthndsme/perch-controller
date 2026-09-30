import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Apply checks (docs/design/gateway-sync/domains.md 1.5, protocol.md 1): a
 * job may carry health checks the router runs after the commit (interface
 * up, default route, reach, resolve, WireGuard handshake); it refuses the
 * confirm until they pass and rolls back early when they cannot.
 *
 * - `checks`: JSON, what was sent (`{v, timeoutSeconds, items}`; `items: []`
 *   = the admin confirmed "no checks"); the agent's own net lands here too.
 * - `check_results`: JSON, the agent's last report (the apply reply's
 *   baseline, `gateway.config.checks`, the hello's `apply.checks`, a result).
 * - `checks_state`: pending | running | passed | failed | overridden; NULL =
 *   nothing gates the confirm (no checks, or an agent that ignored them).
 * - `checks_overridden_by_user_id` / `_at`: the admin's "Keep anyway".
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('gateway_applies', (table) => {
      table.text('checks').nullable()
      table.text('check_results').nullable()
      table.string('checks_state', 12).nullable()
      table
        .integer('checks_overridden_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.datetime('checks_overridden_at').nullable()
    })
  }

  async down() {
    this.schema.alterTable('gateway_applies', (table) => {
      table.dropForeign(['checks_overridden_by_user_id'])
      table.dropColumn('checks_overridden_at')
      table.dropColumn('checks_overridden_by_user_id')
      table.dropColumn('checks_state')
      table.dropColumn('check_results')
      table.dropColumn('checks')
    })
  }
}
