import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * When an admin last reset a device assignment's quota
 * (`POST /qos/assignments/:id/quota/reset`). It rides in the device entry
 * (`quota.resetAt`): the agent keeps the larger of its own count and the
 * controller's `usedBytes`, except after a newer reset, when it starts over
 * from `usedBytes` (docs/gateway/qos.md section 6.2).
 */
export default class extends BaseSchema {
  protected tableName = 'qos_assignments'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.datetime('quota_reset_at').nullable().after('exhausted_at')
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('quota_reset_at')
    })
  }
}
