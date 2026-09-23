import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * QoS assignments (docs/gateway/qos.md section 4; plan 3 section 3.3): who
 * gets which cap. `target_type` is `device` (`mac`), `group` (`group_id`) or
 * `network` (`network`, a UCI interface name: the network default the router
 * applies to MACs without an entry of their own).
 *
 * Precedence per MAC (`app/services/qos_plan.ts`): the device's own
 * assignment, else its group's, else its network's default.
 *
 * - `policy_id` null = a plain rate (`down_kbit` / `up_kbit`, 0 = unlimited
 *   that way, both NULL = none). With a policy, the rate overrides the
 *   policy's `each` cap for this target.
 * - Quota (`quota_*`, device targets only): counted and enforced on the
 *   router, persisted here (`quota_used_bytes`), `on_exhausted` block |
 *   throttle (to `throttle_*`).
 * - `source` admin | portal with `source_ref` (`voucher:<id>`): the portal's
 *   idempotency key. The portal never overrides an admin assignment.
 *
 * One assignment per MAC, group and network per gateway (unique indexes;
 * MariaDB lets the NULLs of the other target types repeat).
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('qos_assignments', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('gateway_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('gateways')
        .onDelete('CASCADE')
      table
        .integer('policy_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('qos_policies')
        .onDelete('CASCADE')
      table.string('target_type', 8).notNullable()
      table.string('mac', 17).nullable()
      table
        .integer('group_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('qos_groups')
        .onDelete('CASCADE')
      table.string('network', 32).nullable()
      table.integer('down_kbit').unsigned().nullable()
      table.integer('up_kbit').unsigned().nullable()
      table.bigInteger('quota_bytes').unsigned().nullable()
      table.bigInteger('quota_used_bytes').unsigned().notNullable().defaultTo(0)
      table.string('quota_on_exhausted', 8).nullable()
      table.integer('throttle_down_kbit').unsigned().nullable()
      table.integer('throttle_up_kbit').unsigned().nullable()
      table.datetime('exhausted_at').nullable()
      table.datetime('expires_at').nullable()
      table.string('source', 8).notNullable().defaultTo('admin')
      table.string('source_ref', 64).nullable()
      table
        .integer('created_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.unique(['gateway_id', 'mac'], 'qos_assignments_gateway_mac_unique_idx')
      table.unique(['gateway_id', 'group_id'], 'qos_assignments_gateway_group_unique_idx')
      table.unique(['gateway_id', 'network'], 'qos_assignments_gateway_network_unique_idx')
      table.unique(['source', 'source_ref'], 'qos_assignments_source_ref_unique_idx')
      // qos_expire.task.ts: the next expiry per gateway.
      table.index(['gateway_id', 'expires_at'], 'qos_assignments_gateway_expires_idx')
    })
  }

  async down() {
    this.schema.dropTable('qos_assignments')
  }
}
