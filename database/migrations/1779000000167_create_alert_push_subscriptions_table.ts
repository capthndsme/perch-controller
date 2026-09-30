import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Web Push subscriptions (docs/design/alerts/delivery.md §1): one row per
 * browser install, owned by the user who subscribed it. `endpoint_hash`
 * (sha256 hex of the endpoint) is the upsert key; `renew_token_hash` lets the
 * service worker renew a replaced subscription without a bearer token.
 */
export default class extends BaseSchema {
  protected tableName = 'alert_push_subscriptions'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('user_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('users')
        .onDelete('CASCADE')
      table.text('endpoint').notNullable()
      table.string('endpoint_hash', 64).notNullable()
      table.string('push_service', 16).notNullable()
      table.string('p256dh', 128).notNullable()
      table.string('auth', 64).notNullable()
      table.string('vapid_key_id', 32).notNullable()
      table.datetime('expiration_at').nullable()
      table.string('label', 80).nullable()
      table.string('platform', 80).nullable()
      table.text('filters').notNullable()
      table.boolean('enabled').notNullable().defaultTo(true)
      table.enum('state', ['active', 'failing', 'gone']).notNullable().defaultTo('active')
      table.smallint('consecutive_failures').unsigned().notNullable().defaultTo(0)
      table.datetime('last_success_at').nullable()
      table.datetime('last_failure_at').nullable()
      table.string('last_error', 300).nullable()
      table.string('renew_token_hash', 64).nullable()
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.unique(['endpoint_hash'], 'alert_push_subscriptions_endpoint_unique')
      table.index(['user_id'], 'alert_push_subscriptions_user_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
