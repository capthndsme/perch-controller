import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The collector socket's per-gateway portal state (docs/gateway/portal.md
 * section 13, WP3):
 *
 * - `config_revision`: the revision of the last `portal.configure` built for
 *   the gateway (one message carries all its portals); `router_config_revision`
 *   the one the router last acknowledged, `configured_at` when.
 * - `router_status`: the last `portal.configure` result (enforcement,
 *   storage, issues), JSON; `capabilities`: the hello's `portal` object, JSON,
 *   `capabilities_at` when it was seen. Null = the router never said.
 * - `delivery_failures` / `delivery_error` / `delivery_failed_at`: the
 *   outbox retry state (reset on the next successful delivery), for the
 *   backoff and for the dashboard.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('portal_gateway_states', (table) => {
      table.integer('config_revision').unsigned().notNullable().defaultTo(0)
      table.integer('router_config_revision').unsigned().nullable()
      table.datetime('configured_at').nullable()
      table.text('router_status').nullable()
      table.text('capabilities').nullable()
      table.datetime('capabilities_at').nullable()
      table.integer('delivery_failures').unsigned().notNullable().defaultTo(0)
      table.string('delivery_error', 255).nullable()
      table.datetime('delivery_failed_at').nullable()
    })
  }

  async down() {
    this.schema.alterTable('portal_gateway_states', (table) => {
      table.dropColumn('config_revision')
      table.dropColumn('router_config_revision')
      table.dropColumn('configured_at')
      table.dropColumn('router_status')
      table.dropColumn('capabilities')
      table.dropColumn('capabilities_at')
      table.dropColumn('delivery_failures')
      table.dropColumn('delivery_error')
      table.dropColumn('delivery_failed_at')
    })
  }
}
