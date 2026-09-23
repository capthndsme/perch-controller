import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Guest identities other than vouchers (docs/gateway/portal.md section 5).
 *
 * - `portal_users`: portal logins, never controller `users` (the portal is
 *   plain HTTP on the guest network, so anything typed there can be
 *   sniffed). `password` is a scrypt hash (`config/hash.ts`). `portal_ids`
 *   JSON number[] or null = every portal.
 * - `portal_api_clients`: integration tokens (`perch_pa_` + 32 base64url);
 *   only the SHA-256 is stored. `scopes`, `portal_ids`: JSON arrays.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('portal_users', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table.string('username', 32).notNullable()
      table.string('display_name', 80).nullable()
      table.string('password', 255).notNullable()
      table.boolean('enabled').notNullable().defaultTo(true)
      table.smallint('max_devices').unsigned().notNullable().defaultTo(2)
      table.integer('session_minutes').unsigned().nullable()
      table.integer('down_kbps').unsigned().nullable()
      table.integer('up_kbps').unsigned().nullable()
      table.text('portal_ids').nullable()
      table.integer('revision').unsigned().notNullable().defaultTo(1)
      table.datetime('last_login_at').nullable()
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.unique(['username'], 'portal_users_username_unique_idx')
    })

    this.schema.createTable('portal_api_clients', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table.string('name', 80).notNullable()
      table.specificType('token_hash', 'CHAR(64)').notNullable()
      table.string('token_prefix', 16).notNullable()
      table.text('scopes').notNullable()
      table.text('portal_ids').notNullable()
      table.integer('max_minutes_per_call').unsigned().notNullable().defaultTo(1440)
      table.bigInteger('max_bytes_per_call').unsigned().notNullable().defaultTo(10_000_000_000)
      table.integer('max_active_grants').unsigned().notNullable().defaultTo(500)
      table
        .integer('created_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.datetime('last_used_at').nullable()
      table.datetime('revoked_at').nullable()
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.unique(['token_hash'], 'portal_api_clients_token_hash_unique_idx')
    })
  }

  async down() {
    this.schema.dropTable('portal_api_clients')
    this.schema.dropTable('portal_users')
  }
}
