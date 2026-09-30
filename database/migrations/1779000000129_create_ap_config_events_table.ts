import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The Wi-Fi plane's audit log per AP (docs/design/wifi controller.md section
 * 2): the `gateway_config_events` shape with `ap_id` and `system_actor`.
 * Pruned after the Wi-Fi setting `auditRetentionDays`.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('ap_config_events', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table
        .integer('ap_id')
        .unsigned()
        .notNullable()
        .references('ap_id')
        .inTable('ap_configs')
        .onDelete('CASCADE')
      table
        .integer('user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.string('system_actor', 16).nullable()
      table
        .bigInteger('apply_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('ap_config_applies')
        .onDelete('SET NULL')
      table.integer('revision_number').unsigned().nullable()
      table.string('event', 32).notNullable()
      table.text('detail').nullable()
      table.datetime('created_at').notNullable()

      table.index(['ap_id', 'created_at'], 'ap_config_events_ap_time_idx')
      table.index(['created_at'], 'ap_config_events_time_idx')
    })
  }

  async down() {
    this.schema.dropTable('ap_config_events')
  }
}
