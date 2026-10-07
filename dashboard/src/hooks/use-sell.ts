import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useProfile } from '@/hooks/use-auth'
import { json, portalQueryKey, qs } from '@/hooks/use-portal'
import { fetchSellMenu, sellMenuQueryKey, sellQueryKey } from '@/hooks/use-sell-mode'
import { apiFetch } from '@/lib/api'
import { isVendor } from '@/lib/roles'
import type { PortalDelivery } from '@/types/api'
import type { CreateSalePayload, CreateSaleResult, Sale, SaleFilters, SalesPage } from '@/types/sell'

/**
 * Sell Mode REST (docs/gateway/portal.md §15.3), for admins and Wi-Fi
 * vendors. A sale or a void also refreshes the portal keys: the Payments
 * ledger lists desk sales too.
 */
const BASE = '/api/v1/sell'

export { sellMenuQueryKey, sellQueryKey }

/** The menu: portals that sell at the desk, their prices and their gateway's state. */
export function useSellMenu() {
  return useQuery({
    queryKey: sellMenuQueryKey,
    queryFn: fetchSellMenu,
    // Fresh whenever Sell Mode opens (the shell's copy may be minutes old), then once a minute.
    staleTime: 0,
    refetchInterval: 60_000,
  })
}

export function useSales(filters: SaleFilters, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...sellQueryKey, 'sales', filters] as const,
    queryFn: () => apiFetch<SalesPage>(`${BASE}/sales${qs(filters)}`),
    enabled: options.enabled,
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  })
}

function useSellMutation<TVars, TResult>(fn: (vars: TVars) => Promise<TResult>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...sellQueryKey, 'sales'] })
      void queryClient.invalidateQueries({ queryKey: portalQueryKey })
    },
  })
}

export function useCreateSale() {
  return useSellMutation((payload: CreateSalePayload) =>
    apiFetch<CreateSaleResult>(`${BASE}/sales`, json('POST', payload)),
  )
}

export function useVoidSale() {
  return useSellMutation(({ id, ...body }: { id: number; refundAmount?: number | null; note?: string | null }) =>
    apiFetch<{ sale: Sale; delivery: PortalDelivery }>(`${BASE}/sales/${id}/void`, json('POST', body)),
  )
}

/** The code of a sale again (`no-store`): a reveal on request, never cached. */
export function useRevealSaleCode() {
  return useMutation({
    mutationFn: (id: number) => apiFetch<{ code: string }>(`${BASE}/sales/${id}/code`),
  })
}

/** The signed-in account is a Wi-Fi vendor (Sell Mode only). */
export function useIsVendor(): boolean {
  return isVendor(useProfile().data)
}
