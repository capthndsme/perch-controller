import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Every try of a delivery (docs/design/alerts/delivery.md §5): time,
 * duration, status code, outcome, error, a response excerpt.
 */
export default class extends BaseSchema {
  protected tableName = 'alert_delivery_attempts'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table
        .bigInteger('delivery_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('alert_deliveries')
        .onDelete('CASCADE')
      table.datetime('attempted_at').notNullable()
      table.integer('duration_ms').unsigned().notNullable().defaultTo(0)
      table.smallint('status_code').unsigned().nullable()
      table.enum('outcome', ['sent', 'retry', 'failed']).notNullable()
      table.string('error', 300).nullable()
      table.string('response_excerpt', 512).nullable()

      table.index(['delivery_id'], 'alert_delivery_attempts_delivery_idx')
      table.index(['attempted_at'], 'alert_delivery_attempts_time_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
