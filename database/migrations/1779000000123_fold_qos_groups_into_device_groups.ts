import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Plan 3's QoS groups become device groups (decision 30): every qos_groups
 * row moves to device_groups with its id, name, notes and members, the
 * group assignments' foreign key follows, and the old tables go. `/qos/groups`
 * stays as a view of device groups.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('qos_assignments', (table) => {
      table.dropForeign(['group_id'])
    })
    this.defer(async (db) => {
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
      // A rollback of this step alone leaves the device groups in place:
      // those already there are kept, not inserted twice.
      const have = new Set(
        ((await db.from('device_groups').select('id')) as Array<{ id: number }>).map((r) => r.id)
      )
      const groups = await db.from('qos_groups').select('*')
      for (const g of groups) {
        if (have.has(g.id)) continue
        await db.table('device_groups').insert({
          id: g.id,
          gateway_id: g.gateway_id,
          name: g.name,
          notes: g.notes,
          network_perch_id: null,
          internet: true,
          portal_bypass: false,
          created_at: g.created_at ?? now,
          updated_at: g.updated_at,
        })
      }
      const taken = new Set(
        (
          (await db.from('device_group_members').select('gateway_id', 'mac')) as Array<{
            gateway_id: number
            mac: string
          }>
        ).map((r) => `${r.gateway_id}|${r.mac}`)
      )
      const members = await db.from('qos_group_members').select('*')
      for (const m of members) {
        if (taken.has(`${m.gateway_id}|${m.mac}`)) continue
        await db.table('device_group_members').insert({
          gateway_id: m.gateway_id,
          group_id: m.group_id,
          mac: m.mac,
          source: 'manual',
          created_at: m.created_at ?? now,
        })
      }
    })
    this.schema.alterTable('qos_assignments', (table) => {
      table.foreign('group_id').references('id').inTable('device_groups').onDelete('CASCADE')
    })
    this.schema.dropTable('qos_group_members')
    this.schema.dropTable('qos_groups')
  }

  async down() {
    this.schema.alterTable('qos_assignments', (table) => {
      table.dropForeign(['group_id'])
    })
    this.schema.createTable('qos_groups', (table) => {
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
      table.datetime('created_at').notNullable()
      table.datetime('updated_at').nullable()
      table.unique(['gateway_id', 'name'], 'qos_groups_gateway_name_unique_idx')
    })
    this.schema.createTable('qos_group_members', (table) => {
      table.collate('utf8mb4_unicode_ci')
      table.increments('id').notNullable()
      table
        .integer('gateway_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('gateways')
        .onDelete('CASCADE')
      table
        .integer('group_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('qos_groups')
        .onDelete('CASCADE')
      table.string('mac', 17).notNullable()
      table.datetime('created_at').notNullable()
      table.unique(['gateway_id', 'mac'], 'qos_group_members_gateway_mac_unique_idx')
      table.index(['group_id'], 'qos_group_members_group_idx')
    })
    this.defer(async (db) => {
      for (const g of await db.from('device_groups').select('*')) {
        await db.table('qos_groups').insert({
          id: g.id,
          gateway_id: g.gateway_id,
          name: g.name,
          notes: g.notes,
          created_at: g.created_at,
          updated_at: g.updated_at,
        })
      }
      for (const m of await db.from('device_group_members').select('*')) {
        await db.table('qos_group_members').insert({
          gateway_id: m.gateway_id,
          group_id: m.group_id,
          mac: m.mac,
          created_at: m.created_at,
        })
      }
    })
    this.schema.alterTable('qos_assignments', (table) => {
      table.foreign('group_id').references('id').inTable('qos_groups').onDelete('CASCADE')
    })
  }
}
