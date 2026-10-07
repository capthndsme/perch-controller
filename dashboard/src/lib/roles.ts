import type { User, UserRole } from '@/types/api'

/**
 * Account roles as the dashboard names them. `wifi_vendor` only sells Wi-Fi
 * codes in Sell Mode (docs/gateway/portal.md §15.2): every other route sends
 * it to `/sell`.
 */
export const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Admin',
  operator: 'Operator',
  viewer: 'Viewer',
  wifi_vendor: 'Wi-Fi vendor',
}

export function roleLabel(role: string | null | undefined): string {
  if (!role) return ''
  return ROLE_LABELS[role as UserRole] ?? role
}

/** A Wi-Fi vendor: Sell Mode and nothing else. */
export function isVendor(user: Pick<User, 'role'> | null | undefined): boolean {
  return user?.role === 'wifi_vendor'
}

/** Who may open Sell Mode: admins and Wi-Fi vendors. */
export function canSell(user: Pick<User, 'role'> | null | undefined): boolean {
  return user?.role === 'admin' || user?.role === 'wifi_vendor'
}
