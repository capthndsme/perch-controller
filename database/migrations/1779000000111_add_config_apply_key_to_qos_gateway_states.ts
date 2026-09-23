import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The config plane apply that carries the gateway's current `perch-qos`
 * package (docs/gateway/qos.md section 6.3): its `gateway_applies.apply_key`.
 * The package's apply state (queued → applying → applied / rolled back)
 * follows that apply, and survives a restart of the controller.
 */
export default class extends BaseSchema {
  protected tableName = 'qos_gateway_states'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('config_apply_key', 40).nullable().after('config_submitted_at')
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('config_apply_key')
    })
  }
}
