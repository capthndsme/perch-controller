import {
  type Entitlement,
  type VoucherLimitsInput,
  baseUsage,
  baseUsageFromTotal,
  compareEntitlements,
  creationClock,
  entitlementClass,
  evictionsForNewDevice,
  exhaustion,
  grantLimits,
  groupUsage,
  mergeCounters,
  ndsBackstops,
  orderEntitlements,
  placeBehindCurrent,
  remaining,
  startVoucherClock,
  voucherGroupLimits,
} from '#services/portal/groups'
import type { GroupLimits } from '#services/portal/types'
import { groupKey, normalizeMac, parseGroupKey } from '#services/portal/types'
import { test } from '@japa/runner'

const T0 = 1_790_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN

function limits(patch: Partial<GroupLimits> = {}): GroupLimits {
  return {
    durationMode: 'wall_clock',
    expiresAt: null,
    durationSeconds: null,
    quotaBytes: null,
    downKbps: null,
    upKbps: null,
    maxDevices: 1,
    ...patch,
  }
}

function voucherInput(patch: Partial<VoucherLimitsInput> = {}): VoucherLimitsInput {
  return {
    durationSeconds: 3600,
    durationMode: 'wall_clock',
    startMode: 'first_use',
    quotaBytes: null,
    downKbps: null,
    upKbps: null,
    maxDevices: 1,
    expiresAt: null,
    ...patch,
  }
}

const NONE = { timeUsedSeconds: 0, bytesUsed: 0 }

test.group('portal types', () => {
  test('group keys round-trip', ({ assert }) => {
    assert.equal(groupKey('voucher', 17), 'v:17')
    assert.equal(groupKey('user', 3), 'u:3')
    assert.equal(groupKey('grant', 99), 'g:99')
    assert.deepEqual(parseGroupKey('v:17'), { kind: 'voucher', id: 17 })
    assert.deepEqual(parseGroupKey('g:99'), { kind: 'grant', id: 99 })
    assert.isNull(parseGroupKey('v:0'))
    assert.isNull(parseGroupKey('x:1'))
    assert.isNull(parseGroupKey('v:01'))
    assert.isNull(parseGroupKey('v:12345678901234567'))
    assert.throws(() => groupKey('voucher', 0), /invalid group id/)
  })

  test('MACs normalize; broadcast, zero and multicast are refused', ({ assert }) => {
    assert.equal(normalizeMac('02-00-00-AA-BB-CC'), '02:00:00:aa:bb:cc')
    assert.equal(normalizeMac('0200.00aa.bbcc'), '02:00:00:aa:bb:cc')
    assert.equal(normalizeMac(' 020000AABBCC '), '02:00:00:aa:bb:cc')
    assert.isNull(normalizeMac('ff:ff:ff:ff:ff:ff'))
    assert.isNull(normalizeMac('00:00:00:00:00:00'))
    assert.isNull(normalizeMac('01:00:5e:00:00:01'))
    assert.isNull(normalizeMac('02:00:00:aa:bb'))
    assert.isNull(normalizeMac(42))
  })
})

