import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'wifi_command_audits'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table
        .integer('ap_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('wifi_access_points')
        .onDelete('CASCADE')
      table
        .integer('executed_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')

      table.string('mac', 17).nullable()
      table.string('command', 64).notNullable()
      table.text('params').nullable()
      table.string('status', 16).notNullable()
      table.text('stdout').nullable()
      table.text('stderr').nullable()
      table.datetime('executed_at').notNullable()

      table.index(['ap_id', 'executed_at'], 'wifi_command_audits_ap_time_idx')
      table.index(['mac', 'executed_at'], 'wifi_command_audits_mac_time_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
