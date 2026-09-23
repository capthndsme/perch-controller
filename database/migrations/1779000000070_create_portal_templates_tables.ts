import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Guest portal page templates (docs/gateway/portal.md section 5).
 *
 * - `portal_templates`: a named set of files. `sha256` is the digest of the
 *   whole set (what `portal.configure` compares with the router's copy);
 *   `builtin` rows are read-only. One builtin row is seeded here: it has no
 *   files, which tells the collector to serve its compiled-in pages.
 * - `portal_template_files`: the files themselves (MEDIUMBLOB, at most
 *   512 KiB each and 2 MiB per template, checked by the upload route).
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('portal_templates', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table.string('name', 80).notNullable()
      table.boolean('builtin').notNullable().defaultTo(false)
      table.specificType('sha256', 'CHAR(64)').notNullable()
      table.integer('total_bytes').unsigned().notNullable().defaultTo(0)
      table
        .integer('created_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()
    })

    this.schema.createTable('portal_template_files', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('template_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('portal_templates')
        .onDelete('CASCADE')
      table.string('name', 64).notNullable()
      table.string('content_type', 64).notNullable()
      table.integer('bytes').unsigned().notNullable()
      table.specificType('sha256', 'CHAR(64)').notNullable()
      table.specificType('content', 'MEDIUMBLOB').notNullable()
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.unique(['template_id', 'name'], 'portal_template_files_template_name_unique_idx')
    })

    this.defer(async (db) => {
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
      await db.table('portal_templates').insert({
        name: 'Perch default',
        builtin: true,
        // SHA-256 of the empty file set: the collector's compiled-in pages.
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        total_bytes: 0,
        created_by_user_id: null,
        created_at: now,
        updated_at: now,
      })
    })
  }

  async down() {
    this.schema.dropTable('portal_template_files')
    this.schema.dropTable('portal_templates')
  }
}
