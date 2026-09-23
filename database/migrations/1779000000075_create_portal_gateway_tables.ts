import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Per-gateway portal state and the portal audit log
 * (docs/gateway/portal.md sections 5 and 7).
 *
 * - `portal_gateway_states`: one row per gateway that has portals. The router
 *   keeps one event journal for all its portals, so `acked_event_seq` lives
 *   here, not on `portals`. `key_epoch` is the epoch of the gateway key
 *   (bump = rotate the router's keys); `router_key_epoch` the one the router
 *   last reported holding.
 * - `portal_events`: what reconciliation logs (outside authorizations undone,
 *   offline redemptions, lost grants, journal gaps). Pruned with sessions.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('portal_gateway_states', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table
        .integer('gateway_id')
        .unsigned()
        .notNullable()
        .primary()
        .references('id')
        .inTable('gateways')
        .onDelete('CASCADE')
      table.bigInteger('acked_event_seq').unsigned().notNullable().defaultTo(0)
      table.integer('key_epoch').unsigned().notNullable().defaultTo(1)
      table.integer('router_key_epoch').unsigned().nullable()
      table.datetime('last_sync_at').nullable()
      table.datetime('last_report_at').nullable()
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()
    })

    this.schema.createTable('portal_events', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table
        .integer('gateway_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('gateways')
        .onDelete('CASCADE')
      table
        .integer('portal_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('portals')
        .onDelete('CASCADE')
      table
        .bigInteger('grant_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('portal_grants')
        .onDelete('SET NULL')
      table.specificType('mac', 'CHAR(17)').nullable()
      table.string('type', 32).notNullable()
      table.text('detail').nullable()
      table.datetime('created_at').notNullable()

      table.index(['gateway_id', 'created_at'], 'portal_events_gateway_time_idx')
      table.index(['created_at'], 'portal_events_time_idx')
    })
  }

  async down() {
    this.schema.dropTable('portal_events')
    this.schema.dropTable('portal_gateway_states')
  }
}
