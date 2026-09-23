import { PortalSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'

export const PORTAL_ENFORCEMENTS = ['opennds', 'perch_nft'] as const
export type PortalEnforcement = (typeof PORTAL_ENFORCEMENTS)[number]

export type PortalMethods = { voucher: boolean; password: boolean }

/** Last `portal.configure` result (docs/gateway/portal.md section 6). */
export type PortalStatus = {
  revision: number
  templateSha256: string | null
  openNds: { state: 'running' | 'stopped' | 'missing'; version: string | null }
  fas: 'ok' | 'misconfigured'
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
