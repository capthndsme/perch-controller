import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * QoS policies (docs/gateway/qos.md section 4; plan 3 sections 3.3 and 4):
 * a speed cap an admin (or the captive portal, `source = 'portal'`) assigns
 * to devices, groups or networks.
 *
 * Rates are kbit/s. A pair of NULLs means the policy has no such part; once
 * a part exists, 0 means "unlimited that way":
 * - `shared_*`: the bucket everything assigned to the policy shares (an HTB
 *   inner class on the router, class minor `class_minor`).
 * - `each_*`: the cap every member gets on its own (a device leaf).
 * Both together = caps inside a ceiling (the Piso Wi-Fi case).
 *
 * Owner decisions 2026-09-23:
 * - 13: caps apply to internet traffic only; `include_lan` is the per-policy
 *   toggle that also shapes LAN-to-LAN traffic (default off).
 * - 16: nested buckets in v1. `parent_policy_id` puts this policy's bucket
 *   inside another policy's bucket (a voucher tier inside the guest bucket).
 *   SET NULL keeps a child when its parent row goes; the API refuses to
 *   delete a parent that still has children (`qos_policy_in_use`).
 *
 * `class_minor` (0x02-0xff) is assigned once per policy and never reused
 * while the row exists, so the router's class ids stay stable across edits.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('qos_policies', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('gateway_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('gateways')
        .onDelete('CASCADE')
      table.string('name', 64).notNullable()
      table.string('notes', 500).nullable()
      table.integer('shared_down_kbit').unsigned().nullable()
      table.integer('shared_up_kbit').unsigned().nullable()
      table.integer('each_down_kbit').unsigned().nullable()
      table.integer('each_up_kbit').unsigned().nullable()
      // per_host | per_flow: how the bucket's rest leaf shares (CAKE host
      // isolation or fq_codel flows).
      table.string('fairness', 12).notNullable().defaultTo('per_host')
      table.boolean('include_lan').notNullable().defaultTo(false)
      table
        .integer('parent_policy_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('qos_policies')
        .onDelete('SET NULL')
      table.boolean('enabled').notNullable().defaultTo(true)
      table.string('source', 8).notNullable().defaultTo('admin')
      // The portal's tier key (`ensureTierPolicy`), null for admin policies.
      table.string('source_ref', 64).nullable()
      table.smallint('class_minor').unsigned().notNullable()
      table
        .integer('created_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()

      table.unique(['gateway_id', 'name'], 'qos_policies_gateway_name_unique_idx')
      table.unique(['gateway_id', 'class_minor'], 'qos_policies_gateway_class_unique_idx')
      table.unique(
        ['gateway_id', 'source', 'source_ref'],
        'qos_policies_gateway_source_ref_unique_idx'
      )
    })
  }

  async down() {
    this.schema.dropTable('qos_policies')
  }
}
