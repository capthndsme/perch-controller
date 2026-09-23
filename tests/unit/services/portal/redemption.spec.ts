import type { GroupLimits } from '#services/portal/types'
import {
  type RedemptionInput,
  type VoucherFacts,
  planUserLogin,
  planVoucherRedemption,
  voucherCreationClock,
  voucherPortal,
  voucherStatus,
} from '#services/portal/redemption'
import { test } from '@japa/runner'

const T0 = 1_790_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN
const MAC_A = '02:00:00:00:00:0a'
const MAC_B = '02:00:00:00:00:0b'
const MAC_C = '02:00:00:00:00:0c'

function voucher(
  patch: Partial<VoucherFacts> = {},
  limits: Partial<VoucherFacts['limits']> = {}
): VoucherFacts {
  return {
    id: 17,
    batchPortalId: 3,
    boundPortalId: null,
    firstUsedAt: null,
    revokedAt: null,
    batchRevokedAt: null,
    exhaustedAt: null,
    redeemBy: null,
    usage: { timeUsedSeconds: 0, bytesUsed: 0 },
    ...patch,
    limits: {
      durationSeconds: 3600,
      durationMode: 'wall_clock',
      startMode: 'first_use',
      quotaBytes: null,
      downKbps: null,
      upKbps: null,
      maxDevices: 1,
      expiresAt: null,
      ...limits,
    },
  }
}

function input(patch: Partial<RedemptionInput> = {}): RedemptionInput {
  return {
    now: T0,
    portalId: 3,
    mac: MAC_A,
    voucher: voucher(),
    holders: [],
    deviceCurrent: null,
    ...patch,
  }
}

const dataBucket = (
  grantId: number
): { grantId: number; limits: GroupLimits; createdAt: number } => ({
  grantId,
  createdAt: T0 - HOUR,
  limits: {
    durationMode: 'wall_clock',
    expiresAt: null,
    durationSeconds: null,
    quotaBytes: 1e9,
    downKbps: null,
    upKbps: null,
    maxDevices: 1,
  },
})

test.group('voucher status', () => {
  test('unused, active, revoked (voucher or batch)', ({ assert }) => {
    assert.equal(voucherStatus(voucher(), T0), 'unused')
    assert.equal(
      voucherStatus(voucher({ firstUsedAt: T0 }, { expiresAt: T0 + HOUR }), T0),
      'active'
    )
    assert.equal(voucherStatus(voucher({ revokedAt: T0 - 1 }), T0), 'revoked')
    assert.equal(voucherStatus(voucher({ batchRevokedAt: T0 - 1 }), T0), 'revoked')
  })

  test('expired: past its deadline, its active budget, or unused past redeemBy', ({ assert }) => {
    assert.equal(
      voucherStatus(voucher({ firstUsedAt: T0 - HOUR }, { expiresAt: T0 }), T0),
      'expired'
    )
    assert.equal(
      voucherStatus(
        voucher(
          { firstUsedAt: T0 - HOUR, usage: { timeUsedSeconds: 3600, bytesUsed: 0 } },
          { durationMode: 'active_time' }
        ),
        T0
      ),
      'expired'
    )
    assert.equal(voucherStatus(voucher({ redeemBy: T0 }), T0), 'expired')
    // redeemBy does not end a voucher already in use.
    assert.equal(
      voucherStatus(voucher({ redeemBy: T0 - 1, firstUsedAt: T0 - 2 }, { expiresAt: T0 + 1 }), T0),
      'active'
    )
  })

  test('creation-start voucher expires unused', ({ assert }) => {
    assert.equal(
      voucherStatus(voucher({}, { startMode: 'creation', expiresAt: T0 - 1 }), T0),
      'expired'
    )
  })

  test('exhausted: quota reached, or marked', ({ assert }) => {
    const v = voucher(
      { firstUsedAt: T0 - 1, usage: { timeUsedSeconds: 0, bytesUsed: 100 } },
      { durationSeconds: null, quotaBytes: 100 }
    )
    assert.equal(voucherStatus(v, T0), 'exhausted')
    assert.equal(
      voucherStatus(voucher({ firstUsedAt: T0 - 1, exhaustedAt: T0 - 1 }), T0),
      'exhausted'
    )
  })

  test('voucherPortal: bound beats batch', ({ assert }) => {
    assert.equal(voucherPortal({ boundPortalId: 4, batchPortalId: 3 }), 4)
    assert.equal(voucherPortal({ boundPortalId: null, batchPortalId: 3 }), 3)
    assert.isNull(voucherPortal({ boundPortalId: null, batchPortalId: null }))
  })

  test('creation clock helper', ({ assert }) => {
    assert.deepEqual(voucherCreationClock(voucher({}, { startMode: 'creation' }).limits, T0), {
      startsAt: T0,
      expiresAt: T0 + HOUR,
    })
    assert.isNull(voucherCreationClock(voucher().limits, T0))
  })
})

