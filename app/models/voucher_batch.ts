import { VoucherBatchSchema } from '#database/schema'
import type { DurationMode, StartMode } from '#services/portal/types'

/**
 * A batch of vouchers sharing one set of limits (docs/gateway/portal.md
 * section 4.1). `portalId` null = any portal until first redeemed.
 */
export default class VoucherBatch extends VoucherBatchSchema {
  declare durationMode: DurationMode
  declare startMode: StartMode
  /** `batch` = printed vouchers; `payment` = minted from a paid checkout (section 14). */
  declare kind: 'batch' | 'payment'
}
