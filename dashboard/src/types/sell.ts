import type { PortalDelivery, PriceDurationMode, VoucherStatus } from '@/types/api'

/**
 * Sell Mode (docs/gateway/portal.md §15.3): front-desk staff sell Wi-Fi codes
 * for cash. `GET /api/v1/sell` is the menu, `/sell/sales` the desk's ledger.
 */

/** `GET /api/v1/sell`. */
export type SellMenu = {
  seller: { id: number; email: string; fullName: string | null; role: 'admin' | 'wifi_vendor' }
  /** The instance's time zone (e.g. Asia/Manila): "today" starts at its midnight. */
  timezone: string
  /** Live portals with desk sales on and a usable desk price table. */
  portals: SellPortal[]
}

export type SellPortal = {
  id: number
  name: string
  gatewayId: number
  /** The gateway's portal session is up: a code redeems at once. */
  gatewayOnline: boolean
  codeLength: number
  priceTable: {
    id: number
    name: string
    revision: number
    currency: string
    decimals: number
    durationMode: PriceDurationMode
  }
  /** Ascending amount. */
  items: SellItem[]
}

export type SellItem = {
  /** Minor units of the table (5 with decimals 0 = PHP 5). */
  amount: number
  amountText: string
  minutes: number
  quotaBytes: number | null
  downKbps: number | null
  upKbps: number | null
  /** "1 h · 5 Mbit/s down". */
  text: string
}

export type SaleState = 'paid' | 'voided'

export type Sale = {
  /** The ledger row (`hotspot_checkouts.id`). */
  id: number
  state: SaleState
  portal: { id: number; name: string } | null
  amount: number
  amountText: string
  currency: string
  decimals: number
  item: {
    minutes: number
    quotaBytes: number | null
    downKbps: number | null
    upKbps: number | null
    durationMode: string
    text: string
  }
  voucher: { id: number; hint: string; status: VoucherStatus } | null
  /** `GET /sell/sales/:id/code` would answer for this caller. */
  codeAvailable: boolean
  /** `POST /sell/sales/:id/void` would be allowed for this caller. */
  voidable: boolean
  seller: { id: number; email: string; fullName: string | null } | null
  note: string | null
  refundAmount: number | null
  createdAt: string
  voidedAt: string | null
  voidedBy: { id: number; email: string } | null
}

/** `POST /api/v1/sell/sales`. */
export type CreateSalePayload = {
  portalId: number
  amount: number
  priceRevision: number
  /** One per sale attempt, reused on a retry: a double tap or a lost answer never sells twice. */
  clientRef: string
  note?: string
}

export type CreateSaleResult = {
  sale: Sale
  /** As the guest types it, grouped (`XXXX-XXXX`). Shown in this answer only. */
  code: string
  delivery: PortalDelivery
}

export type SaleFilters = {
  /** ISO instants; the server defaults to today 00:00 (instance time zone) → now. */
  from?: string
  to?: string
  portalId?: number
  /** Admin only; a vendor always gets their own. */
  sellerId?: number
  state?: SaleState
  limit?: number
  offset?: number
}

/** `GET /api/v1/sell/sales`. */
export type SalesPage = {
  items: Sale[]
  total: number
  /** Paid sales only, per currency (minor units). */
  totals: Array<{ currency: string; amount: number; count: number }>
  range: { from: string; to: string }
  timezone: string
}
