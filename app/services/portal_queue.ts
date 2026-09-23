/**
 * The gateway's portal queue (docs/gateway/portal.md sections 7 and 11.2):
 * one reconcile, redemption, admin change or API authorization at a time per
 * gateway. `portal_store.ts` computes grant state from what it loaded, so two
 * writers for the same gateway must never interleave; different gateways run
 * in parallel.
 *
 * In-process, like the scheduler and the agent hubs: the controller is a
 * single instance. An entry exists only while the gateway has work queued, so
 * the map is bounded by the number of gateways with work in flight.
 */

const tails = new Map<number, Promise<unknown>>()

/**
 * Runs `task` after every task queued before it for the same gateway. A
 * failing task rejects its own promise only; the queue moves on.
 */
export function runInPortalQueue<T>(gatewayId: number, task: () => Promise<T>): Promise<T> {
  const previous = tails.get(gatewayId) ?? Promise.resolve()
  const run = previous.then(task, task)
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  tails.set(gatewayId, tail)
  void tail.then(() => {
    if (tails.get(gatewayId) === tail) tails.delete(gatewayId)
  })
  return run
}

/** Test-only: gateways with work in flight. */
export function _portalQueueSize(): number {
  return tails.size
}
