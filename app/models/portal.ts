import { PortalSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'
import type { ClickThroughSettings, DeskSettings, PaymentSettings } from '#services/portal/hotspot'

/**
 * The sign-in methods a portal offers. `payment` = checkout at a coin
 * terminal (Paid Hotspot, section 14); `clickThrough` = free access after
 * accepting the terms (decision 32); `desk` = codes sold by hand in Sell Mode
 * (section 15). Rows written before those existed lack the keys: read them
 * with `portalMethods()`.
 */
export type PortalMethods = {
  voucher: boolean
  password: boolean
  payment?: boolean
  clickThrough?: boolean
  desk?: boolean
}

/** A portal's methods with every key present. */
export function portalMethods(value: Partial<PortalMethods> | null | undefined) {
  return {
    voucher: Boolean(value?.voucher),
    password: Boolean(value?.password),
    payment: Boolean(value?.payment),
    clickThrough: Boolean(value?.clickThrough),
    desk: Boolean(value?.desk),
  }
}

/**
 * Whether the portal takes codes on its voucher form: printed vouchers, a
 * payment's reference code (section 14.6) and desk-sold codes (section 15)
 * are all voucher codes.
 */
export function takesVoucherCodes(value: Partial<PortalMethods> | null | undefined): boolean {
  const m = portalMethods(value)
  return m.voucher || m.payment || m.desk
}

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

  /** The payment method's settings (read with `normalizePaymentSettings`). */
  @jsonColumn('payment')
  declare payment: Partial<PaymentSettings> | null

  /** The click-through method's limits (read with `normalizeClickThroughSettings`). */
  @jsonColumn('click_through')
  declare clickThrough: Partial<ClickThroughSettings> | null

  /** The desk method's settings (read with `normalizeDeskSettings`). */
  @jsonColumn('desk')
  declare desk: Partial<DeskSettings> | null
}
