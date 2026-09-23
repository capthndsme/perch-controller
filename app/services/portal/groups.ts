import type {
  DurationMode,
  Exhaustion,
  GrantState,
  GroupLimits,
  GroupUsage,
  Remaining,
  StartMode,
} from '#services/portal/types'

/**
 * Group math (docs/gateway/portal.md §4.3–4.5): limits, remaining time and
 * data, exhaustion, the `base*` usage the router adds its live counters to,
 * and the order entitlements of one device are consumed in. Pure; times are
 * epoch milliseconds.
 *
 * Usage is additive per grant: bytes are the grant's own counters, and
 * charged active time is attributed to exactly one grant per tick (the router
 * charges a tick once per group, to the lowest-id live grant of the group that
 * moved traffic in it). So a group's usage is always the sum over its grants,
 * and the part the router does not hold live is plain subtraction.
 */

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** What a voucher row (and its batch) contributes to its group's limits. */
export type VoucherLimitsInput = {
  durationSeconds: number | null
  durationMode: DurationMode
  startMode: StartMode
  quotaBytes: number | null
  downKbps: number | null
  upKbps: number | null
  maxDevices: number
  /** Set once the wall clock started (`creation`: at creation). */
  expiresAt: number | null
}

export function voucherGroupLimits(v: VoucherLimitsInput): GroupLimits {
  return {
    durationMode: v.durationMode,
    // Active-time vouchers have no wall-clock deadline of their own.
    expiresAt: v.durationMode === 'wall_clock' ? v.expiresAt : null,
    durationSeconds: v.durationSeconds,
    quotaBytes: v.quotaBytes,
    downKbps: v.downKbps,
    upKbps: v.upKbps,
    maxDevices: Math.max(1, v.maxDevices),
  }
}

/**
 * The wall clock of a voucher that starts `now`: `{startsAt, expiresAt}` for
 * a `wall_clock` voucher whose clock has not started, null otherwise
 * (already started, `active_time`, or no duration). A `creation` voucher's
 * clock is started when it is created (`creationClock`).
 */
export function startVoucherClock(
  v: Pick<VoucherLimitsInput, 'durationMode' | 'durationSeconds' | 'expiresAt'>,
  now: number
): { startsAt: number; expiresAt: number } | null {
  if (v.durationMode !== 'wall_clock' || v.durationSeconds === null || v.expiresAt !== null) {
    return null
  }
  return { startsAt: now, expiresAt: now + v.durationSeconds * 1000 }
}

/** `{startsAt, expiresAt}` a voucher gets at creation (start mode `creation`), else null. */
export function creationClock(
  v: Pick<VoucherLimitsInput, 'durationMode' | 'durationSeconds' | 'startMode'>,
  createdAt: number
): { startsAt: number; expiresAt: number } | null {
  if (v.startMode !== 'creation' || v.durationMode !== 'wall_clock') return null
  if (v.durationSeconds === null) return null
  return { startsAt: createdAt, expiresAt: createdAt + v.durationSeconds * 1000 }
}

/**
 * Effective limits of one grant: its group's, tightened by the grant's own
 * deadline (a portal-user login or an API grant can carry one).
 */
export function grantLimits(group: GroupLimits, grantExpiresAt: number | null): GroupLimits {
  if (grantExpiresAt === null) return group
  const expiresAt =
    group.expiresAt === null ? grantExpiresAt : Math.min(group.expiresAt, grantExpiresAt)
  return { ...group, expiresAt }
}

// ---------------------------------------------------------------------------
// Remaining and exhaustion
// ---------------------------------------------------------------------------

/**
 * Seconds and bytes left, null where the group has no such limit. A
 * `wall_clock` group whose clock has not started reports its whole duration.
 * Never negative.
 */
export function remaining(limits: GroupLimits, usage: GroupUsage, now: number): Remaining {
  let seconds: number | null = null
  if (limits.expiresAt !== null) {
    seconds = Math.max(0, Math.floor((limits.expiresAt - now) / 1000))
  }
  if (limits.durationSeconds !== null) {
    const fromDuration =
      limits.durationMode === 'active_time'
        ? Math.max(0, limits.durationSeconds - usage.timeUsedSeconds)
        : limits.expiresAt === null
          ? limits.durationSeconds
          : null
    if (fromDuration !== null)
      seconds = seconds === null ? fromDuration : Math.min(seconds, fromDuration)
  }
  const bytes = limits.quotaBytes === null ? null : Math.max(0, limits.quotaBytes - usage.bytesUsed)
  return { seconds, bytes }
}

