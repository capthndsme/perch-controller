/**
 * Brute-force budget for `POST /api/v1/setup/login`, the wizard's sign-in for
 * the admin created in step 1. Only FAILED attempts count; an address that
 * burns 10 of them within 15 minutes gets 429 until its window ends.
 *
 * In-process like `ap_agent_rate_limit.ts` (the server is single process);
 * insertion order doubles as the LRU list for the address cap.
 */

export const SETUP_LOGIN_FAILURE_LIMIT = 10
export const SETUP_LOGIN_FAILURE_WINDOW_MS = 15 * 60_000
/** Cap on tracked addresses so a LAN full of junk cannot grow it forever. */
const MAX_TRACKED_ADDRESSES = 1024

type FailureWindow = { count: number; startedAt: number }

const windows = new Map<string, FailureWindow>()

export type SetupLoginBudget = { allowed: true } | { allowed: false; retryAfterSeconds: number }

/** Test-only: forget every window. */
export function _resetSetupLoginRateLimits(): void {
  windows.clear()
}

function currentWindow(address: string, now: number): FailureWindow | null {
  const window = windows.get(address)
  if (!window) return null
  if (now - window.startedAt >= SETUP_LOGIN_FAILURE_WINDOW_MS) {
    windows.delete(address)
    return null
  }
  return window
}

/** May this address try (again)? Does not charge anything. */
export function setupLoginBudget(address: string, now: number = Date.now()): SetupLoginBudget {
  const window = currentWindow(address, now)
  if (!window || window.count < SETUP_LOGIN_FAILURE_LIMIT) return { allowed: true }
  const retryAfterMs = window.startedAt + SETUP_LOGIN_FAILURE_WINDOW_MS - now
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) }
}

/** Charges one failed attempt against the address. */
export function recordSetupLoginFailure(address: string, now: number = Date.now()): void {
  const window = currentWindow(address, now)
  if (window) {
    window.count += 1
    windows.delete(address)
    windows.set(address, window)
    return
  }
  windows.set(address, { count: 1, startedAt: now })
  while (windows.size > MAX_TRACKED_ADDRESSES) {
    const oldest = windows.keys().next().value
    if (oldest === undefined) break
    windows.delete(oldest)
  }
}