test.group('portal groups: limits and clocks', () => {
  test('wall clock voucher: deadline only once started', ({ assert }) => {
    assert.isNull(voucherGroupLimits(voucherInput()).expiresAt)
    assert.equal(voucherGroupLimits(voucherInput({ expiresAt: T0 })).expiresAt, T0)
    assert.equal(voucherGroupLimits(voucherInput({ maxDevices: 0 })).maxDevices, 1)
  })

  test('active time voucher never has a wall-clock deadline', ({ assert }) => {
    const l = voucherGroupLimits(voucherInput({ durationMode: 'active_time', expiresAt: T0 }))
    assert.isNull(l.expiresAt)
    assert.equal(l.durationSeconds, 3600)
  })

  test('startVoucherClock starts only unstarted wall clocks with a duration', ({ assert }) => {
    assert.deepEqual(startVoucherClock(voucherInput(), T0), { startsAt: T0, expiresAt: T0 + HOUR })
    assert.isNull(startVoucherClock(voucherInput({ expiresAt: T0 }), T0))
    assert.isNull(startVoucherClock(voucherInput({ durationMode: 'active_time' }), T0))
    assert.isNull(startVoucherClock(voucherInput({ durationSeconds: null }), T0))
  })

  test('creationClock only for creation-start wall clocks', ({ assert }) => {
    assert.deepEqual(creationClock(voucherInput({ startMode: 'creation' }), T0), {
      startsAt: T0,
      expiresAt: T0 + HOUR,
    })
    assert.isNull(creationClock(voucherInput(), T0))
    assert.isNull(
      creationClock(voucherInput({ startMode: 'creation', durationMode: 'active_time' }), T0)
    )
    assert.isNull(creationClock(voucherInput({ startMode: 'creation', durationSeconds: null }), T0))
  })

  test('grantLimits: the earlier deadline wins', ({ assert }) => {
    assert.equal(grantLimits(limits(), T0).expiresAt, T0)
    assert.equal(grantLimits(limits({ expiresAt: T0 }), T0 + 1).expiresAt, T0)
    assert.equal(grantLimits(limits({ expiresAt: T0 + 1 }), T0).expiresAt, T0)
    const l = limits({ expiresAt: T0 })
    assert.strictEqual(grantLimits(l, null), l)
  })
})

test.group('portal groups: remaining and exhaustion', () => {
  test('wall clock: seconds to the deadline, never negative', ({ assert }) => {
    const l = limits({ expiresAt: T0 + 90_500, durationSeconds: 3600 })
    assert.deepEqual(remaining(l, NONE, T0), { seconds: 90, bytes: null })
    assert.deepEqual(remaining(l, NONE, T0 + 200_000), { seconds: 0, bytes: null })
  })

  test('wall clock not started: the whole duration', ({ assert }) => {
    assert.equal(remaining(limits({ durationSeconds: 3600 }), NONE, T0).seconds, 3600)
  })

  test('active time: budget minus charged time; a deadline caps it', ({ assert }) => {
    const l = limits({ durationMode: 'active_time', durationSeconds: 600 })
    assert.equal(remaining(l, { timeUsedSeconds: 100, bytesUsed: 0 }, T0).seconds, 500)
    assert.equal(remaining(l, { timeUsedSeconds: 700, bytesUsed: 0 }, T0).seconds, 0)
    const capped = { ...l, expiresAt: T0 + 60_000 }
    assert.equal(remaining(capped, { timeUsedSeconds: 100, bytesUsed: 0 }, T0).seconds, 60)
  })

  test('data: quota minus used; no limits = nulls', ({ assert }) => {
    assert.deepEqual(
      remaining(limits({ quotaBytes: 1000 }), { timeUsedSeconds: 0, bytesUsed: 400 }, T0),
      {
        seconds: null,
        bytes: 600,
      }
    )
    assert.equal(
      remaining(limits({ quotaBytes: 1000 }), { timeUsedSeconds: 0, bytesUsed: 4000 }, T0).bytes,
      0
    )
    assert.deepEqual(remaining(limits(), NONE, T0), { seconds: null, bytes: null })
  })

  test('exhaustion: deadline, active budget, quota; time first', ({ assert }) => {
    assert.isNull(exhaustion(limits({ expiresAt: T0 + 1 }), NONE, T0))
    assert.equal(exhaustion(limits({ expiresAt: T0 }), NONE, T0), 'expired')
    const active = limits({ durationMode: 'active_time', durationSeconds: 60 })
    assert.isNull(exhaustion(active, { timeUsedSeconds: 59, bytesUsed: 0 }, T0))
    assert.equal(exhaustion(active, { timeUsedSeconds: 60, bytesUsed: 0 }, T0), 'expired')
    const both = limits({ expiresAt: T0, quotaBytes: 10 })
    assert.equal(exhaustion(both, { timeUsedSeconds: 0, bytesUsed: 10 }, T0), 'expired')
    assert.equal(
      exhaustion(limits({ quotaBytes: 10 }), { timeUsedSeconds: 0, bytesUsed: 10 }, T0),
      'quota'
    )
    assert.isNull(exhaustion(limits({ quotaBytes: 10 }), { timeUsedSeconds: 0, bytesUsed: 9 }, T0))
    // A wall clock that has not started does not expire from charged time.
    assert.isNull(
      exhaustion(limits({ durationSeconds: 60 }), { timeUsedSeconds: 600, bytesUsed: 0 }, T0)
    )
  })

  test('openNDS backstops round up and never go below one', ({ assert }) => {
    const l = limits({ expiresAt: T0 + 61_000, quotaBytes: 1_500_001 })
    assert.deepEqual(ndsBackstops(l, NONE, T0), { sessionTimeoutMinutes: 2, downloadQuotaKb: 1501 })
    assert.deepEqual(ndsBackstops(l, { timeUsedSeconds: 0, bytesUsed: 2e6 }, T0 + 1e6), {
      sessionTimeoutMinutes: 1,
      downloadQuotaKb: 1,
    })
    assert.deepEqual(ndsBackstops(limits(), NONE, T0), {
      sessionTimeoutMinutes: null,
      downloadQuotaKb: null,
    })
  })
})

