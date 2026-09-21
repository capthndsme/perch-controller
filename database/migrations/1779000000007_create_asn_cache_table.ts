import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Best-effort cache for WAN peer IP enrichment. We key by IP address for the
 * first implementation because peer rows already store individual addresses;
 * prefix-level normalization can be added later if lookup volume becomes a
 * problem.
 */
export default class extends BaseSchema {
  protected tableName = 'asn_cache'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.bigIncrements('id').notNullable()
      table.string('ip_address', 45).notNullable()
      table.integer('asn').unsigned().nullable()
      table.string('org', 255).nullable()
      table.string('prefix', 64).nullable()
      table.text('error').nullable()
      table.timestamp('checked_at').notNullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.unique(['ip_address'], 'asn_cache_ip_unique_idx')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
