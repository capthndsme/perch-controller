import { useState } from 'react'

/**
 * Colour slots and stacking order that follow the series, not its rank.
 *
 * A chart that colours its series by position (`slot = index`) repaints
 * every series when two of them swap ranks between refreshes, and a stacked
 * chart that stacks in rank order moves whole bands up and down. Top talkers
 * did both; a hashed colour (the protocol chart) is stable but lets two of
 * eight series share a slot about four times in five.
 *
 * `assignSeriesSlots` gives each key a distinct slot: a pinned key its own
 * slot (HTTPS is always blue), then every key the slot it had before, then
 * the lowest free slot in rank order. Only with more keys than slots do two
 * share one. `useStableSeriesSlots` / `useStableSeriesOrder` remember the
 * last answer across renders, so a refresh or a zoom keeps what it can.
 */

export const SERIES_SLOT_COUNT = 8

/** How many departed keys keep a claim on their old slot / position. */
const MEMORY_LIMIT = 64

function hashSlot(key: string, slotCount: number): number {
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  return hash % slotCount
}

/** Pure: key → slot index (0-based), distinct while there are enough slots. */
export function assignSeriesSlots(
  keys: readonly string[],
  opts: {
    previous?: ReadonlyMap<string, number>
    /** A key's own slot (pinned protocols and categories). */
    preferred?: (key: string) => number | undefined
    slotCount?: number
  } = {},
): Map<string, number> {
  const slotCount = opts.slotCount ?? SERIES_SLOT_COUNT
  const out = new Map<string, number>()
  const taken = new Set<number>()
  const claim = (key: string, slot: number | undefined) => {
    if (slot === undefined || slot < 0 || slot >= slotCount || taken.has(slot) || out.has(key)) {
      return
    }
    out.set(key, slot)
    taken.add(slot)
  }
  for (const key of keys) claim(key, opts.preferred?.(key))
  for (const key of keys) claim(key, opts.previous?.get(key))
  for (const key of keys) {
    if (out.has(key)) continue
    let free = 0
    while (free < slotCount && taken.has(free)) free += 1
    if (free < slotCount) claim(key, free)
    else out.set(key, hashSlot(key, slotCount))
  }
  return out
}

/**
 * Pure: the keys in a stable order. Keys seen before keep their relative
 * order; new ones follow in the order given (rank).
 */
export function stableSeriesOrder(keys: readonly string[], previous: readonly string[]): string[] {
  const present = new Set(keys)
  const kept = previous.filter((key) => present.has(key))
  const known = new Set(kept)
  return [...kept, ...keys.filter((key) => !known.has(key))]
}

/** A bounded, most-recent-last copy of `memory` with `entries` added. */
function remembered<T>(memory: ReadonlyMap<string, T>, entries: Iterable<[string, T]>): Map<string, T> {
  const next = new Map(memory)
  for (const [key, value] of entries) {
    next.delete(key)
    next.set(key, value)
  }
  while (next.size > MEMORY_LIMIT) {
    const oldest = next.keys().next()
    if (oldest.done) break
    next.delete(oldest.value)
  }
  return next
}

/**
 * `assignSeriesSlots` with memory across renders (React's "information from
 * previous renders" pattern: state updated while rendering when the keys
 * change). `scope` names the key space; a new scope starts afresh.
 */
export function useStableSeriesSlots(
  keys: readonly string[],
  preferred?: (key: string) => number | undefined,
  scope = '',
): Map<string, number> {
  const signature = `${scope}\u0001${keys.join('\u0000')}`
  const [state, setState] = useState(() => {
    const slots = assignSeriesSlots(keys, { preferred })
    return { signature, scope, slots, memory: remembered(new Map<string, number>(), slots) }
  })
  if (state.signature === signature) return state.slots
  const previous = state.scope === scope ? state.memory : new Map<string, number>()
  const slots = assignSeriesSlots(keys, { previous, preferred })
  setState({ signature, scope, slots, memory: remembered(previous, slots) })
  return slots
}

/** `stableSeriesOrder` with memory across renders (see `useStableSeriesSlots`). */
export function useStableSeriesOrder(keys: readonly string[], scope = ''): string[] {
  const signature = `${scope}\u0001${keys.join('\u0000')}`
  const [state, setState] = useState(() => ({
    signature,
    scope,
    order: [...keys],
    memory: [...keys],
  }))
  if (state.signature === signature) return state.order
  const previous = state.scope === scope ? state.memory : []
  const order = stableSeriesOrder(keys, previous)
  // Departed keys stay at the end of the memory (bounded), so one that
  // comes back finds its place again.
  const present = new Set(order)
  const memory = [...order, ...previous.filter((key) => !present.has(key))].slice(0, MEMORY_LIMIT)
  setState({ signature, scope, order, memory })
  return order
}
