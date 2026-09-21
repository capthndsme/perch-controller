import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'ap_system_snapshots'

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

      table.float('load_1').nullable()
      table.float('load_5').nullable()
      table.float('load_15').nullable()
      table.bigInteger('mem_total').unsigned().nullable()
      table.bigInteger('mem_available').unsigned().nullable()
      table.integer('conntrack_entries').unsigned().nullable()
      table.integer('conntrack_limit').unsigned().nullable()
      table.integer('uptime_seconds').unsigned().nullable()

      table.datetime('recorded_at').notNullable()

      table.index(['ap_id', 'recorded_at'], 'ap_system_snapshots_ap_time_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
