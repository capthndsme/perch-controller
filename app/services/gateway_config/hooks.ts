import type GatewayApply from '#models/gateway_apply'
import type { UciConfig } from '#services/gateway_config/types'
import logger from '@adonisjs/core/services/logger'

/**
 * Listeners feature code registers on the config plane
 * (docs/gateway/config-plane.md section 6.8), so the plane never imports
 * the features that plug into it:
 *
 * - `onApplySaved`: every save of a `gateway_applies` row (a state change,
 *   a deadline, an outcome). The QoS writers follow their applies with it
 *   (queued → applying → applied / rolled back) and retry a package that
 *   waited for another apply to finish.
 * - `onRouterRead`: every read of the router merged into the rows (the
 *   `sqm` import of `qos_wan_queues` rides on it).
 *
 * Listeners run inside the gateway's serial queue, awaited in registration
 * order; a failing listener is logged and never breaks the plane. They must
 * not wait on work that needs the same gateway's queue from outside it
 * (schedule it instead).
 */

export type ApplySavedListener = (apply: GatewayApply) => void | Promise<void>

export interface RouterRead {
  gatewayId: number
  configs: UciConfig[]
  /** Ledger section name → perch id, per config. */
  perchIds: Record<string, Record<string, string>>
}

export type RouterReadListener = (read: RouterRead) => void | Promise<void>

const applyListeners = new Set<ApplySavedListener>()
const readListeners = new Set<RouterReadListener>()

/** Registers a listener; returns its removal. */
export function onApplySaved(listener: ApplySavedListener): () => void {
  applyListeners.add(listener)
  return () => applyListeners.delete(listener)
}

/** Registers a listener; returns its removal. */
export function onRouterRead(listener: RouterReadListener): () => void {
  readListeners.add(listener)
  return () => readListeners.delete(listener)
}

/** Called by `GatewayApply`'s after-save hook. */
export async function emitApplySaved(apply: GatewayApply): Promise<void> {
  for (const listener of [...applyListeners]) {
    try {
      await listener(apply)
    } catch (error) {
      logger.warn(
        { gatewayId: apply.gatewayId, applyId: apply.applyKey, err: error },
        'gateway_config: an apply listener failed'
      )
    }
  }
}

/** Called by `mergeRead` after a read is stored. */
export async function emitRouterRead(read: RouterRead): Promise<void> {
  for (const listener of [...readListeners]) {
    try {
      await listener(read)
    } catch (error) {
      logger.warn(
        { gatewayId: read.gatewayId, err: error },
        'gateway_config: a read listener failed'
      )
    }
  }
}
