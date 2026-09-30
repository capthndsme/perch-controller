import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Webhook destinations (docs/design/alerts/delivery.md §2). The URL, the
 * Standard Webhooks signing secret and the auth are APP_KEY-encrypted
 * (Discord/Slack URLs and Home Assistant webhook ids are secrets);
 * `url_display` is the masked form the API shows. `options` and `filters`
 * are non-secret JSON.
 */
export default class extends BaseSchema {
  protected tableName = 'alert_webhooks'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table.string('name', 60).notNullable()
      table
        .enum('format', ['standard', 'ntfy', 'gotify', 'discord', 'slack', 'telegram'])
        .notNullable()
      table.string('preset', 24).nullable()
      table.text('url_encrypted').notNullable()
      table.string('url_display', 160).notNullable()
      table.text('secret_encrypted').nullable()
      table.text('auth_encrypted').nullable()
      table.text('options').nullable()
      table.text('filters').notNullable()
      table.enum('detail', ['full', 'minimal']).notNullable().defaultTo('full')
      table.boolean('respect_quiet_hours').notNullable().defaultTo(true)
      table.boolean('enabled').notNullable().defaultTo(true)
      table.enum('state', ['active', 'failing', 'needs_secret']).notNullable().defaultTo('active')
      table.smallint('consecutive_failures').unsigned().notNullable().defaultTo(0)
      table.datetime('last_success_at').nullable()
      table.datetime('last_failure_at').nullable()
      table.string('last_error', 300).nullable()
      table
        .integer('created_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
