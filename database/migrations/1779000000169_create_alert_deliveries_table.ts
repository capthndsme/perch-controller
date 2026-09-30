import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * One notification to one destination (docs/design/alerts/delivery.md §3–5):
 * a push subscription or a webhook. Retries survive restarts because the
 * schedule is in the row (`next_attempt_at`, `expires_at`). `message_id`
 * (`msg_` + 26 base32) is the Standard Webhooks `webhook-id`, the same on
 * every retry. `items` holds the alert ids of a group or digest (≤ 50).
 * `alert_id` is NULL for tests and digests of several alerts.
 */
export default class extends BaseSchema {
  protected tableName = 'alert_deliveries'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table
        .bigInteger('alert_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('alerts')
        .onDelete('CASCADE')
      table.enum('destination_kind', ['push', 'webhook']).notNullable()
      table
        .integer('push_subscription_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('alert_push_subscriptions')
        .onDelete('CASCADE')
      table
        .integer('webhook_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('alert_webhooks')
        .onDelete('CASCADE')
      table
        .enum('transition', [
          'opened',
          'escalated',
          'flapping',
          'reminder',
          'resolved',
          'digest',
          'test',
        ])
        .notNullable()
      table
        .enum('status', [
          'queued',
          'grouping',
          'held',
          'sending',
          'retrying',
          'sent',
          'failed',
          'expired',
          'collapsed',
        ])
        .notNullable()
      table.string('hold_reason', 16).nullable()
      table.string('group_key', 191).nullable()
      table.text('items').nullable()
      table.string('message_id', 40).notNullable()
      table.enum('severity', ['info', 'warning', 'critical']).notNullable()
      table.smallint('attempts').unsigned().notNullable().defaultTo(0)
      table.datetime('send_after').notNullable()
      table.datetime('next_attempt_at').nullable()
      table.datetime('expires_at').notNullable()
      table.smallint('last_status_code').unsigned().nullable()
      table.string('last_error', 300).nullable()
      table.datetime('sent_at').nullable()
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.unique(['message_id'], 'alert_deliveries_message_id_unique')
      table.index(['status', 'next_attempt_at'], 'alert_deliveries_due_idx')
      table.index(['alert_id'], 'alert_deliveries_alert_idx')
      table.index(['push_subscription_id', 'created_at'], 'alert_deliveries_push_idx')
      table.index(['webhook_id', 'created_at'], 'alert_deliveries_webhook_idx')
      table.index(['group_key', 'status'], 'alert_deliveries_group_idx')
      table.index(['created_at'], 'alert_deliveries_created_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
