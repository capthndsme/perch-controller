import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * QoS schedules (owner decision 16, 2026-09-23; docs/gateway/qos.md section
 * 4.6): a weekly time window in which a policy or an assignment behaves
 * differently, e.g. the kids' group blocked at night, or the guest bucket
 * halved in the evening. The controller evaluates them
 * (`app/services/qos_plan.ts`) into `perch-qos` data.
 *
 * Target: `target_type` policy (`policy_id`) or assignment
 * (`assignment_id`), exactly one set. `action`:
 * - `limit`: other rates for the window. A policy target reads
 *   `shared_*` / `each_*`, an assignment target `rate_*`; a NULL column
 *   keeps the target's own value, 0 = unlimited that way.
 * - `unlimited`: the target's caps are lifted for the window.
 * - `block` (assignment targets on devices or groups): no internet for the
 *   window; the router's pass rules still let DNS and the portal through.
 * - `policy` (assignment targets): use `use_policy_id` for the window.
 *
 * Window: `days` is a bitmask of the start day (bit 0 = Monday … bit 6 =
 * Sunday); `start_minute` / `end_minute` are minutes after midnight on the
 * gateway's clock (0-1439). `end_minute <= start_minute` runs past midnight
 * into the next day; equal means a full 24 hours from the start.
 *
 * The router evaluates the windows itself (kernel spike amendment section 6:
 * rates change and MACs move hitlessly), so schedules keep working while the
 * controller is away; the planner renders them as `config schedule`
 * sections of `perch-qos`, never as applies at the window edges.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('qos_schedules', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('gateway_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('gateways')
        .onDelete('CASCADE')
      table.string('name', 64).notNullable()
      table.boolean('enabled').notNullable().defaultTo(true)
      table.string('target_type', 12).notNullable()
      table
        .integer('policy_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('qos_policies')
        .onDelete('CASCADE')
      table
        .integer('assignment_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('qos_assignments')
        .onDelete('CASCADE')
      table.string('action', 12).notNullable()
      table
        .integer('use_policy_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('qos_policies')
        .onDelete('CASCADE')
      table.integer('shared_down_kbit').unsigned().nullable()
      table.integer('shared_up_kbit').unsigned().nullable()
      table.integer('each_down_kbit').unsigned().nullable()
      table.integer('each_up_kbit').unsigned().nullable()
      table.integer('rate_down_kbit').unsigned().nullable()
      table.integer('rate_up_kbit').unsigned().nullable()
      table.smallint('days').unsigned().notNullable().defaultTo(127)
      table.smallint('start_minute').unsigned().notNullable()
      table.smallint('end_minute').unsigned().notNullable()
      table
        .integer('created_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.index(['gateway_id'], 'qos_schedules_gateway_idx')
    })
  }

  async down() {
    this.schema.dropTable('qos_schedules')
  }
}
