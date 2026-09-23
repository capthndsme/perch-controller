import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The per-gateway serial queue (docs/gateway/config-plane.md section 6):
 * every read, merge, apply step, admin write and enforcement decision for
 * one gateway runs one at a time, in order, in-process (the API is a single
 * instance, like the scheduler). Different gateways run in parallel.
 *
 * - Bounded: at most `maxPending` tasks wait per gateway (beyond that the
 *   caller gets `QueueFullError`, the REST layer answers 503), and at most
 *   `maxGateways` gateways hold a queue at once. An entry is dropped as soon
 *   as its last task finishes, so idle gateways cost nothing (CLAUDE.md:
 *   every in-process structure needs a bound).
 * - Re-entrant: a task that calls `run` for the gateway it already holds runs
 *   the inner function directly (AsyncLocalStorage), so services can compose
 *   without deadlocking.
 * - A task's failure rejects only its own promise; the queue moves on.
 */

export class QueueFullError extends Error {
  constructor(readonly gatewayId: number) {
    super(`gateway ${gatewayId}: too much work queued`)
    this.name = 'QueueFullError'
  }
}

type Entry = { tail: Promise<unknown>; pending: number }

export class GatewaySerialQueue {
  readonly #entries = new Map<number, Entry>()
  readonly #held = new AsyncLocalStorage<Set<number>>()

  constructor(
    readonly maxPending = 64,
    readonly maxGateways = 1024
  ) {}

  /** Runs `task` after every earlier task of the gateway has settled. */
  run<T>(gatewayId: number, task: () => Promise<T>): Promise<T> {
    const held = this.#held.getStore()
    if (held?.has(gatewayId)) return task()

    let entry = this.#entries.get(gatewayId)
    if (!entry) {
      if (this.#entries.size >= this.maxGateways) {
        return Promise.reject(new QueueFullError(gatewayId))
      }
      entry = { tail: Promise.resolve(), pending: 0 }
      this.#entries.set(gatewayId, entry)
    }
    if (entry.pending >= this.maxPending) return Promise.reject(new QueueFullError(gatewayId))

    const current = entry
    current.pending++
    const nextHeld = new Set(held ?? [])
    nextHeld.add(gatewayId)
    const result = current.tail.then(() => this.#held.run(nextHeld, task))
    current.tail = result.then(
      () => this.#settle(gatewayId, current),
      () => this.#settle(gatewayId, current)
    )
    return result
  }

  /** Whether the current async context holds the gateway's queue. */
  holds(gatewayId: number): boolean {
    return this.#held.getStore()?.has(gatewayId) ?? false
  }

  /** Gateways with queued or running work (tests, diagnostics). */
  size(): number {
    return this.#entries.size
  }

  pending(gatewayId: number): number {
    return this.#entries.get(gatewayId)?.pending ?? 0
  }

  /** Resolves once the gateway's queue is empty (tests). */
  async drain(gatewayId: number): Promise<void> {
    for (let i = 0; i < 1000; i++) {
      const entry = this.#entries.get(gatewayId)
      if (!entry) return
      await entry.tail
    }
  }

  /** Resolves once every queue is empty (tests). */
  async drainAll(): Promise<void> {
    for (let i = 0; i < 100 && this.#entries.size > 0; i++) {
      await Promise.all([...this.#entries.keys()].map((id) => this.drain(id)))
    }
  }

  #settle(gatewayId: number, entry: Entry) {
    entry.pending--
    if (entry.pending === 0 && this.#entries.get(gatewayId) === entry) {
      this.#entries.delete(gatewayId)
    }
  }
}

/** The process-wide queue. */
export const gatewayQueue = new GatewaySerialQueue()
