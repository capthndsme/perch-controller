import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Per-gateway QoS delivery state (docs/gateway/qos.md section 6): the
 * controller's pause, the `qos.devices.set` revision counter (monotonic across
 * restarts, so the agent never sees a revision go backwards) and what the
 * sender last handed to the router. One row per gateway, created on first use.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('qos_gateway_states', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('gateway_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('gateways')
        .onDelete('CASCADE')
      // POST /qos/pause: `globals.enabled '0'` in the planned perch-qos.
      table.datetime('paused_at').nullable()
      table
        .integer('paused_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      // The last `qos.devices.set` revision handed out, and the one the agent accepted.
      table.bigInteger('devices_revision').unsigned().notNullable().defaultTo(0)
      table.bigInteger('devices_acked_revision').unsigned().nullable()
      table.datetime('devices_acked_at').nullable()
      // The perch-qos sections the config plane last accepted (sha256 of the plan's sections).
      table.string('config_fingerprint', 64).nullable()
      table.integer('config_revision').unsigned().nullable()
      table.datetime('config_submitted_at').nullable()
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.unique(['gateway_id'], 'qos_gateway_states_gateway_unique_idx')
    })
  }

  async down() {
    this.schema.dropTable('qos_gateway_states')
  }
}
