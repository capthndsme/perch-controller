import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Join tokens for ap-controller agents (docs/ap-controller.md section 1.1).
 *
 * An admin creates one under Settings → Wi-Fi sources; an access point trades
 * it for its own credentials at `POST /api/v1/ap-agent/join`. The token is
 * looked up by its SHA-256 (`token_hash`) and also kept encrypted with
 * APP_KEY (`token_encrypted`) so the dashboard can show the install command
 * again later. Rows are never deleted: revoking sets `revoked_at`, which
 * keeps `wifi_access_points.join_token_id` meaningful.
 */
export default class extends BaseSchema {
  protected tableName = 'ap_join_tokens'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table.string('label', 80).nullable()
      table.string('token_hash', 64).notNullable()
      // `mlap_` + the first 4 random chars; enough to tell tokens apart.
      table.string('token_prefix', 16).notNullable()
      table.text('token_encrypted').notNullable()
      table
        .integer('created_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.timestamp('expires_at').nullable()
      table.integer('max_uses').unsigned().nullable()
      table.integer('use_count').unsigned().notNullable().defaultTo(0)
      table.timestamp('last_used_at').nullable()
      table.timestamp('revoked_at').nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.unique(['token_hash'], 'ap_join_tokens_token_hash_unique_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
