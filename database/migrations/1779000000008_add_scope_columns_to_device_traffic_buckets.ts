import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Adds per-scope (WAN/LAN) splits to the existing total counters in
 * `device_traffic_buckets`. The poller starts populating them as soon as
 * go-collector emits the new fields; pre-existing rows keep `0` for every
 * scope counter, which is harmless because totals are still authoritative
 * (the `_wan` + `_lan` invariant only holds for rows written after the
 * collector upgrade).
 *
 * Read paths that filter by scope therefore underreport history for any
 * row written before the upgrade. That's expected — the alternative would
 * be to retroactively split rows we no longer have packet-level data for.
 */
export default class extends BaseSchema {
  protected tableName = 'device_traffic_buckets'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.bigInteger('bytes_in_wan').unsigned().notNullable().defaultTo(0)
      table.bigInteger('bytes_out_wan').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_in_wan').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_out_wan').unsigned().notNullable().defaultTo(0)

      table.bigInteger('bytes_in_lan').unsigned().notNullable().defaultTo(0)
      table.bigInteger('bytes_out_lan').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_in_lan').unsigned().notNullable().defaultTo(0)
      table.bigInteger('packets_out_lan').unsigned().notNullable().defaultTo(0)
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('bytes_in_wan')
      table.dropColumn('bytes_out_wan')
      table.dropColumn('packets_in_wan')
      table.dropColumn('packets_out_wan')
      table.dropColumn('bytes_in_lan')
      table.dropColumn('bytes_out_lan')
      table.dropColumn('packets_in_lan')
      table.dropColumn('packets_out_lan')
    })
  }
}
