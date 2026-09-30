import type { RolloutOrder } from '#services/wifi_config/types'

/**
 * The order of a rollout's APs (docs/design/wifi controller.md section 6.2,
 * decision D8). Pure.
 *
 * `canary` (default):
 * 1. online before offline;
 * 2. APs whose jobs are all unprotected before any with a protected job
 *    (a change on the AP's own uplink);
 * 3. fewer connected clients first (the smallest blast radius);
 * 4. the AP serving the requesting admin's own device last (they keep a
 *    working link longest);
 * 5. AP id.
 *
 * `name` sorts by the AP's name (then id). An explicit `order` wins: the APs
 * it names in its order, the rest after it in canary order.
 */
export type OrderCandidate = {
  apId: number
  name: string
  online: boolean
  /** Any planned job of the AP is on its management path. */
  protected: boolean
  /** Connected clients now (`stationConnectedSql`). */
  clients: number
  /** The requesting admin's device is connected to this AP. */
  adminDeviceHere: boolean
}

function canary(a: OrderCandidate, b: OrderCandidate): number {
  if (a.online !== b.online) return a.online ? -1 : 1
  if (a.protected !== b.protected) return a.protected ? 1 : -1
  if (a.adminDeviceHere !== b.adminDeviceHere) return a.adminDeviceHere ? 1 : -1
  if (a.clients !== b.clients) return a.clients - b.clients
  return a.apId - b.apId
}

function byName(a: OrderCandidate, b: OrderCandidate): number {
  const n = a.name.localeCompare(b.name)
  return n !== 0 ? n : a.apId - b.apId
}

/** The APs' ids in rollout order. */
export function rolloutOrder(
  candidates: OrderCandidate[],
  policy: RolloutOrder,
  explicit?: number[] | null
): number[] {
  const sorted = [...candidates].sort(policy === 'name' ? byName : canary)
  if (!explicit || explicit.length === 0) return sorted.map((c) => c.apId)
  const known = new Set(candidates.map((c) => c.apId))
  const first = [...new Set(explicit)].filter((id) => known.has(id))
  return [...first, ...sorted.map((c) => c.apId).filter((id) => !first.includes(id))]
}
