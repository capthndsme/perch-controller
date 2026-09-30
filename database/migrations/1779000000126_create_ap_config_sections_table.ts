import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * One UCI section of an AP's `wireless` or `network` config (docs/design/wifi
 * controller.md section 2): the columns of `gateway_sections`
 * (docs/gateway/config-plane.md section 9) with `ap_id` instead of
 * `gateway_id`. For synced sections B (`base_content`), R (`router_content`)
 * and C (`desired_content`) as canonical JSON `{type, options, secrets?}`,
 * null = absent; `ownership` null = the whole section.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('ap_config_sections', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table
        .integer('ap_id')
        .unsigned()
        .notNullable()
        .references('ap_id')
        .inTable('ap_configs')
        .onDelete('CASCADE')
      table.string('perch_id', 24).notNullable()
      table.string('config', 32).notNullable()
      table.string('section_name', 64).notNullable()
      table.string('section_type', 32).notNullable()
      table.boolean('anonymous').notNullable().defaultTo(false)
      // synced | excluded | unmodeled
      table.string('scope', 12).notNullable()
      table.string('domain', 32).nullable()
      table.text('ownership').nullable()
      table.string('issue', 24).nullable()
      table.text('base_content', 'mediumtext').nullable()
      table.integer('base_revision').unsigned().nullable()
      table.text('router_content', 'mediumtext').nullable()
      table.text('router_author').nullable()
      table.datetime('router_changed_at').nullable()
      table.text('desired_content', 'mediumtext').nullable()
      // in_sync | ahead | pending | conflict | drift | reverting
      table.string('status', 12).notNullable().defaultTo('in_sync')
      table.text('conflict').nullable()
      table.datetime('drift_since').nullable()
      table.integer('position').nullable()
      table
        .integer('updated_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.unique(['ap_id', 'perch_id'], 'ap_config_sections_ap_perch_unique_idx')
      table.unique(['ap_id', 'config', 'section_name'], 'ap_config_sections_ap_section_unique_idx')
      table.index(['ap_id', 'status'], 'ap_config_sections_ap_status_idx')
    })
  }

  async down() {
    this.schema.dropTable('ap_config_sections')
  }
}
