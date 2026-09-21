import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'wifi_access_points'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table.string('name', 120).notNullable()
      table.string('friendly_name', 120).nullable()
      table.string('metrics_url', 500).notNullable()
      table.integer('poll_interval_seconds').unsigned().notNullable().defaultTo(15)
      table.boolean('enabled').notNullable().defaultTo(true)

      // Optional two-way command channel (SSH).
      table.boolean('enable_two_way_commands').notNullable().defaultTo(false)
      table.string('ssh_host', 255).nullable()
      table.integer('ssh_port').unsigned().notNullable().defaultTo(22)
      table.string('ssh_username', 100).nullable()
      table.text('ssh_private_key').nullable()

      // Scraped identity fields from node_openwrt_info + node_uname_info.
      table.string('model', 120).nullable()
      table.string('openwrt_release', 50).nullable()
      table.string('nodename', 120).nullable()

      table.timestamp('last_seen_at').nullable()
      table.text('last_status').nullable()

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.index(['enabled'], 'wifi_access_points_enabled_idx')
      table.index(['metrics_url'], 'wifi_access_points_metrics_url_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
