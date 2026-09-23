import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Paid Hotspot and click-through on portals (docs/gateway/portal.md
 * section 14):
 *
 * - `portals.payment`: the checkout method's settings (price table, idle
 *   timeout), JSON; `portals.click_through`: the click-through method's
 *   limits (minutes, speed, repeat window, terms), JSON. Whether a method is
 *   on stays in `portals.methods`.
 * - `voucher_batches.kind`: `batch` (printed vouchers) or `payment` (the
 *   one-voucher batch minted from a paid checkout: its reference code). The
 *   batch lists show `batch` only.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('portals', (table) => {
      table.text('payment').nullable()
      table.text('click_through').nullable()
    })
    this.schema.alterTable('voucher_batches', (table) => {
      table.string('kind', 12).notNullable().defaultTo('batch')
      table.index(['kind'], 'voucher_batches_kind_idx')
    })
  }

  async down() {
    this.schema.alterTable('voucher_batches', (table) => {
      table.dropIndex(['kind'], 'voucher_batches_kind_idx')
      table.dropColumn('kind')
    })
    this.schema.alterTable('portals', (table) => {
      table.dropColumn('payment')
      table.dropColumn('click_through')
    })
  }
}