/**
 * Why the group is used up, or null. Time is checked first: a group past its
 * deadline is `expired` even when its data ran out in the same tick.
 */
export function exhaustion(limits: GroupLimits, usage: GroupUsage, now: number): Exhaustion {
  if (limits.expiresAt !== null && now >= limits.expiresAt) return 'expired'
  if (
    limits.durationMode === 'active_time' &&
    limits.durationSeconds !== null &&
    usage.timeUsedSeconds >= limits.durationSeconds
  ) {
    return 'expired'
  }
  if (limits.quotaBytes !== null && usage.bytesUsed >= limits.quotaBytes) return 'quota'
  return null
}

/**
 * openNDS backstops passed with `ndsctl auth` (§4.4): session timeout in whole
 * minutes (rounded up, at least 1) and download quota in kB (rounded up).
 * Null = no backstop for that limit.
 */
export function ndsBackstops(
  limits: GroupLimits,
  usage: GroupUsage,
  now: number
): { sessionTimeoutMinutes: number | null; downloadQuotaKb: number | null } {
  const left = remaining(limits, usage, now)
  return {
    sessionTimeoutMinutes: left.seconds === null ? null : Math.max(1, Math.ceil(left.seconds / 60)),
    downloadQuotaKb: left.bytes === null ? null : Math.max(1, Math.ceil(left.bytes / 1000)),
  }
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export type GrantUsageRow = {
  id: number
  state: GrantState
  bytesUp: number
  bytesDown: number
  /** Charged active time attributed to this grant. */
  timeUsedSeconds: number
}

/** Sum of a group's grants. */
export function groupUsage(grants: readonly GrantUsageRow[]): GroupUsage {
  let timeUsedSeconds = 0
  let bytesUsed = 0
  for (const g of grants) {
    timeUsedSeconds += g.timeUsedSeconds
    bytesUsed += g.bytesUp + g.bytesDown
  }
  return { timeUsedSeconds, bytesUsed }
}

/**
 * `baseTimeUsedSeconds` / `baseBytesUsed` of a wire group: usage of the
 * group's grants that are **not** live on the router receiving it (ended,
 * queued, or live on another gateway), plus `carried` usage recorded outside
 * any grant row. The router adds its live grants' counters, so nothing is
 * counted twice.
 */
export function baseUsage(
  grants: readonly GrantUsageRow[],
  liveOnRouter: ReadonlySet<number>,
  carried: GroupUsage = { timeUsedSeconds: 0, bytesUsed: 0 }
): GroupUsage {
  return addUsage(groupUsage(grants.filter((g) => !liveOnRouter.has(g.id))), carried)
}

/**
 * Same as `baseUsage` for a group whose total is kept on a row of its own
 * (`vouchers.time_used_seconds` / `bytes_used`, which outlive pruned grant
 * rows): the total minus what the router holds live. Never negative.
 */
export function baseUsageFromTotal(
  total: GroupUsage,
  liveGrants: readonly GrantUsageRow[]
): GroupUsage {
  const live = groupUsage(liveGrants)
  return {
    timeUsedSeconds: Math.max(0, total.timeUsedSeconds - live.timeUsedSeconds),
    bytesUsed: Math.max(0, total.bytesUsed - live.bytesUsed),
  }
}

export function addUsage(a: GroupUsage, b: GroupUsage): GroupUsage {
  return {
    timeUsedSeconds: a.timeUsedSeconds + b.timeUsedSeconds,
    bytesUsed: a.bytesUsed + b.bytesUsed,
  }
}

/**
 * Cumulative counters from the router merged into the stored ones: each
 * counter only ever grows (the router may resend an older snapshot after a
 * reconnect, and a reboot can lose up to one persist interval), so the larger
 * value wins per counter.
 */
export function mergeCounters<T extends Record<string, number>>(
  stored: T,
  reported: Partial<T>
): T {
  const out = { ...stored }
  for (const key of Object.keys(stored) as Array<keyof T>) {
    const value = reported[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > (out[key] as number)) {
      out[key] = Math.floor(value) as T[keyof T]
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Entitlement order (owner decision 23: time is consumed before data buckets)
// ---------------------------------------------------------------------------

/**
 * - `time`: the group has a duration or a deadline (possibly also a quota,
 *   which is then its own cap).
 * - `data`: a pure data bucket (quota, no time limit).
 * - `open`: no limit at all (an admin grant); ranks with `time`, before data.
 */
export type EntitlementClass = 'time' | 'data' | 'open'

export function entitlementClass(limits: GroupLimits): EntitlementClass {
  if (limits.durationSeconds !== null || limits.expiresAt !== null) return 'time'
  if (limits.quotaBytes !== null) return 'data'
  return 'open'
}

export type Entitlement = {
  grantId: number
  limits: GroupLimits
  createdAt: number
}

const CLASS_RANK: Record<EntitlementClass, number> = { open: 0, time: 0, data: 1 }

/**
 * Consumption order of one device's entitlements on one portal: time (and
 * open) before data buckets; within time, a clock that is already running
 * (fixed deadline) before one that has not started, earlier deadlines first;
 * then the older grant.
 */
export function compareEntitlements(a: Entitlement, b: Entitlement): number {
  const rank = CLASS_RANK[entitlementClass(a.limits)] - CLASS_RANK[entitlementClass(b.limits)]
  if (rank !== 0) return rank
  const ae = a.limits.expiresAt
  const be = b.limits.expiresAt
  if (ae !== null && be === null) return -1
  if (ae === null && be !== null) return 1
  if (ae !== null && be !== null && ae !== be) return ae - be
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  return a.grantId - b.grantId
}

export function orderEntitlements<T extends Entitlement>(items: readonly T[]): T[] {
  return [...items].sort(compareEntitlements)
}

/**
 * Where a newly redeemed entitlement goes when the device already holds a
 * current one on the same portal:
 * - `queue`: behind it (the current one keeps running).
 * - `swap`: it becomes current and the current one goes back to the queue
 *   (a time voucher redeemed while a data bucket is running: the bucket
 *   pauses and resumes when the time is used up).
 */
export function placeBehindCurrent(current: Entitlement, candidate: Entitlement): 'queue' | 'swap' {
  const candidateClass = entitlementClass(candidate.limits)
  const currentClass = entitlementClass(current.limits)
  return candidateClass !== 'data' && currentClass === 'data' ? 'swap' : 'queue'
}

// ---------------------------------------------------------------------------
// Device slots
// ---------------------------------------------------------------------------

export type SlotHolder = {
  grantId: number
  mac: string
  /** When the grant became live (else its creation). */
  startedAt: number
  /** Last time the router saw the device (null = never). */
  lastSeenAt: number | null
}

/**
 * Grants to end so one more device fits into a group of `maxDevices`.
 *
 * - `oldest` (vouchers, decision 23): the device that joined first leaves,
 *   however recently it was seen. A shared code kicks the first device off.
 * - `unseen` (portal users): only devices not seen for `unseenMinutes` may be
 *   evicted, least recently seen first; `null` when that is not enough room
 *   (`device_limit`).
 */
export function evictionsForNewDevice(
  holders: readonly SlotHolder[],
  maxDevices: number,
  policy: 'oldest' | 'unseen',
  now: number,
  unseenMinutes: number
): number[] | null {
  const excess = holders.length - Math.max(1, maxDevices) + 1
  if (excess <= 0) return []
  if (policy === 'oldest') {
    return [...holders]
      .sort((a, b) => a.startedAt - b.startedAt || a.grantId - b.grantId)
      .slice(0, excess)
      .map((h) => h.grantId)
  }
  const cutoff = now - unseenMinutes * 60_000
  const stale = holders
    .filter((h) => (h.lastSeenAt ?? h.startedAt) <= cutoff)
    .sort(
      (a, b) =>
        (a.lastSeenAt ?? a.startedAt) - (b.lastSeenAt ?? b.startedAt) || a.grantId - b.grantId
    )
  if (stale.length < excess) return null
  return stale.slice(0, excess).map((h) => h.grantId)
}
