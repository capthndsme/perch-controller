import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Agent updates (docs/design/agent-updates/controller.md section 2.1): one row
 * per signed release of a Perch daemon the controller knows, from the GitHub
 * mirror or an owner upload.
 *
 * `manifest` holds the manifest bytes exactly as received (never
 * re-serialised; the signature is over them) and `signature` the detached
 * signify `.sig`. `version_sort` is `versions.versionSortKey()`, a byte-ordered
 * key (hence `utf8mb4_bin`) for ORDER BY; code orders with `compareVersions`.
 * A withdrawn release is no longer offered; devices running it are unaffected.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('agent_releases', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table.string('product', 32).notNullable()
      table.string('version', 64).notNullable()
      table.string('version_sort', 96).notNullable().collate('utf8mb4_bin')
      table.string('channel', 8).notNullable()
      table.string('source', 8).notNullable()
      table.specificType('manifest', 'mediumtext').notNullable()
      table.specificType('manifest_sha256', 'char(64)').notNullable()
      table.text('signature').notNullable()
      table.specificType('key_id', 'char(16)').notNullable()
      table.string('min_version', 64).nullable()
      table.string('min_from_version', 64).nullable()
      table.string('min_controller_version', 64).nullable()
      table.datetime('released_at').nullable()
      table.string('notes_url', 500).nullable()
      table.bigInteger('github_release_id').unsigned().nullable()
      table.datetime('imported_at').notNullable()
      table
        .integer('imported_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.datetime('withdrawn_at').nullable()
      table
        .integer('withdrawn_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')

      table.unique(['product', 'version'], 'agent_releases_product_version_unique_idx')
      table.index(['product', 'version_sort'], 'agent_releases_product_sort_idx')
    })
  }

  async down() {
    this.schema.dropTable('agent_releases')
  }
}
