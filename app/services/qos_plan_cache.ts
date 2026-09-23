import QosAssignment from '#models/qos_assignment'
import QosPolicy from '#models/qos_policy'
import { planQos, type QosPlan } from '#services/qos_plan'
import { loadPlanInput } from '#services/qos_reads'

/**
 * A gateway's current plan plus the rows the read side joins it with
 * (`/devices` rows, `/devices/:mac/shaping`, `/qos/devices`, `/qos`), cached
 * briefly so a device list costs no planning per request. Bounded
 * (`PLAN_CACHE_MAX` gateways, CLAUDE.md's cache rule), `PLAN_CACHE_TTL_MS`
 * old at most (expiries fall out on their own), and dropped by every QoS
 * write and quota persist (`invalidateQosPlanCache`).
 */

export interface ShapingContext {
  plan: QosPlan
  policies: QosPolicy[]
  assignments: QosAssignment[]
}

const PLAN_CACHE_TTL_MS = 15_000
export const PLAN_CACHE_MAX = 64

const cache = new Map<number, { context: ShapingContext; at: number }>()

export async function cachedShapingContext(gatewayId: number): Promise<ShapingContext> {
  const hit = cache.get(gatewayId)
  if (hit && Date.now() - hit.at < PLAN_CACHE_TTL_MS) return hit.context
  const [input, policies, assignments] = await Promise.all([
    loadPlanInput(gatewayId),
    QosPolicy.query().where('gatewayId', gatewayId),
    QosAssignment.query().where('gatewayId', gatewayId),
  ])
  const context = { plan: planQos(input), policies, assignments }
  cache.delete(gatewayId)
  if (cache.size >= PLAN_CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(gatewayId, { context, at: Date.now() })
  return context
}

/** Drops one gateway's cached plan, or all of them. */
export function invalidateQosPlanCache(gatewayId?: number): void {
  if (gatewayId === undefined) cache.clear()
  else cache.delete(gatewayId)
}
