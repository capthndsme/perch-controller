import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Small per-detector key/value state (docs/design/alerts/README.md §3):
 * watermarks of the scans, remembered WANs, the controller heartbeat and
 * shutdown marker, port counter baselines. Small by construction.
 */
export default class extends BaseSchema {
  protected tableName = 'alert_detector_states'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.string('detector', 48).notNullable()
      table.string('state_key', 191).notNullable()
      table.text('value').notNullable()
      table.datetime('updated_at').nullable()

      table.primary(['detector', 'state_key'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
