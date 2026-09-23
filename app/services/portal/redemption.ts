import {
  type Entitlement,
  type SlotHolder,
  type VoucherLimitsInput,
  creationClock,
  evictionsForNewDevice,
  exhaustion,
  placeBehindCurrent,
  startVoucherClock,
  voucherGroupLimits,
} from '#services/portal/groups'
import type { GroupUsage } from '#services/portal/types'

/**
 * Voucher status and the redemption decision (docs/gateway/portal.md §4.1,
 * §4.6). The controller runs `planVoucherRedemption` for an online
 * `portal.redeem`; the router runs the same rules for an offline redemption
 * (owner decision 20), which is why they are spelled out as one pure
 * function with a test table.
 */

export type VoucherStatus = 'unused' | 'active' | 'exhausted' | 'expired' | 'revoked'

export type VoucherFacts = {
  id: number
  /** The batch's portal (null = any portal until first redeemed). */
  batchPortalId: number | null
  boundPortalId: number | null
  firstUsedAt: number | null
  revokedAt: number | null
  /** Batch revoked. */
  batchRevokedAt: number | null
  exhaustedAt: number | null
  redeemBy: number | null
  limits: VoucherLimitsInput
  usage: GroupUsage
}

export function voucherStatus(v: VoucherFacts, now: number): VoucherStatus {
  if (v.revokedAt !== null || v.batchRevokedAt !== null) return 'revoked'
  const why = exhaustion(voucherGroupLimits(v.limits), v.usage, now)
  if (why === 'expired') return 'expired'
  if (why === 'quota') return 'exhausted'
  if (v.exhaustedAt !== null) return 'exhausted'
  if (v.firstUsedAt === null) {
    if (v.redeemBy !== null && now >= v.redeemBy) return 'expired'
    return 'unused'
  }
  return 'active'
}

/** The portal a voucher is valid on: its bound portal, else its batch's, else any (null). */
export function voucherPortal(
  v: Pick<VoucherFacts, 'boundPortalId' | 'batchPortalId'>
): number | null {
  return v.boundPortalId ?? v.batchPortalId
}

export type RedemptionError =
  | 'revoked'
  | 'expired'
  | 'exhausted'
  | 'wrong_portal'
  | 'already_authorized'

export type RedemptionPlan =
  | { ok: false; error: RedemptionError; grantId?: number }
  | {
      ok: true
      /** Set `bound_portal_id` (first redemption of an any-portal voucher). */
      bindPortalId: number | null
      /** First redemption: set `first_used_at`. */
      firstUse: boolean
      /** Start the wall clock now (`starts_at`/`expires_at`), when the new grant runs at once. */
      clock: { startsAt: number; expiresAt: number } | null
      /**
       * - `current`: the device had nothing live on this portal; the grant runs now.
       * - `queue`: behind the device's current entitlement (decision 23).
       * - `swap`: runs now; `demoteGrantId` goes back to the queue.
       */
      placement: 'current' | 'queue' | 'swap'
      demoteGrantId: number | null
      /** Grants of this voucher to end with reason `moved` (decision 23). */
      evictGrantIds: number[]
    }

export type RedemptionInput = {
  now: number
  portalId: number
  mac: string
  voucher: VoucherFacts
  /** Non-ended grants of the voucher's group (live and queued), on any device. */
  holders: ReadonlyArray<SlotHolder & { queued: boolean }>
  /**
   * The device's current (live) entitlement on this portal from another
   * group, if any. Its queued entitlements do not matter: a new one never
   * displaces the current one unless it is a time voucher over a data bucket.
   */
  deviceCurrent: Entitlement | null
}

export function planVoucherRedemption(input: RedemptionInput): RedemptionPlan {
  const { now, portalId, mac, voucher } = input
  const portal = voucherPortal(voucher)
  if (portal !== null && portal !== portalId) return { ok: false, error: 'wrong_portal' }

  const status = voucherStatus(voucher, now)
  if (status === 'revoked' || status === 'expired' || status === 'exhausted') {
    return { ok: false, error: status }
  }

  const mine = input.holders.find((h) => h.mac === mac)
  if (mine) return { ok: false, error: 'already_authorized', grantId: mine.grantId }

  // Decision 23: a voucher follows the newest device; when it is full the
  // device that joined first leaves (`moved`), wherever it is.
  const evictGrantIds =
    evictionsForNewDevice(input.holders, voucher.limits.maxDevices, 'oldest', now, 0) ?? []

  const limits = voucherGroupLimits(voucher.limits)
  let placement: 'current' | 'queue' | 'swap' = 'current'
  let demoteGrantId: number | null = null
  if (input.deviceCurrent) {
    placement = placeBehindCurrent(input.deviceCurrent, {
      grantId: Number.MAX_SAFE_INTEGER,
      limits,
      createdAt: now,
    })
    if (placement === 'swap') demoteGrantId = input.deviceCurrent.grantId
  }

  // A voucher that already runs on another device keeps its clock; a queued
  // one starts when promoted.
  const runsNow = placement !== 'queue'
  const clock = runsNow ? startVoucherClock(voucher.limits, now) : null

  return {
    ok: true,
    bindPortalId: voucher.boundPortalId === null ? portalId : null,
    firstUse: voucher.firstUsedAt === null,
    clock,
    placement,
    demoteGrantId,
    evictGrantIds,
  }
}

/** `{startsAt, expiresAt}` for a voucher created now, when its batch starts at creation. */
export function voucherCreationClock(
  limits: VoucherLimitsInput,
  now: number
): { startsAt: number; expiresAt: number } | null {
  return creationClock(limits, now)
}

// ---------------------------------------------------------------------------
// Portal users (P2): same slot rules, but devices are only evicted when
// unseen for a while, else the login fails with `device_limit`.
// ---------------------------------------------------------------------------

export type LoginPlan =
  | {
      ok: false
      error: 'disabled' | 'wrong_portal' | 'device_limit' | 'already_authorized'
      grantId?: number
    }
  | { ok: true; evictGrantIds: number[]; expiresAt: number | null }

export function planUserLogin(input: {
  now: number
  portalId: number
  mac: string
  user: {
    enabled: boolean
    portalIds: readonly number[] | null
    maxDevices: number
    sessionMinutes: number | null
  }
  holders: readonly SlotHolder[]
  unseenMinutes: number
}): LoginPlan {
  const { now, user } = input
  if (!user.enabled) return { ok: false, error: 'disabled' }
  if (user.portalIds !== null && !user.portalIds.includes(input.portalId)) {
    return { ok: false, error: 'wrong_portal' }
  }
  const mine = input.holders.find((h) => h.mac === input.mac)
  if (mine) return { ok: false, error: 'already_authorized', grantId: mine.grantId }
  const evict = evictionsForNewDevice(
    input.holders,
    user.maxDevices,
    'unseen',
    now,
    input.unseenMinutes
  )
  if (evict === null) return { ok: false, error: 'device_limit' }
  return {
    ok: true,
    evictGrantIds: evict,
    expiresAt: user.sessionMinutes === null ? null : now + user.sessionMinutes * 60_000,
  }
}
