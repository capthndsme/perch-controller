import { useQuery } from '@tanstack/react-query'
import { useProfile } from '@/hooks/use-auth'
import { apiFetch } from '@/lib/api'
import type { SellMenu } from '@/types/sell'

/**
 * The part of Sell Mode the shell needs (the "Enter Sell Mode" buttons in the
 * sidebar and the More sheet): kept apart from use-sell.ts, which pulls the
 * portal hooks, so the entry chunk stays small.
 */
export const sellQueryKey = ['sell'] as const
export const sellMenuQueryKey = [...sellQueryKey, 'menu'] as const
export const SELL_MENU_PATH = '/api/v1/sell'

export function fetchSellMenu(): Promise<SellMenu> {
  return apiFetch<SellMenu>(SELL_MENU_PATH)
}

/**
 * Whether to offer "Enter Sell Mode": admins, once some portal sells at the
 * desk (portal.md §15). One small request, kept for 10 minutes.
 */
export function useCanEnterSellMode(): boolean {
  const profile = useProfile()
  const isAdmin = profile.data?.role === 'admin'
  const menu = useQuery({
    queryKey: sellMenuQueryKey,
    queryFn: fetchSellMenu,
    enabled: isAdmin,
    staleTime: 10 * 60_000,
    retry: false,
  })
  return isAdmin && (menu.data?.portals.length ?? 0) > 0
}
