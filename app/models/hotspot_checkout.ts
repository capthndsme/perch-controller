import { HotspotCheckoutSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'
import type { PriceTable } from '#services/portal/hotspot'

export type HotspotCoin = { eventId: string; amount: number; at: number }

/**
 * One ledger row of the Paid Hotspot (docs/gateway/portal.md section 14.5):
 * a finalized checkout (`kind` payment) or money the router could not credit
 * (`kind` unclaimed). `channel` desk = a code sold by hand in Sell Mode
 * (section 15), no terminal, `sellerUserId` = who sold it.
 */
export default class HotspotCheckout extends HotspotCheckoutSchema {
  declare kind: 'payment' | 'unclaimed'
  declare state: 'paid' | 'voided' | 'unclaimed' | 'credited' | 'dismissed'
  declare channel: 'coin' | 'desk'

  @jsonColumn('price_snapshot')
  declare priceSnapshot: PriceTable | null

  @jsonColumn('coins')
  declare coins: HotspotCoin[] | null
}
