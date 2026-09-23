import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * How a device attaches to the network, as the operator states it:
 * `ethernet`, or NULL to let Perch work it out from the APs and the traffic
 * (`devicePresence` in `app/services/wifi_presence.ts`). Without the mark a
 * device no Perch AP lists reads "Wired / unknown": a cable, or Wi-Fi Perch
 * does not read.
 */
export default class extends BaseSchema {
  protected tableName = 'device_labels'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      // Plain string, union enforced in the app layer (`DEVICE_CONNECTIONS`),
      // house style like `device_type`.
      table.string('connection', 16).nullable().after('device_type')
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('connection')
    })
  }
}
