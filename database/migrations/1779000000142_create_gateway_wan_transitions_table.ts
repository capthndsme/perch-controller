import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * WAN transitions (docs/design/gateway-sync/README.md 7 and 14): what the
 * `interfaces` observation showed changing on an internet WAN (`down`, `up`,
 * `failover` of the primary default route, `ip_changed`, `prefix_changed`).
 * The WAN page's history and the alerts area's source. Pruned daily after
 * Settings → Gateway sync `transitionRetentionDays`
 * (`gateway_wan_retention.task.ts`).
 */
export default class extends BaseSchema {
  protected tableName = 'gateway_wan_transitions'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table
        .integer('gateway_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('gateways')
        .onDelete('CASCADE')
      table.string('network', 32).notNullable()
      table.string('device', 32).nullable()
      // down | up | failover | ip_changed | prefix_changed
      table.string('event', 16).notNullable()
      table.text('detail').nullable()
      table.datetime('at').notNullable()

      table.index(['gateway_id', 'at'], 'gateway_wan_transitions_gateway_at_idx')
      table.index(['at'], 'gateway_wan_transitions_at_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
