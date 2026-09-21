import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Unnamed destinations by peer address. The collector now keys unnamed
 * TLS / HTTP / QUIC flows (hello never captured) by the address they went
 * to, so the read side can attribute them by ASN ("Google LLC · 20 GB")
 * instead of one "https (unnamed)" pool. Named rows and the per-protocol
 * pool keep `peer_ip = ''`; the primary key grows by the column so an
 * address row and the pool row of the same protocol coexist.
 */
export default class extends BaseSchema {
  protected tableName = 'device_destination_buckets_hourly'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('peer_ip', 45).notNullable().defaultTo('').after('server_name')
    })
    this.schema.raw(
      `ALTER TABLE ${this.tableName}
         DROP PRIMARY KEY,
         ADD PRIMARY KEY (collector_id, mac, server_name, peer_ip, protocol, hour_start)`
    )
  }

  async down() {
    this.schema.raw(
      `ALTER TABLE ${this.tableName}
         DROP PRIMARY KEY,
         ADD PRIMARY KEY (collector_id, mac, server_name, protocol, hour_start)`
    )
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('peer_ip')
    })
  }
}
