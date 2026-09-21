/**
 * Brute-force budget for the two unauthenticated Perch AP Daemon entry points:
 * `POST /api/v1/ap-agent/join` and the WebSocket upgrade. Only FAILED
 * attempts count (bad token, bad credentials, invalid body); an address that
 * burns 20 of them within 15 minutes gets 429 until its window ends.
 *
 * In-process like the collector announce limiter: the server is single
 * process, so a Map is the whole implementation. Insertion order doubles as
 * the LRU list for the address cap.
 */

export const AP_AGENT_FAILURE_LIMIT = 20
export const AP_AGENT_FAILURE_WINDOW_MS = 15 * 60_000
/** Cap on tracked addresses so a LAN full of junk cannot grow it forever. */
const MAX_TRACKED_ADDRESSES = 1024

type FailureWindow = { count: number; startedAt: number }

const windows = new Map<string, FailureWindow>()

export type AgentAuthBudget = { allowed: true } | { allowed: false; retryAfterSeconds: number }

/** Test-only: forget every window. */
export function _resetApAgentRateLimits(): void {
  windows.clear()
}

function currentWindow(address: string, now: number): FailureWindow | null {
  const window = windows.get(address)
  if (!window) return null
  if (now - window.startedAt >= AP_AGENT_FAILURE_WINDOW_MS) {
    windows.delete(address)
    return null
  }
  return window
}

/** May this address try (again)? Does not charge anything. */
export function agentAuthBudget(address: string, now: number = Date.now()): AgentAuthBudget {
  const window = currentWindow(address, now)
  if (!window || window.count < AP_AGENT_FAILURE_LIMIT) return { allowed: true }
  const retryAfterMs = window.startedAt + AP_AGENT_FAILURE_WINDOW_MS - now
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) }
}

/** Charges one failed attempt against the address. */
export function recordAgentAuthFailure(address: string, now: number = Date.now()): void {
  const window = currentWindow(address, now)
  if (window) {
    window.count += 1
    // Refresh LRU position.
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
