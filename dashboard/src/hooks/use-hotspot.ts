import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ApiError, apiFetch } from '@/lib/api'
import { json, portalQueryKey, qs, usePortalMutation } from '@/hooks/use-portal'
import type {
  CheckoutFilters,
  CheckoutPage,
  HotspotCheckout,
  HotspotTerminal,
  HotspotTerminalPayload,
  HotspotTerminalWithToken,
  PortalDelivery,
  PriceQuote,
  PriceRevision,
  PriceTable,
  PriceTablePayload,
} from '@/types/api'

/**
 * Paid Hotspot REST (docs/gateway/portal.md §14.9): price tables, coin
 * terminals and the payment ledger. Reads for every signed-in user, writes
 * admin-only. Keys live under the portal key, so any portal write refreshes
 * them too (a payment method change moves what a table is used by).
 */
const BASE = '/api/v1/portal'
const notFound = (count: number, error: unknown) => !(error instanceof ApiError && error.status === 404) && count < 2

// ── Price tables ─────────────────────────────────────────────────────────

export function usePriceTables(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...portalQueryKey, 'price-tables'] as const,
    queryFn: () => apiFetch<PriceTable[]>(`${BASE}/price-tables`),
    enabled: options.enabled,
    staleTime: 30_000,
  })
}

export function usePriceTable(id: number | null) {
  return useQuery({
    queryKey: [...portalQueryKey, 'price-table', id] as const,
    queryFn: () => apiFetch<{ priceTable: PriceTable; revisions: PriceRevision[] }>(`${BASE}/price-tables/${id}`),
    enabled: id !== null,
    retry: notFound,
  })
}

/** What `amount` (minor units) buys under a saved table; the server's pricing is the reference. */
export function usePriceQuote(id: number | null, amount: number | null) {
  return useQuery({
    queryKey: [...portalQueryKey, 'price-quote', id, amount] as const,
    queryFn: () => apiFetch<PriceQuote>(`${BASE}/price-tables/${id}/quote`, json('POST', { amount })),
    enabled: id !== null && amount !== null && Number.isSafeInteger(amount) && amount >= 0,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  })
}

export function useCreatePriceTable() {
  return usePortalMutation((payload: PriceTablePayload) =>
    apiFetch<PriceTable>(`${BASE}/price-tables`, json('POST', payload)),
  )
}

export function useUpdatePriceTable() {
  return usePortalMutation(({ id, ...payload }: PriceTablePayload & { id: number }) =>
    apiFetch<{ priceTable: PriceTable; delivery: PortalDelivery }>(`${BASE}/price-tables/${id}`, json('PATCH', payload)),
  )
}

export function useDeletePriceTable() {
  return usePortalMutation((id: number) => apiFetch<void>(`${BASE}/price-tables/${id}`, { method: 'DELETE' }))
}

// ── Terminals ────────────────────────────────────────────────────────────

export function useHotspotTerminals(options: { portalId?: number; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...portalQueryKey, 'terminals', options.portalId ?? 'all'] as const,
    queryFn: () => apiFetch<HotspotTerminal[]>(`${BASE}/terminals${qs({ portalId: options.portalId })}`),
    enabled: options.enabled,
    // The router reports terminals every 30 s; busy/idle is what an operator watches.
    refetchInterval: 10_000,
  })
}

export function useCreateHotspotTerminal() {
  return usePortalMutation((payload: HotspotTerminalPayload & { portalId: number; name: string }) =>
    apiFetch<HotspotTerminalWithToken>(`${BASE}/terminals`, json('POST', payload)),
  )
}

export function useUpdateHotspotTerminal() {
  return usePortalMutation(({ id, ...payload }: HotspotTerminalPayload & { id: number }) =>
    apiFetch<{ terminal: HotspotTerminal; delivery: PortalDelivery }>(`${BASE}/terminals/${id}`, json('PATCH', payload)),
  )
}

export function useRotateHotspotTerminal() {
  return usePortalMutation((id: number) =>
    apiFetch<HotspotTerminalWithToken>(`${BASE}/terminals/${id}/rotate`, { method: 'POST' }),
  )
}

export function useDeleteHotspotTerminal() {
  return usePortalMutation((id: number) => apiFetch<void>(`${BASE}/terminals/${id}`, { method: 'DELETE' }))
}

// ── Ledger ───────────────────────────────────────────────────────────────

export function useHotspotCheckouts(filters: CheckoutFilters, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...portalQueryKey, 'checkouts', filters] as const,
    queryFn: () => apiFetch<CheckoutPage>(`${BASE}/checkouts${qs(filters)}`),
    enabled: options.enabled,
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  })
}

export function useHotspotCheckout(id: number | null) {
  return useQuery({
    queryKey: [...portalQueryKey, 'checkout', id] as const,
    queryFn: () => apiFetch<HotspotCheckout>(`${BASE}/checkouts/${id}`),
    enabled: id !== null,
    retry: notFound,
  })
}

export function useVoidCheckout() {
  return usePortalMutation(({ id, ...body }: { id: number; note?: string | null; refundAmount?: number | null }) =>
    apiFetch<{ checkout: HotspotCheckout; delivery: PortalDelivery }>(`${BASE}/checkouts/${id}/void`, json('POST', body)),
  )
}

export function useCreditCheckout() {
  return usePortalMutation(({ id, ...body }: { id: number; minutes?: number | null; note?: string | null }) =>
    apiFetch<{ checkout: HotspotCheckout; code: string; delivery: PortalDelivery }>(
      `${BASE}/checkouts/${id}/credit`,
      json('POST', body),
    ),
  )
}

export function useDismissCheckout() {
  return usePortalMutation(({ id, ...body }: { id: number; note?: string | null }) =>
    apiFetch<HotspotCheckout>(`${BASE}/checkouts/${id}/dismiss`, json('POST', body)),
  )
}
