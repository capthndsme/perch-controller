/**
 * Rate limits of the portal authorize API (docs/gateway/portal.md section
 * 11.6), in-process like `ap_agent_rate_limit.ts` (the controller is a single
 * instance), bounded, insertion order doubling as the LRU list.
 *
 * - **Per principal** (API client `c:<id>`, admin token `u:<id>`): every
 *   request counts, `apiRequestsPerClientPerMinute` (setting) per fixed
 *   one-minute window.
 * - **Per address, failed authentication only**: 20 bad tokens within
 *   15 minutes and the address gets 429 until its window ends. A token has
 *   192 random bits, so this is about load (every bad token costs a lookup),
 *   not about guessing.
 */

export const PORTAL_API_FAILURE_LIMIT = 20
export const PORTAL_API_FAILURE_WINDOW_MS = 15 * 60_000
const REQUEST_WINDOW_MS = 60_000
const MAX_TRACKED_PRINCIPALS = 4096
const MAX_TRACKED_ADDRESSES = 1024

type Window = { count: number; startedAt: number }

const requests = new Map<string, Window>()
const failures = new Map<string, Window>()

export type Budget = { allowed: true } | { allowed: false; retryAfterSeconds: number }

/** Test-only: forget every window. */
export function _resetPortalApiRateLimits(): void {
  requests.clear()
  failures.clear()
}

function live(map: Map<string, Window>, key: string, span: number, now: number): Window | null {
  const window = map.get(key)
  if (!window) return null
  if (now - window.startedAt >= span) {
    map.delete(key)
    return null
  }
  return window
}

function bump(map: Map<string, Window>, key: string, span: number, cap: number, now: number) {
  const window = live(map, key, span, now)
  if (window) {
    window.count += 1
    map.delete(key)
    map.set(key, window)
    return window
  }
  const fresh = { count: 1, startedAt: now }
  map.set(key, fresh)
  while (map.size > cap) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
  return fresh
}

function retryAfter(window: Window, span: number, now: number): number {
  return Math.max(1, Math.ceil((window.startedAt + span - now) / 1000))
}

/** Counts one request of `principal`; refuses it past `limitPerMinute`. */
export function consumePortalApiRequest(
  principal: string,
  limitPerMinute: number,
  now: number = Date.now()
): Budget {
  const window = bump(requests, principal, REQUEST_WINDOW_MS, MAX_TRACKED_PRINCIPALS, now)
  if (window.count <= limitPerMinute) return { allowed: true }
  return { allowed: false, retryAfterSeconds: retryAfter(window, REQUEST_WINDOW_MS, now) }
}

/** May this address try a token (again)? Does not charge anything. */
export function portalApiAuthBudget(address: string, now: number = Date.now()): Budget {
  const window = live(failures, address, PORTAL_API_FAILURE_WINDOW_MS, now)
  if (!window || window.count < PORTAL_API_FAILURE_LIMIT) return { allowed: true }
  return {
    allowed: false,
    retryAfterSeconds: retryAfter(window, PORTAL_API_FAILURE_WINDOW_MS, now),
  }
}

/** Charges one failed authentication against the address. */
export function recordPortalApiAuthFailure(address: string, now: number = Date.now()): void {
  bump(failures, address, PORTAL_API_FAILURE_WINDOW_MS, MAX_TRACKED_ADDRESSES, now)
}
