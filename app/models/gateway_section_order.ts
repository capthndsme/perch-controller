import { GatewaySectionOrderSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'

/**
 * The persisted order of one ordered section type of a gateway
 * (docs/gateway/firewall.md section 3): B and C as perch ids; R is the
 * rows' `position`. `sectionType` is the UCI type (`rule`, `redirect`).
 */
export default class GatewaySectionOrder extends GatewaySectionOrderSchema {
  @jsonColumn('base_order')
  declare baseOrder: string[]

  @jsonColumn('desired_order')
  declare desiredOrder: string[]

  /** Both sides reordered differently (two-way): the router's order when detected. */
  @jsonColumn('conflict')
  declare conflict: { router: string[]; detectedAt: string } | null
}
