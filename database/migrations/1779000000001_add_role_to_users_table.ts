import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'users'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('role').notNullable().defaultTo('operator')
    })

    // Upgrade path: any pre-existing user becomes an admin so an already-
    // bootstrapped instance doesn't lose access. Fresh signups created after
    // this migration inherit the column default ('operator').
    this.defer(async (db) => {
      await db.from(this.tableName).update({ role: 'admin' })
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('role')
    })
  }
}
