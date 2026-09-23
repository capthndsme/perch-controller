import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * `sysupgrade -b` archives pulled from the router over the `gateway.backup`
 * RPC (docs/gateway/observation.md; plan-2-native-sync.md sections 3 and
 * 4.5). The archive holds secrets (Wi-Fi keys, WireGuard private keys, the
 * collector's api_key), so `content` is the Adonis-encrypted archive and
 * never appears in a list body. The newest `backupsKept` (default 10) per
 * collector are kept. CASCADE with the collector; moves with a merge.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('gateway_backups', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('collector_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('collectors')
        .onDelete('CASCADE')
      table.datetime('created_at').notNullable()
      // Archive size in bytes (before encryption) and its SHA-256.
      table.integer('size').unsigned().notNullable()
      table.string('sha256', 64).notNullable()
      table.string('release', 128).nullable()
      // The agent's name for the archive (`backup-<host>-<date>.tar.gz`).
      table.string('filename', 128).nullable()
      // Secrets replaced by the agent (the default); `redactions` lists them (JSON).
      table.boolean('redacted').notNullable().defaultTo(true)
      table.text('redactions').nullable()
      // Encrypted (Adonis encryption) base64 of the archive: ~1.8 × size.
      table.specificType('content', 'LONGBLOB').notNullable()
      table
        .integer('requested_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.string('note', 200).nullable()

      table.index(['collector_id', 'created_at'], 'gateway_backups_collector_created_idx')
    })
  }

  async down() {
    this.schema.dropTable('gateway_backups')
  }
}
