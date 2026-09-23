import { GatewayWanBlockSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'

/** The outcome of the conntrack flush that followed a block (`net.conntrack_flush`). */
export type WanBlockFlush = {
  at: string
  /** null: not attempted (no capability, agent offline, no known address). */
  flushed: boolean | null
  ips: string[]
  matched?: number
  deleted?: number
  skipped?: number
  reason?: string
  applyId?: string
}

/**
 * Perch-only metadata of a per-device WAN block (docs/gateway/firewall.md
 * section 5): who, when, why, and the last flush. The block itself is the
 * MAC in the `perch_block_wan` ipset.
 */
export default class GatewayWanBlock extends GatewayWanBlockSchema {
  @jsonColumn('last_flush')
  declare lastFlush: WanBlockFlush | null
}
