import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * One AP's step of a rollout (docs/design/wifi controller.md section 6.4):
 * `state` pending | waiting_offline | applying | confirmed | noop | failed |
 * rolled_back | skipped | cancelled; `perch_ids` (JSON) the sections it
 * carries; `apply_id` the job running it (the chain's latest); `outcome`
 * (JSON) {reason, error, message}.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('wifi_rollout_steps', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.bigIncrements('id').notNullable()
      table
        .bigInteger('rollout_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('wifi_rollouts')
        .onDelete('CASCADE')
      table
        .integer('ap_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('wifi_access_points')
        .onDelete('CASCADE')
      table.smallint('position').unsigned().notNullable()
      table.string('state', 16).notNullable()
      table.text('perch_ids').notNullable()
      table
        .bigInteger('apply_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('ap_config_applies')
        .onDelete('SET NULL')
      table.datetime('started_at').nullable()
      table.datetime('finished_at').nullable()
      table.text('outcome').nullable()

      table.unique(['rollout_id', 'ap_id'], 'wifi_rollout_steps_rollout_ap_unique_idx')
    })
  }

  async down() {
    this.schema.dropTable('wifi_rollout_steps')
  }
}
