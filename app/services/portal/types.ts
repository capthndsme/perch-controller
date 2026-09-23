/**
 * Guest portal domain types (docs/gateway/portal.md). Pure: no app imports,
 * so the unit suite and the other portal modules share them without booting
 * anything.
 *
 * Times in this layer are Unix epoch **milliseconds** (numbers). The model and
 * persistence layers convert from and to DateTime; nothing here ever parses a
 * DATETIME string (mysql2 reads those in the process zone, which is UTC+8 on
 * the owner's host).
 */

export const DURATION_MODES = ['wall_clock', 'active_time'] as const
export type DurationMode = (typeof DURATION_MODES)[number]

export const START_MODES = ['first_use', 'creation'] as const
export type StartMode = (typeof START_MODES)[number]

/**
 * Who created a grant. There is no `external` source: an authorization made
 * outside Perch (`ndsctl auth` by hand) is never adopted as a grant, it is
 * undone and logged (owner decision 25).
 */
export const GRANT_SOURCES = ['voucher', 'user', 'api', 'admin'] as const
export type GrantSource = (typeof GRANT_SOURCES)[number]

/**
 * - `queued`: stacked behind another entitlement of the same device on the
 *   same portal (decision 23: time before data buckets); not on the router.
 * - `pending_device`: desired on the router, the device has not been seen yet.
 * - `active`: authorized on the router.
 * - `paused`: the router idle-deauthed it; it re-auths when the MAC returns.
 * - `ended`: final.
 */
export const GRANT_STATES = ['queued', 'pending_device', 'active', 'paused', 'ended'] as const
export type GrantState = (typeof GRANT_STATES)[number]

/** `pending` = the router has not acknowledged the grant's current revision. */
export const GRANT_DELIVERIES = ['applied', 'pending'] as const
export type GrantDelivery = (typeof GRANT_DELIVERIES)[number]

/**
 * - `expired` / `quota`: the group ran out of time / data.
 * - `revoked`: an admin or API client ended it (or its voucher / user).
 * - `logout`: the guest logged out on the portal page.
 * - `router_deauth`: deauthed on the router outside Perch (`ndsctl deauth`).
 *   Deauth is the safe direction: respected, never undone.
 * - `replaced`: evicted to make room (user device limit, API `mode: replace`).
 * - `moved`: its voucher was redeemed on another device, which took the slot
 *   (decision 23: a shared code kicks the first device off).
 * - `rejected`: the router refused it permanently (bad MAC, bad signature).
 */
export const GRANT_END_REASONS = [
  'expired',
  'quota',
  'revoked',
  'logout',
  'router_deauth',
  'replaced',
  'moved',
  'rejected',
] as const
export type GrantEndReason = (typeof GRANT_END_REASONS)[number]

/** States that hold (or wait for) a slot on the router. */
export const LIVE_GRANT_STATES: readonly GrantState[] = ['pending_device', 'active', 'paused']

export function isLiveState(state: GrantState): boolean {
  return state === 'pending_device' || state === 'active' || state === 'paused'
}

/**
 * The limits of a group (`v:<voucherId>`, `u:<portalUserId>`, `g:<grantId>`).
 * Every grant of a group shares them.
 *
 * - `expiresAt`: wall-clock deadline, null = none (yet: a `first_use`
 *   wall-clock voucher gets one when it starts).
 * - `durationSeconds`: the voucher's duration. For `wall_clock` it turns into
 *   `expiresAt` at start; for `active_time` it is the budget of charged time.
 */
export type GroupLimits = {
  durationMode: DurationMode
  expiresAt: number | null
  durationSeconds: number | null
  quotaBytes: number | null
  downKbps: number | null
  upKbps: number | null
  maxDevices: number
}

/** Usage of a whole group, all its grants (live and ended) summed. */
export type GroupUsage = {
  /** Charged active time (active_time mode); informational for wall_clock. */
  timeUsedSeconds: number
  /** Up + down. */
  bytesUsed: number
}

export type Remaining = { seconds: number | null; bytes: number | null }

export type Exhaustion = 'expired' | 'quota' | null

export const GROUP_KEY_REGEX = /^[vug]:[1-9][0-9]{0,15}$/

export type GroupKind = 'voucher' | 'user' | 'grant'

export function groupKey(kind: GroupKind, id: number): string {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error(`invalid group id ${id}`)
  return `${kind === 'voucher' ? 'v' : kind === 'user' ? 'u' : 'g'}:${id}`
}

export function parseGroupKey(key: string): { kind: GroupKind; id: number } | null {
  if (!GROUP_KEY_REGEX.test(key)) return null
  const id = Number(key.slice(2))
  if (!Number.isSafeInteger(id)) return null
  const kind: GroupKind = key[0] === 'v' ? 'voucher' : key[0] === 'u' ? 'user' : 'grant'
  return { kind, id }
}

const MAC_REGEX = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/

/**
 * `02-00-00-AA-BB-CC`, `0200.00aa.bbcc`, `020000aabbcc` → `02:00:00:aa:bb:cc`;
 * null for anything else, and for the all-zero, broadcast and multicast
 * addresses (never a guest's device).
 */
export function normalizeMac(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const hex = input
    .trim()
    .toLowerCase()
    .replace(/[:\-.]/g, '')
  if (!/^[0-9a-f]{12}$/.test(hex)) return null
  const mac = hex.match(/../g)!.join(':')
  if (!MAC_REGEX.test(mac)) return null
  if (mac === '00:00:00:00:00:00' || mac === 'ff:ff:ff:ff:ff:ff') return null
  if (Number.parseInt(hex.slice(0, 2), 16) & 1) return null
  return mac
}
