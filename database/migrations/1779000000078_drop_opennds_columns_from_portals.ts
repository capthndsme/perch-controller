import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Owner decision 27: every portal is enforced by Perch's own nftables table
 * on the router, never openNDS. `portals.enforcement` (always `perch_nft`
 * now) and `portals.instance` (the openNDS section) carry nothing any more.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('portals', (table) => {
      table.dropColumn('instance')
      table.dropColumn('enforcement')
    })
  }

  async down() {
    this.schema.alterTable('portals', (table) => {
      table.string('instance', 64).nullable()
      table.string('enforcement', 16).notNullable().defaultTo('perch_nft')
    })
  }
}
