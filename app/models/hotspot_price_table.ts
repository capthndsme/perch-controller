import { HotspotPriceTableSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'
import type { PriceEntry } from '#services/portal/hotspot'
import type { DurationMode } from '#services/portal/types'

/**
 * An operator's rates for coin terminals (docs/gateway/portal.md section
 * 14.2). Every change bumps `revision`; each revision is kept in
 * `hotspot_price_revisions` (a checkout is priced at the revision it started
 * under).
 */
export default class HotspotPriceTable extends HotspotPriceTableSchema {
  declare durationMode: DurationMode

  @jsonColumn('entries')
  declare entries: PriceEntry[]
}
