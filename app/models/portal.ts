import { PortalSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'

export type PortalMethods = { voucher: boolean; password: boolean }

/**
 * This portal's part of the last `portal.configure` result
 * (docs/gateway/portal.md section 13.3). Perch's own nftables enforcement
 * (decision 27): `state` active | disabled | waiting_device | error;
 * `unknown` before the router answered.
 */
export type PortalStatus = {
  revision: number
  templateSha256: string | null
  state: 'active' | 'disabled' | 'waiting_device' | 'error' | 'unknown'
  /** The device the portal is enforced on (e.g. `br-guest`). */
  device: string | null
  /** Per-MAC byte counting works on it. */
  counting: boolean
  issues: string[]
  listen: string | null
  at: string
}

/**
 * A guest portal on one network of one gateway (docs/gateway/portal.md
 * section 5). Several per gateway (decision 19), one live per network.
 * Soft-deleted: `deletedAt` set keeps history (grants, sessions, batches)
 * and frees the network for a new portal.
 */
export default class Portal extends PortalSchema {
  @jsonColumn('methods')
  declare methods: PortalMethods

  @jsonColumn('csp_connect_src')
  declare cspConnectSrc: string[] | null

  @jsonColumn('status')
  declare status: PortalStatus | null
}
