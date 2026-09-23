import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * What each access point holds of the device groups' Wi-Fi (perch-apd
 * `groups.*`, docs/gateway/device-groups.md section 7): the desired state's
 * fingerprint and revision, the revision the AP confirmed, the apply state
 * and the AP's last report (trunk port, stations on group VLANs).
 */
export default class extends BaseSchema {
  protected tableName = 'ap_group_states'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.collate('utf8mb4_unicode_ci')

      table
        .integer('ap_id')
        .unsigned()
        .notNullable()
        .primary()
        .references('id')
        .inTable('wifi_access_points')
        .onDelete('CASCADE')
      table.string('fingerprint', 64).nullable()
      table.integer('revision').unsigned().notNullable().defaultTo(0)
      table.integer('applied_revision').unsigned().nullable()
      table.string('state', 16).notNullable().defaultTo('idle')
      table.string('error', 500).nullable()
      table.string('trunk_port', 32).nullable()
      table.boolean('converted').notNullable().defaultTo(false)
      table.text('stations').nullable()
      table.datetime('reported_at').nullable()
      table.datetime('updated_at').nullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