test.group('portal groups: usage', () => {
  const rows = [
    { id: 1, state: 'ended' as const, bytesUp: 10, bytesDown: 100, timeUsedSeconds: 5 },
    { id: 2, state: 'active' as const, bytesUp: 20, bytesDown: 200, timeUsedSeconds: 7 },
    { id: 3, state: 'active' as const, bytesUp: 1, bytesDown: 2, timeUsedSeconds: 0 },
  ]

  test('groupUsage sums every grant', ({ assert }) => {
    assert.deepEqual(groupUsage(rows), { timeUsedSeconds: 12, bytesUsed: 333 })
    assert.deepEqual(groupUsage([]), NONE)
  })

  test('baseUsage leaves out what the router holds live', ({ assert }) => {
    assert.deepEqual(baseUsage(rows, new Set([2, 3])), { timeUsedSeconds: 5, bytesUsed: 110 })
    assert.deepEqual(baseUsage(rows, new Set([2]), { timeUsedSeconds: 1, bytesUsed: 1 }), {
      timeUsedSeconds: 6,
      bytesUsed: 114,
    })
  })

  test('baseUsageFromTotal subtracts live grants, never below zero', ({ assert }) => {
    assert.deepEqual(baseUsageFromTotal({ timeUsedSeconds: 100, bytesUsed: 1000 }, rows.slice(1)), {
      timeUsedSeconds: 93,
      bytesUsed: 777,
    })
    assert.deepEqual(baseUsageFromTotal({ timeUsedSeconds: 1, bytesUsed: 1 }, rows), NONE)
  })

  test('mergeCounters keeps the larger value per counter', ({ assert }) => {
    const stored = { bytesUp: 10, bytesDown: 20, activeSeconds: 5 }
    assert.deepEqual(mergeCounters(stored, { bytesUp: 5, bytesDown: 25.9 }), {
      bytesUp: 10,
      bytesDown: 25,
      activeSeconds: 5,
    })
    assert.deepEqual(
      mergeCounters(stored, { bytesUp: Number.NaN, activeSeconds: Infinity }),
      stored
    )
  })
})

