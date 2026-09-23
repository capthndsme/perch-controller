import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * `gateway_applies.post_actions` (JSON): work that runs once the job is live
 * on the router (docs/gateway/firewall.md section 5): the per-device WAN
 * block's conntrack flush (`net.conntrack_flush`, README decision 9) waits
 * for the fresh session after the commit, so it runs after fw4 loaded the
 * block rule. Carried to the next job of a chain until it ran.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('gateway_applies', (table) => {
      table.text('post_actions').nullable()
    })
  }

  async down() {
    this.schema.alterTable('gateway_applies', (table) => {
      table.dropColumn('post_actions')
    })
  }
}
