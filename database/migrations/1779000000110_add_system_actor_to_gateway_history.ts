import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Plane writes made by Perch itself (docs/gateway/config-plane.md section
 * 6.8): the QoS sender's `perch-qos` packages (a portal grant, an expiry
 * sweep), Authoritative Mode's reverts. They have no user; `system_actor`
 * names what made them (`qos`, `portal`, `enforcement`, …) so revisions,
 * events and applies show "Perch (system)" instead of nobody. NULL = a user
 * (`*_user_id`) or the router.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('gateway_config_events', (table) => {
      table.string('system_actor', 16).nullable().after('user_id')
    })
    this.schema.alterTable('gateway_revisions', (table) => {
      table.string('system_actor', 16).nullable().after('author_user_id')
    })
    this.schema.alterTable('gateway_applies', (table) => {
      table.string('system_actor', 16).nullable().after('requested_by_user_id')
    })
  }

  async down() {
    for (const name of ['gateway_config_events', 'gateway_revisions', 'gateway_applies']) {
      this.schema.alterTable(name, (table) => {
        table.dropColumn('system_actor')
      })
    }
  }
}
