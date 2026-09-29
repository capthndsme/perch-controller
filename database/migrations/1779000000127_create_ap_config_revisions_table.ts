import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The linear history of an AP's agreed Wi-Fi/network state (docs/design/wifi
 * controller.md section 2): the columns of `gateway_revisions` with `ap_id`,
 * plus `rollout_id` (the fleet rollout a controller revision came from).
 * `confirmed_at` marks a state known to work on the AP; a reset AP is
 * offered the newest confirmed revision, never simply the newest one.
 *
 * `apply_id` gets its foreign key to `ap_config_applies` in migration 128
 * (that table is created there).
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('ap_config_revisions', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table
        .integer('ap_id')
        .unsigned()
        .notNullable()
        .references('ap_id')
        .inTable('ap_configs')
        .onDelete('CASCADE')
      table.integer('number').unsigned().notNullable()
      // import | router | controller | merge | revert | rollback
      table.string('source', 12).notNullable()
      table
        .integer('author_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.string('system_actor', 16).nullable()
      table.text('router_author').nullable()
      table.string('summary', 255).notNullable()
      table.string('note', 500).nullable()
      table.text('snapshot', 'longtext').notNullable()
      table.text('diff', 'mediumtext').notNullable()
      table.text('hashes').notNullable()
      table.bigInteger('apply_id').unsigned().nullable()
      table.bigInteger('rollout_id').unsigned().nullable()
      table.datetime('confirmed_at').nullable()
      table.datetime('created_at').notNullable()

      table.unique(['ap_id', 'number'], 'ap_config_revisions_ap_number_unique_idx')
      table.index(['ap_id', 'confirmed_at'], 'ap_config_revisions_ap_confirmed_idx')
    })
  }

  async down() {
    this.schema.dropTable('ap_config_revisions')
  }
}
