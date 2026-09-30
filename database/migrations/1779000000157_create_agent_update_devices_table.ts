import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Agent updates (docs/design/agent-updates/controller.md section 2.3): the
 * per-device update settings (channel, auto-update, "hold at") and the last
 * `update` status block the device reported. Exactly one of `ap_id` /
 * `collector_id` is set (the `infra_nodes` pattern); the row goes with its
 * device (CASCADE).
 *
 * `facts` (not in the design's table): what the session said about the host
 * that the device rows do not keep, e.g. a collector's `system.arch` from its
 * hello, so the manual update command can be built while it is offline.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('agent_update_devices', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('ap_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('wifi_access_points')
        .onDelete('CASCADE')
      table
        .integer('collector_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('collectors')
        .onDelete('CASCADE')
      table.string('channel', 8).nullable()
      table.string('auto_update', 8).notNullable().defaultTo('inherit')
      table.string('pinned_version', 64).nullable()
      table.specificType('report', 'mediumtext').nullable()
      table.datetime('reported_at').nullable()
      table.string('version_seen', 64).nullable()
      table.text('facts').nullable()
      table.datetime('updated_at').notNullable()

      table.unique(['ap_id'], 'agent_update_devices_ap_id_unique_idx')
      table.unique(['collector_id'], 'agent_update_devices_collector_id_unique_idx')
    })
  }

  async down() {
    this.schema.dropTable('agent_update_devices')
  }
}