test.group('portal groups: entitlement order (decision 23)', () => {
  const e = (grantId: number, l: Partial<GroupLimits>, createdAt = T0): Entitlement => ({
    grantId,
    limits: limits(l),
    createdAt,
  })

  test('classes', ({ assert }) => {
    assert.equal(entitlementClass(limits({ durationSeconds: 60 })), 'time')
    assert.equal(entitlementClass(limits({ expiresAt: T0 })), 'time')
    assert.equal(entitlementClass(limits({ durationSeconds: 60, quotaBytes: 1 })), 'time')
    assert.equal(entitlementClass(limits({ quotaBytes: 1 })), 'data')
    assert.equal(entitlementClass(limits()), 'open')
  })

  test('time before data buckets, running clocks first, earlier deadline first', ({ assert }) => {
    const data = e(1, { quotaBytes: 1e9 }, T0 - HOUR)
    const notStarted = e(2, { durationSeconds: 3600 })
    const late = e(3, { expiresAt: T0 + 2 * HOUR, durationSeconds: 3600 })
    const soon = e(4, { expiresAt: T0 + HOUR, durationSeconds: 3600 })
    const open = e(5, {}, T0 + 1)
    const order = orderEntitlements([data, notStarted, late, open, soon]).map((x) => x.grantId)
    assert.deepEqual(order, [4, 3, 2, 5, 1])
  })

  test('ties fall back to creation, then id', ({ assert }) => {
    assert.isBelow(
      compareEntitlements(e(9, { quotaBytes: 1 }, T0), e(1, { quotaBytes: 1 }, T0 + 1)),
      0
    )
    assert.isBelow(compareEntitlements(e(1, { quotaBytes: 1 }), e(2, { quotaBytes: 1 })), 0)
  })

  test('a time voucher over a running data bucket swaps; everything else queues', ({ assert }) => {
    const data = e(1, { quotaBytes: 1e9 })
    const time = e(2, { durationSeconds: 3600 })
    assert.equal(placeBehindCurrent(data, time), 'swap')
    assert.equal(placeBehindCurrent(data, e(3, {})), 'swap')
    assert.equal(placeBehindCurrent(time, data), 'queue')
    assert.equal(placeBehindCurrent(time, e(4, { durationSeconds: 60 })), 'queue')
    assert.equal(placeBehindCurrent(data, e(5, { quotaBytes: 5 })), 'queue')
  })
})

test.group('portal groups: device slots', () => {
  const h = (grantId: number, startedAt: number, lastSeenAt: number | null = null) => ({
    grantId,
    mac: `02:00:00:00:00:0${grantId}`,
    startedAt,
    lastSeenAt,
  })

  test('room left: nothing to evict', ({ assert }) => {
    assert.deepEqual(evictionsForNewDevice([h(1, T0)], 2, 'oldest', T0, 10), [])
    assert.deepEqual(evictionsForNewDevice([], 1, 'unseen', T0, 10), [])
  })

  test('oldest: the first device leaves, whenever it was seen', ({ assert }) => {
    const holders = [h(2, T0 + 5, T0 + 100), h(1, T0, T0 + 100), h(3, T0 + 9)]
    assert.deepEqual(evictionsForNewDevice(holders, 3, 'oldest', T0, 10), [1])
    assert.deepEqual(evictionsForNewDevice(holders, 1, 'oldest', T0, 10), [1, 2, 3])
    assert.deepEqual(evictionsForNewDevice([h(5, T0), h(4, T0)], 2, 'oldest', T0, 10), [4])
  })

  test('unseen: only devices quiet for the window, least recently seen first', ({ assert }) => {
    const now = T0 + HOUR
    const holders = [h(1, T0, now - 5 * MIN), h(2, T0, now - 30 * MIN), h(3, T0, null)]
    assert.deepEqual(evictionsForNewDevice(holders, 3, 'unseen', now, 10), [3])
    assert.deepEqual(evictionsForNewDevice(holders, 2, 'unseen', now, 10), [3, 2])
    assert.isNull(evictionsForNewDevice(holders, 1, 'unseen', now, 10))
    assert.isNull(evictionsForNewDevice([h(1, T0, now)], 1, 'unseen', now, 10))
  })
})
