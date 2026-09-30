import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Agent updates (docs/design/agent-updates/controller.md section 2.2): the
 * artefacts a release manifest lists, one row each, created with the release.
 *
 * `stored_path` (relative to the store root `<data dir>/agent-artefacts`) is
 * set once the file was fetched from GitHub or uploaded and matched the
 * manifest's size and SHA-256; retention clears it again when it deletes the
 * file (the row stays, re-fetchable from `source_url`).
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('agent_artefacts', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('release_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('agent_releases')
        .onDelete('CASCADE')
      table.string('file_name', 128).notNullable()
      table.string('kind', 8).notNullable()
      table.string('arch', 16).nullable()
      table.string('variant', 16).nullable()
      table.string('manager', 4).nullable()
      table.string('openwrt_series', 8).nullable()
      table.string('pkg_arch', 48).nullable()
      table.string('package_name', 64).nullable()
      table.string('package_version', 64).nullable()
      table.bigInteger('size_bytes').unsigned().notNullable()
      table.bigInteger('gzip_bytes').unsigned().nullable()
      table.specificType('sha256', 'char(64)').notNullable()
      table.string('source_url', 1000).nullable()
      table.string('stored_path', 500).nullable()
      table.datetime('stored_at').nullable()

      table.unique(['release_id', 'file_name'], 'agent_artefacts_release_file_unique_idx')
    })
  }

  async down() {
    this.schema.dropTable('agent_artefacts')
  }
}
