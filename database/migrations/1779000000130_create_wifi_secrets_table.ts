import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Wi-Fi passphrases the controller knows (docs/design/wifi controller.md
 * section 4.4): one row per network passphrase, used on every AP that
 * carries the network. `value` is APP_KEY-encrypted and never serialised;
 * `fingerprint` is the unbound `hmac:` form every AP reports for the same
 * value (protocol.md 3.2); `digest` (SHA-256 hex) is what the device-group
 * PSK guard compares, so the guard never needs the value.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('wifi_secrets', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table.string('ref', 48).notNullable()
      table.text('value').notNullable()
      table.string('fingerprint', 24).notNullable()
      table.specificType('digest', 'char(64)').notNullable()
      table
        .integer('created_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.unique(['ref'], 'wifi_secrets_ref_unique_idx')
    })
  }

  async down() {
    this.schema.dropTable('wifi_secrets')
  }
}