test.group('voucher redemption plan', () => {
  test('first redemption on a free device: binds, starts the clock, runs now', ({ assert }) => {
    const plan = planVoucherRedemption(input({ voucher: voucher({ batchPortalId: null }) }))
    assert.deepEqual(plan, {
      ok: true,
      bindPortalId: 3,
      firstUse: true,
      clock: { startsAt: T0, expiresAt: T0 + HOUR },
      placement: 'current',
      demoteGrantId: null,
      evictGrantIds: [],
    })
  })

  test('the batch portal is bound too (the voucher binds to where it was used)', ({ assert }) => {
    const plan = planVoucherRedemption(input())
    assert.isTrue(plan.ok)
    if (plan.ok) assert.equal(plan.bindPortalId, 3)
  })

  test('wrong portal, revoked, expired, exhausted', ({ assert }) => {
    assert.deepEqual(planVoucherRedemption(input({ portalId: 4 })), {
      ok: false,
      error: 'wrong_portal',
    })
    assert.deepEqual(
      planVoucherRedemption(
        input({ portalId: 4, voucher: voucher({ batchPortalId: null, boundPortalId: 3 }) })
      ),
      { ok: false, error: 'wrong_portal' }
    )
    assert.deepEqual(planVoucherRedemption(input({ voucher: voucher({ revokedAt: T0 - 1 }) })), {
      ok: false,
      error: 'revoked',
    })
    assert.deepEqual(planVoucherRedemption(input({ voucher: voucher({ redeemBy: T0 - 1 }) })), {
      ok: false,
      error: 'expired',
    })
    assert.deepEqual(
      planVoucherRedemption(
        input({
          voucher: voucher(
            { firstUsedAt: T0 - 1, usage: { timeUsedSeconds: 0, bytesUsed: 5 } },
            { durationSeconds: null, quotaBytes: 5 }
          ),
        })
      ),
      { ok: false, error: 'exhausted' }
    )
  })

  test('the same device again: already authorized, with its grant', ({ assert }) => {
    const plan = planVoucherRedemption(
      input({ holders: [{ grantId: 5, mac: MAC_A, startedAt: T0, lastSeenAt: T0, queued: false }] })
    )
    assert.deepEqual(plan, { ok: false, error: 'already_authorized', grantId: 5 })
  })

  test('decision 23: a new device moves the voucher and the first device leaves', ({ assert }) => {
    const v = voucher(
      { firstUsedAt: T0 - HOUR / 2, boundPortalId: 3 },
      { expiresAt: T0 + HOUR / 2 }
    )
    const plan = planVoucherRedemption(
      input({
        mac: MAC_B,
        voucher: v,
        holders: [
          { grantId: 5, mac: MAC_A, startedAt: T0 - HOUR / 2, lastSeenAt: T0, queued: false },
        ],
      })
    )
    assert.deepEqual(plan, {
      ok: true,
      bindPortalId: null,
      firstUse: false,
      clock: null, // the running clock is kept
      placement: 'current',
      demoteGrantId: null,
      evictGrantIds: [5],
    })
  })

  test('decision 23 with two devices: the oldest of the two leaves', ({ assert }) => {
    const v = voucher(
      { firstUsedAt: T0 - HOUR, boundPortalId: 3 },
      { expiresAt: T0 + HOUR, maxDevices: 2 }
    )
    const plan = planVoucherRedemption(
      input({
        mac: MAC_C,
        voucher: v,
        holders: [
          {
            grantId: 7,
            mac: MAC_B,
            startedAt: T0 - 10 * MIN,
            lastSeenAt: T0 - 5 * HOUR,
            queued: false,
          },
          { grantId: 5, mac: MAC_A, startedAt: T0 - HOUR, lastSeenAt: T0, queued: false },
        ],
      })
    )
    assert.isTrue(plan.ok)
    if (plan.ok) assert.deepEqual(plan.evictGrantIds, [5])
  })

  test('decision 23: time over a running data bucket swaps it into the queue', ({ assert }) => {
    const plan = planVoucherRedemption(input({ deviceCurrent: dataBucket(9) }))
    assert.isTrue(plan.ok)
    if (plan.ok) {
      assert.equal(plan.placement, 'swap')
      assert.equal(plan.demoteGrantId, 9)
      assert.deepEqual(plan.clock, { startsAt: T0, expiresAt: T0 + HOUR })
    }
  })

  test('a data bucket behind a running time voucher queues, and a queued clock does not start', ({
    assert,
  }) => {
    const plan = planVoucherRedemption(
      input({
        voucher: voucher({}, { durationSeconds: 3600 }),
        deviceCurrent: {
          grantId: 9,
          createdAt: T0,
          limits: {
            ...dataBucket(9).limits,
            quotaBytes: null,
            durationSeconds: 600,
            expiresAt: T0 + 600_000,
          },
        },
      })
    )
    assert.isTrue(plan.ok)
    if (plan.ok) {
      assert.equal(plan.placement, 'queue')
      assert.isNull(plan.clock)
      assert.isNull(plan.demoteGrantId)
      assert.isTrue(plan.firstUse)
    }
  })
})

test.group('portal user login plan', () => {
  const user = { enabled: true, portalIds: null, maxDevices: 1, sessionMinutes: 60 }

  test('login sets the per-login deadline', ({ assert }) => {
    assert.deepEqual(
      planUserLogin({ now: T0, portalId: 3, mac: MAC_A, user, holders: [], unseenMinutes: 10 }),
      { ok: true, evictGrantIds: [], expiresAt: T0 + HOUR }
    )
    assert.deepEqual(
      planUserLogin({
        now: T0,
        portalId: 3,
        mac: MAC_A,
        user: { ...user, sessionMinutes: null },
        holders: [],
        unseenMinutes: 10,
      }),
      { ok: true, evictGrantIds: [], expiresAt: null }
    )
  })

  test('disabled, wrong portal, already authorized', ({ assert }) => {
    const base = { now: T0, portalId: 3, mac: MAC_A, holders: [], unseenMinutes: 10 }
    assert.deepEqual(planUserLogin({ ...base, user: { ...user, enabled: false } }), {
      ok: false,
      error: 'disabled',
    })
    assert.deepEqual(planUserLogin({ ...base, user: { ...user, portalIds: [4] } }), {
      ok: false,
      error: 'wrong_portal',
    })
    assert.deepEqual(
      planUserLogin({
        ...base,
        user,
        holders: [{ grantId: 2, mac: MAC_A, startedAt: T0, lastSeenAt: T0 }],
      }),
      { ok: false, error: 'already_authorized', grantId: 2 }
    )
  })

  test('a full user evicts only an unseen device, else device_limit', ({ assert }) => {
    const base = { now: T0, portalId: 3, mac: MAC_B, user, unseenMinutes: 10 }
    assert.deepEqual(
      planUserLogin({
        ...base,
        holders: [{ grantId: 2, mac: MAC_A, startedAt: T0 - HOUR, lastSeenAt: T0 - MIN }],
      }),
      { ok: false, error: 'device_limit' }
    )
    assert.deepEqual(
      planUserLogin({
        ...base,
        holders: [{ grantId: 2, mac: MAC_A, startedAt: T0 - HOUR, lastSeenAt: T0 - 11 * MIN }],
      }),
      { ok: true, evictGrantIds: [2], expiresAt: T0 + HOUR }
    )
  })
})
