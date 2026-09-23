import {
  type PortalDbChanges,
  type RouterGrantUsage,
  type RouterPortalReport,
  type ServerGrant,
  type ServerPortalState,
  type ServerVoucher,
  reconcile,
} from '#services/portal/reconcile'
import { test } from '@japa/runner'

const NOW = 1_790_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN
const MAC_A = '02:00:00:00:00:0a'
const MAC_B = '02:00:00:00:00:0b'
const VERIFIER = 'a'.repeat(64)

function voucher(
  id: number,
  patch: Partial<ServerVoucher> = {},
  limits: Partial<ServerVoucher['limits']> = {}
): ServerVoucher {
  return {
    id,
    batchPortalId: 1,
    boundPortalId: 1,
    firstUsedAt: NOW - HOUR,
    revokedAt: null,
    batchRevokedAt: null,
    exhaustedAt: null,
    redeemBy: null,
    usage: { timeUsedSeconds: 0, bytesUsed: 0 },
    revision: 1,
    createdAt: NOW - 2 * HOUR,
    verifier: VERIFIER,
    startsAt: NOW - HOUR,
    ...patch,
    limits: {
      durationSeconds: 2 * 3600,
      durationMode: 'wall_clock',
      startMode: 'first_use',
      quotaBytes: null,
      downKbps: null,
      upKbps: null,
      maxDevices: 1,
      expiresAt: NOW + HOUR,
      ...limits,
    },
  }
}

function grant(
  id: number,
  patch: Partial<ServerGrant> = {},
  lc: Partial<ServerGrant['lifecycle']> = {}
): ServerGrant {
  return {
    id,
    portalId: 1,
    mac: MAC_A,
    groupKey: 'v:10',
    source: 'voucher',
    voucherId: 10,
    expiresAt: null,
    createdAt: NOW - HOUR,
    bytesUp: 0,
    bytesDown: 0,
    timeUsedSeconds: 0,
    ip: null,
    hostname: null,
    lastSeenAt: null,
    localRef: null,
    ...patch,
    lifecycle: {
      state: 'active',
      delivery: 'applied',
      revision: 1,
      startedAt: NOW - HOUR,
      endedAt: null,
      endReason: null,
      ...lc,
    },
  }
}

function state(patch: Partial<ServerPortalState> = {}): ServerPortalState {
  return {
    gatewayId: 7,
    now: NOW,
    ackedEventSeq: 0,
    portals: [{ id: 1, enabled: true }],
    grants: [],
    groups: [],
    vouchers: [],
    offline: { enabled: true, limit: 100 },
    ...patch,
  }
}

function report(patch: Partial<RouterPortalReport> = {}): RouterPortalReport {
  return { lastEventSeq: 0, truncated: false, events: [], grants: [], externals: [], ...patch }
}

function usage(grantId: number | null, patch: Partial<RouterGrantUsage> = {}): RouterGrantUsage {
  return {
    grantId,
    localRef: null,
    portalId: 1,
    mac: MAC_A,
    ip: '192.168.20.10',
    bytesUp: 0,
    bytesDown: 0,
    activeSeconds: 0,
    state: 'active',
    lastSeenAt: NOW - 1000,
    revision: 1,
    ...patch,
  }
}

function update(changes: PortalDbChanges, id: number) {
  return changes.grantUpdates.find((u) => u.id === id)?.set
}

function opens(c: PortalDbChanges) {
  return c.sessions.filter((x) => x.op === 'open')
}

function closes(c: PortalDbChanges) {
  return c.sessions.filter((x) => x.op === 'close')
}

function voucherAdd(changes: PortalDbChanges, id: number) {
  return changes.voucherUpdates.find((u) => u.id === id)?.add
}

function voucherSet(changes: PortalDbChanges, id: number) {
  return changes.voucherUpdates.find((u) => u.id === id)?.set
}

/** Folds db changes back into the server state, like the persistence layer would. */
function applyChanges(s: ServerPortalState, c: PortalDbChanges, nextId = 1000): ServerPortalState {
  let id = nextId
  const grants: ServerGrant[] = s.grants.map((g) => {
    const set = update(c, g.id)
    if (!set) return g
    const { state: st, delivery, revision, startedAt, endedAt, endReason, ...rest } = set
    return {
      ...g,
      ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
      lifecycle: {
        state: st ?? g.lifecycle.state,
        delivery: delivery ?? g.lifecycle.delivery,
        revision: revision ?? g.lifecycle.revision,
        startedAt: startedAt !== undefined ? startedAt : g.lifecycle.startedAt,
        endedAt: endedAt !== undefined ? endedAt : g.lifecycle.endedAt,
        endReason: endReason !== undefined ? endReason : g.lifecycle.endReason,
      },
    }
  })
  for (const ins of c.grantInserts) {
    grants.push({
      id: id++,
      portalId: ins.portalId,
      mac: ins.mac,
      groupKey: ins.groupKey,
      source: ins.source,
      voucherId: ins.voucherId,
      expiresAt: ins.expiresAt,
      createdAt: ins.createdAt,
      bytesUp: ins.bytesUp,
      bytesDown: ins.bytesDown,
      timeUsedSeconds: ins.timeUsedSeconds,
      ip: ins.ip,
      hostname: ins.hostname,
      lastSeenAt: ins.lastSeenAt,
      localRef: ins.localRef,
      lifecycle: {
        state: ins.state,
        delivery: ins.delivery,
        revision: ins.revision,
        startedAt: ins.startedAt,
        endedAt: ins.endedAt,
        endReason: ins.endReason,
      },
    })
  }
  const vouchers = s.vouchers.map((v) => {
    const set = voucherSet(c, v.id)
    if (!set) return v
    return {
      ...v,
      boundPortalId: set.boundPortalId ?? v.boundPortalId,
      firstUsedAt: set.firstUsedAt ?? v.firstUsedAt,
      exhaustedAt: set.exhaustedAt ?? v.exhaustedAt,
      startsAt: set.startsAt ?? v.startsAt,
      revision: set.revision ?? v.revision,
      usage: {
        timeUsedSeconds: v.usage.timeUsedSeconds + (voucherAdd(c, v.id)?.timeUsedSeconds ?? 0),
        bytesUsed: v.usage.bytesUsed + (voucherAdd(c, v.id)?.bytesUsed ?? 0),
      },
      limits: { ...v.limits, expiresAt: set.expiresAt ?? v.limits.expiresAt },
    }
  })
  return { ...s, grants, vouchers, ackedEventSeq: c.ackedEventSeq }
}

function isEmpty(c: PortalDbChanges) {
  return (
    c.grantInserts.length +
      c.grantUpdates.length +
      c.sessions.length +
      c.voucherUpdates.length +
      c.events.length ===
    0
  )
}

test.group('reconcile: basics', () => {
  test('nothing on either side', ({ assert }) => {
    const { dbChanges, desired } = reconcile(state(), report({ lastEventSeq: 5 }), false)
    assert.equal(dbChanges.ackedEventSeq, 5)
    assert.isTrue(isEmpty(dbChanges))
    assert.deepEqual(desired, {
      gatewayId: 7,
      full: true,
      serverNow: NOW,
      ackedEventSeq: 5,
      groups: [],
      grants: [],
      revertExternals: [],
      offlineVouchers: [],
    })
  })

  test('offline redemption off: the router is told to drop its list', ({ assert }) => {
    const { desired } = reconcile(
      state({ offline: { enabled: false, limit: 100 } }),
      report(),
      false
    )
    assert.isNull(desired.offlineVouchers)
  })

  test('a steady state reconciles to no changes', ({ assert }) => {
    const s = state({
      grants: [
        grant(1, { bytesUp: 10, bytesDown: 20, ip: '192.168.20.10', lastSeenAt: NOW - 1000 }),
      ],
      vouchers: [voucher(10, { usage: { timeUsedSeconds: 0, bytesUsed: 30 } })],
    })
    const { dbChanges, desired } = reconcile(
      s,
      report({ grants: [usage(1, { bytesUp: 10, bytesDown: 20 })] }),
      false
    )
    assert.isTrue(isEmpty(dbChanges), JSON.stringify(dbChanges))
    assert.deepEqual(desired.grants, [
      {
        grantId: 1,
        localRef: null,
        portalId: 1,
        groupKey: 'v:10',
        mac: MAC_A,
        expiresAt: null,
        revision: 1,
      },
    ])
    assert.deepEqual(desired.groups, [
      {
        groupKey: 'v:10',
        durationMode: 'wall_clock',
        expiresAt: NOW + HOUR,
        durationSeconds: 7200,
        quotaBytes: null,
        baseTimeUsedSeconds: 0,
        baseBytesUsed: 0,
        downKbps: null,
        upKbps: null,
        maxDevices: 1,
        revision: 1,
      },
    ])
  })
})

test.group('reconcile: delivery and usage', () => {
  test('the snapshot acknowledges a pending grant and opens its session', ({ assert }) => {
    const s = state({
      grants: [grant(1, {}, { state: 'pending_device', delivery: 'pending', startedAt: null })],
      vouchers: [voucher(10)],
    })
    const { dbChanges } = reconcile(s, report({ grants: [usage(1, { bytesDown: 500 })] }), false)
    assert.deepInclude(update(dbChanges, 1), {
      state: 'active',
      delivery: 'applied',
      startedAt: NOW,
      bytesDown: 500,
      ip: '192.168.20.10',
      lastSeenAt: NOW - 1000,
    })
    assert.lengthOf(opens(dbChanges), 1)
    assert.deepInclude(opens(dbChanges)[0], {
      grant: { id: 1 },
      startedAt: NOW,
      startBytesDown: 500,
    })
    assert.deepEqual(voucherAdd(dbChanges, 10), { bytesUsed: 500, timeUsedSeconds: 0 })
  })

  test('an older revision on the router is not an acknowledgement', ({ assert }) => {
    const s = state({
      grants: [grant(1, {}, { delivery: 'pending', revision: 2 })],
      vouchers: [voucher(10)],
    })
    const { dbChanges } = reconcile(s, report({ grants: [usage(1, { revision: 1 })] }), false)
    assert.isUndefined(update(dbChanges, 1)?.delivery)
  })

  test('counters merge with max and voucher totals grow by the deltas', ({ assert }) => {
    const s = state({
      grants: [
        grant(1, { bytesUp: 100, bytesDown: 1000, timeUsedSeconds: 50 }),
        grant(2, { mac: MAC_B, bytesUp: 5, bytesDown: 5 }),
      ],
      vouchers: [
        voucher(10, { usage: { timeUsedSeconds: 500, bytesUsed: 9000 } }, { maxDevices: 2 }),
      ],
    })
    const { dbChanges, desired } = reconcile(
      s,
      report({
        grants: [
          usage(1, { bytesUp: 90, bytesDown: 1500, activeSeconds: 60 }), // up went "backwards": kept
          usage(2, { mac: MAC_B, bytesUp: 5, bytesDown: 105 }),
        ],
      }),
      false
    )
    assert.deepInclude(update(dbChanges, 1), { bytesDown: 1500, timeUsedSeconds: 60 })
    assert.isUndefined(update(dbChanges, 1)?.bytesUp)
    assert.deepEqual(voucherAdd(dbChanges, 10), { bytesUsed: 500 + 100, timeUsedSeconds: 10 })
    assert.deepEqual(voucherSet(dbChanges, 10), {})
    // base = total − live grants (1: 100+1500 / 60 s, 2: 110 / 0 s)
    assert.deepInclude(desired.groups[0], {
      baseBytesUsed: 9600 - 1600 - 110,
      baseTimeUsedSeconds: 510 - 60,
    })
  })

  test('the router reports paused: the session closes', ({ assert }) => {
    const s = state({ grants: [grant(1)], vouchers: [voucher(10)] })
    const { dbChanges } = reconcile(s, report({ grants: [usage(1, { state: 'paused' })] }), false)
    assert.equal(update(dbChanges, 1)?.state, 'paused')
    assert.deepInclude(closes(dbChanges)[0], {
      grant: { id: 1 },
      endReason: 'idle',
      endedAt: NOW,
    })
  })

  test('a grant the router lost is sent again', ({ assert }) => {
    const s = state({ grants: [grant(1, { bytesDown: 7 })], vouchers: [voucher(10)] })
    const { dbChanges, desired } = reconcile(s, report(), false)
    assert.deepInclude(update(dbChanges, 1), { delivery: 'pending', state: 'pending_device' })
    assert.deepInclude(closes(dbChanges)[0], { endReason: 'lost', bytesDown: 7 })
    assert.equal(dbChanges.events[0].type, 'grant_lost')
    assert.lengthOf(desired.grants, 1)
  })

  test('a lost grant that is used up is ended, not resurrected', ({ assert }) => {
    const s = state({
      grants: [grant(1)],
      vouchers: [voucher(10, {}, { expiresAt: NOW - 1 })],
    })
    const { dbChanges, desired } = reconcile(s, report({ truncated: true }), false)
    assert.deepInclude(update(dbChanges, 1), {
      state: 'ended',
      endReason: 'expired',
      delivery: 'pending',
    })
    assert.lengthOf(desired.grants, 0)
    assert.includeMembers(
      dbChanges.events.map((e) => e.type),
      ['journal_truncated', 'grant_lost']
    )
  })

  test('an ended grant gone from the router: removal acknowledged', ({ assert }) => {
    const s = state({
      grants: [
        grant(
          1,
          {},
          {
            state: 'ended',
            delivery: 'pending',
            revision: 2,
            endedAt: NOW - 1,
            endReason: 'revoked',
          }
        ),
      ],
      vouchers: [voucher(10)],
    })
    const { dbChanges } = reconcile(s, report(), false)
    assert.deepEqual(update(dbChanges, 1), { delivery: 'applied' })
  })

  test('a grant the server ended but the router still holds is left out of the set', ({
    assert,
  }) => {
    const s = state({
      grants: [
        grant(
          1,
          {},
          {
            state: 'ended',
            delivery: 'pending',
            revision: 2,
            endedAt: NOW - 1,
            endReason: 'revoked',
          }
        ),
      ],
      vouchers: [voucher(10)],
    })
    const { dbChanges, desired } = reconcile(
      s,
      report({ grants: [usage(1, { bytesDown: 3 })] }),
      false
    )
    assert.deepEqual(update(dbChanges, 1), {
      bytesDown: 3,
      ip: '192.168.20.10',
      lastSeenAt: NOW - 1000,
    })
    assert.lengthOf(desired.grants, 0)
  })

  test('grants of a disabled portal are not sent and not lost', ({ assert }) => {
    const s = state({
      portals: [{ id: 1, enabled: false }],
      grants: [grant(1)],
      vouchers: [voucher(10)],
    })
    const { dbChanges, desired } = reconcile(s, report(), false)
    assert.isTrue(isEmpty(dbChanges))
    assert.lengthOf(desired.grants, 0)
  })
})

test.group('reconcile: journal', () => {
  test('events at or below the acked seq are skipped; the rest run in seq order', ({ assert }) => {
    const s = state({ ackedEventSeq: 10, grants: [grant(1)], vouchers: [voucher(10)] })
    const { dbChanges } = reconcile(
      s,
      report({
        lastEventSeq: 13,
        events: [
          { seq: 13, at: NOW - 100, type: 'session_resumed', portalId: 1, mac: MAC_A, grantId: 1 },
          {
            seq: 9,
            at: NOW - 900,
            type: 'grant_ended',
            portalId: 1,
            mac: MAC_A,
            grantId: 1,
            reason: 'router_deauth',
          },
          { seq: 12, at: NOW - 200, type: 'session_paused', portalId: 1, mac: MAC_A, grantId: 1 },
        ],
        grants: [usage(1)],
      }),
      false
    )
    assert.equal(dbChanges.ackedEventSeq, 13)
    // paused then resumed: one close, one open, still active
    assert.isUndefined(update(dbChanges, 1)?.state)
    assert.deepInclude(closes(dbChanges)[0], { endedAt: NOW - 200, endReason: 'idle' })
    assert.deepInclude(opens(dbChanges)[0], { startedAt: NOW - 100 })
  })

  test('grant_ended is a fact: reason, counters, no push', ({ assert }) => {
    const s = state({
      grants: [grant(1, { bytesDown: 100 })],
      vouchers: [voucher(10, { usage: { timeUsedSeconds: 0, bytesUsed: 100 } })],
    })
    const { dbChanges, desired } = reconcile(
      s,
      report({
        lastEventSeq: 1,
        events: [
          {
            seq: 1,
            at: NOW - 5000,
            type: 'grant_ended',
            portalId: 1,
            mac: MAC_A,
            grantId: 1,
            reason: 'router_deauth',
            bytesDown: 900,
          },
        ],
      }),
      false
    )
    assert.deepInclude(update(dbChanges, 1), {
      state: 'ended',
      endReason: 'router_deauth',
      endedAt: NOW - 5000,
      bytesDown: 900,
    })
    assert.deepInclude(closes(dbChanges)[0], { endReason: 'router_deauth', bytesDown: 900 })
    assert.equal(voucherAdd(dbChanges, 10)?.bytesUsed, 800)
    // router_deauth ends the grant, not the voucher
    assert.isUndefined(voucherSet(dbChanges, 10)?.exhaustedAt)
    assert.lengthOf(desired.grants, 0)
    assert.lengthOf(desired.offlineVouchers!, 1)
  })

  test('`removed` ends nothing: the server asked for it', ({ assert }) => {
    const s = state({
      grants: [grant(1, {}, { state: 'queued', delivery: 'pending', revision: 2 })],
      vouchers: [voucher(10)],
    })
    const { dbChanges } = reconcile(
      s,
      report({
        lastEventSeq: 1,
        events: [
          {
            seq: 1,
            at: NOW,
            type: 'grant_ended',
            portalId: 1,
            mac: MAC_A,
            grantId: 1,
            reason: 'removed',
          },
        ],
      }),
      false
    )
    assert.notEqual(update(dbChanges, 1)?.state, 'ended')
  })

  test('an event for an unknown grant is logged', ({ assert }) => {
    const { dbChanges } = reconcile(
      state(),
      report({
        lastEventSeq: 1,
        events: [{ seq: 1, at: NOW, type: 'grant_active', portalId: 1, mac: MAC_A, grantId: 99 }],
      }),
      false
    )
    assert.equal(dbChanges.events[0].type, 'unknown_grant')
    assert.deepInclude(dbChanges.events[0].detail, { grantId: 99, event: 'grant_active' })
  })

  test('a router journal that restarted is replayed from its start', ({ assert }) => {
    const s = state({ ackedEventSeq: 500, grants: [grant(1)], vouchers: [voucher(10)] })
    const { dbChanges } = reconcile(
      s,
      report({
        lastEventSeq: 2,
        events: [
          {
            seq: 1,
            at: NOW,
            type: 'grant_ended',
            portalId: 1,
            mac: MAC_A,
            grantId: 1,
            reason: 'logout',
          },
        ],
      }),
      false
    )
    assert.equal(dbChanges.ackedEventSeq, 2)
    assert.equal(update(dbChanges, 1)?.endReason, 'logout')
    assert.equal(dbChanges.events[0].type, 'journal_reset')
  })
})

test.group('reconcile: outside authorizations (decision 25)', () => {
  for (const authoritative of [false, true]) {
    test(`are always reverted and logged (authoritative ${authoritative})`, ({ assert }) => {
      const { dbChanges, desired } = reconcile(
        state(),
        report({
          lastEventSeq: 2,
          events: [
            {
              seq: 1,
              at: NOW - 10,
              type: 'external_auth',
              portalId: 1,
              mac: '02-00-00-00-00-EE',
              ip: '192.168.20.99',
            },
            { seq: 2, at: NOW - 5, type: 'external_deauth', portalId: 1, mac: MAC_B },
          ],
          externals: [
            {
              portalId: 1,
              mac: '02:00:00:00:00:ee',
              ip: '192.168.20.99',
              since: NOW - 10,
              bytesUp: 1,
              bytesDown: 2,
            },
            {
              portalId: 1,
              mac: '02:00:00:00:00:EE',
              ip: null,
              since: null,
              bytesUp: 0,
              bytesDown: 0,
            },
            { portalId: null, mac: 'garbage', ip: null, since: null, bytesUp: 0, bytesDown: 0 },
          ],
        }),
        authoritative
      )
      assert.deepEqual(desired.revertExternals, [{ portalId: 1, mac: '02:00:00:00:00:ee' }])
      assert.deepEqual(
        dbChanges.events.map((e) => [e.type, e.mac]),
        [
          ['external_auth_reverted', '02:00:00:00:00:ee'],
          ['external_deauth', MAC_B],
        ]
      )
      assert.deepInclude(dbChanges.events[0].detail, { authoritative, ip: '192.168.20.99' })
      assert.lengthOf(dbChanges.grantInserts, 0)
    })
  }
})

test.group('reconcile: server accounting', () => {
  test('a wall clock past its deadline ends and is taken off the router', ({ assert }) => {
    const s = state({ grants: [grant(1)], vouchers: [voucher(10, {}, { expiresAt: NOW - 1000 })] })
    const { dbChanges, desired } = reconcile(s, report({ grants: [usage(1)] }), false)
    assert.deepInclude(update(dbChanges, 1), {
      state: 'ended',
      endReason: 'expired',
      delivery: 'pending',
      revision: 2,
    })
    assert.equal(voucherSet(dbChanges, 10)?.exhaustedAt, NOW)
    assert.lengthOf(desired.grants, 0)
  })

  test('a data voucher crossing its quota ends every device', ({ assert }) => {
    const s = state({
      grants: [grant(1, { bytesDown: 400 }), grant(2, { mac: MAC_B, bytesDown: 400 })],
      vouchers: [
        voucher(
          10,
          { usage: { timeUsedSeconds: 0, bytesUsed: 800 } },
          { durationSeconds: null, expiresAt: null, quotaBytes: 1000, maxDevices: 2 }
        ),
      ],
    })
    const { dbChanges } = reconcile(
      s,
      report({ grants: [usage(1, { bytesDown: 500 }), usage(2, { mac: MAC_B, bytesDown: 550 })] }),
      false
    )
    assert.equal(update(dbChanges, 1)?.endReason, 'quota')
    assert.equal(update(dbChanges, 2)?.endReason, 'quota')
    assert.deepInclude(voucherSet(dbChanges, 10), { exhaustedAt: NOW })
    assert.equal(voucherAdd(dbChanges, 10)?.bytesUsed, 250)
  })

  test('active time: the charged budget ends it', ({ assert }) => {
    const s = state({
      grants: [grant(1, { timeUsedSeconds: 590 })],
      vouchers: [
        voucher(
          10,
          { usage: { timeUsedSeconds: 590, bytesUsed: 0 } },
          { durationMode: 'active_time', durationSeconds: 600, expiresAt: null }
        ),
      ],
    })
    const { dbChanges } = reconcile(
      s,
      report({ grants: [usage(1, { activeSeconds: 600 })] }),
      false
    )
    assert.equal(update(dbChanges, 1)?.endReason, 'expired')
  })

  test('a revoked voucher (or batch) ends its grants', ({ assert }) => {
    for (const patch of [{ revokedAt: NOW - 1 }, { batchRevokedAt: NOW - 1 }]) {
      const s = state({ grants: [grant(1)], vouchers: [voucher(10, patch)] })
      const { dbChanges } = reconcile(s, report({ grants: [usage(1)] }), false)
      assert.equal(update(dbChanges, 1)?.endReason, 'revoked')
      assert.isUndefined(voucherSet(dbChanges, 10)?.exhaustedAt)
    }
  })

  test('non-voucher groups: limits from the group, deadline from the grant', ({ assert }) => {
    const s = state({
      grants: [
        grant(1, { groupKey: 'u:4', source: 'user', voucherId: null, expiresAt: NOW - 1 }),
        grant(2, { mac: MAC_B, groupKey: 'g:2', source: 'api', voucherId: null }),
      ],
      groups: [
        {
          groupKey: 'u:4',
          revision: 1,
          limits: {
            durationMode: 'wall_clock',
            expiresAt: null,
            durationSeconds: null,
            quotaBytes: null,
            downKbps: null,
            upKbps: null,
            maxDevices: 2,
          },
        },
        {
          groupKey: 'g:2',
          revision: 5,
          limits: {
            durationMode: 'wall_clock',
            expiresAt: NOW + HOUR,
            durationSeconds: null,
            quotaBytes: 10_000,
            downKbps: 2000,
            upKbps: 500,
            maxDevices: 1,
          },
        },
      ],
    })
    const { dbChanges, desired } = reconcile(
      s,
      report({ grants: [usage(1), usage(2, { mac: MAC_B, bytesDown: 100 })] }),
      false
    )
    assert.equal(update(dbChanges, 1)?.endReason, 'expired')
    assert.isUndefined(update(dbChanges, 2)?.state)
    assert.lengthOf(desired.grants, 1)
    assert.deepInclude(desired.groups[0], {
      groupKey: 'g:2',
      revision: 5,
      downKbps: 2000,
      baseBytesUsed: 0,
    })
  })

  test('a grant without a known group is not sent', ({ assert }) => {
    const s = state({ grants: [grant(1, { groupKey: 'g:1', voucherId: null, source: 'admin' })] })
    const { desired } = reconcile(s, report({ grants: [usage(1)] }), false)
    assert.lengthOf(desired.grants, 0)
  })
})

test.group('reconcile: stacking (decision 23)', () => {
  test('when the time voucher ends, the queued data bucket is promoted', ({ assert }) => {
    const s = state({
      grants: [
        grant(1),
        grant(2, { groupKey: 'v:11', voucherId: 11 }, { state: 'queued', startedAt: null }),
      ],
      vouchers: [
        voucher(10),
        voucher(
          11,
          { firstUsedAt: NOW - HOUR, startsAt: null },
          { durationSeconds: null, expiresAt: null, quotaBytes: 1e9 }
        ),
      ],
    })
    const { dbChanges, desired } = reconcile(
      s,
      report({
        lastEventSeq: 1,
        events: [
          {
            seq: 1,
            at: NOW - 10,
            type: 'grant_ended',
            portalId: 1,
            mac: MAC_A,
            grantId: 1,
            reason: 'expired',
          },
        ],
      }),
      false
    )
    assert.equal(update(dbChanges, 1)?.state, 'ended')
    assert.deepInclude(update(dbChanges, 2), {
      state: 'pending_device',
      delivery: 'pending',
      revision: 2,
    })
    assert.deepEqual(
      desired.grants.map((g) => g.grantId),
      [2]
    )
  })

  test('promoting a first-use wall clock starts it', ({ assert }) => {
    const s = state({
      grants: [grant(2, { groupKey: 'v:11', voucherId: 11 }, { state: 'queued', startedAt: null })],
      vouchers: [voucher(11, { startsAt: null }, { expiresAt: null, durationSeconds: 1800 })],
    })
    const { dbChanges, desired } = reconcile(s, report(), false)
    assert.deepEqual(voucherSet(dbChanges, 11), {
      startsAt: NOW,
      expiresAt: NOW + 30 * MIN,
      revision: 2,
    })
    assert.deepInclude(desired.groups[0], {
      groupKey: 'v:11',
      expiresAt: NOW + 30 * MIN,
      revision: 2,
    })
  })

  test('promoting a queued API grant starts its waiting wall clock', ({ assert }) => {
    const g = grant(
      5,
      { groupKey: 'g:5', source: 'api', voucherId: null },
      {
        state: 'queued',
        startedAt: null,
      }
    )
    const s = state({
      grants: [g],
      groups: [
        {
          groupKey: 'g:5',
          revision: 1,
          limits: {
            durationMode: 'wall_clock',
            expiresAt: null,
            durationSeconds: 900,
            quotaBytes: null,
            downKbps: null,
            upKbps: null,
            maxDevices: 1,
          },
        },
      ],
    })
    const { dbChanges, desired } = reconcile(s, report(), false)
    assert.deepEqual(dbChanges.grantClocks, [{ id: 5, expiresAt: NOW + 15 * MIN }])
    assert.deepInclude(update(dbChanges, 5), { state: 'pending_device' })
    assert.deepInclude(desired.groups[0], { groupKey: 'g:5', expiresAt: NOW + 15 * MIN })

    // An active-time API grant has no clock to start.
    const active = state({
      grants: [g],
      groups: [{ ...s.groups[0], limits: { ...s.groups[0].limits, durationMode: 'active_time' } }],
    })
    assert.deepEqual(reconcile(active, report(), false).dbChanges.grantClocks, [])
  })

  test('two live entitlements for one device: the later in order goes back to the queue', ({
    assert,
  }) => {
    const s = state({
      grants: [grant(1, { groupKey: 'v:11', voucherId: 11 }), grant(2, {})],
      vouchers: [
        voucher(10),
        voucher(11, {}, { durationSeconds: null, expiresAt: null, quotaBytes: 1e9 }),
      ],
    })
    const { dbChanges, desired } = reconcile(s, report({ grants: [usage(1), usage(2)] }), false)
    assert.deepInclude(update(dbChanges, 1), { state: 'queued', delivery: 'pending' })
    assert.deepEqual(
      desired.grants.map((g) => g.grantId),
      [2]
    )
  })

  test('the queue is per device and per portal', ({ assert }) => {
    const s = state({
      portals: [
        { id: 1, enabled: true },
        { id: 2, enabled: true },
      ],
      grants: [
        grant(1),
        grant(
          2,
          { portalId: 2, groupKey: 'v:11', voucherId: 11 },
          { state: 'queued', startedAt: null }
        ),
      ],
      vouchers: [
        voucher(10),
        voucher(
          11,
          { boundPortalId: 2, batchPortalId: 2 },
          { durationSeconds: null, expiresAt: null, quotaBytes: 5 }
        ),
      ],
    })
    const { dbChanges } = reconcile(s, report({ grants: [usage(1)] }), false)
    // Nothing live for MAC_A on portal 2: its queued grant is promoted.
    assert.equal(update(dbChanges, 2)?.state, 'pending_device')
  })
})

test.group('reconcile: offline redemption (decision 20)', () => {
  const redeemed = (patch: Record<string, unknown> = {}) =>
    ({
      seq: 1,
      at: NOW - 60_000,
      type: 'offline_redeemed',
      portalId: 1,
      mac: MAC_B,
      voucherId: 12,
      localRef: 'o7-1',
      ip: '192.168.20.11',
      hostname: 'phone',
      placement: 'current',
      startsAt: NOW - 60_000,
      expiresAt: NOW - 60_000 + 7200_000,
      ...patch,
    }) as const

  test('becomes a grant row, binds and starts the voucher, and is sent back', ({ assert }) => {
    const s = state({
      vouchers: [
        voucher(
          12,
          { firstUsedAt: null, boundPortalId: null, startsAt: null },
          { expiresAt: null }
        ),
      ],
    })
    const { dbChanges, desired } = reconcile(
      s,
      report({
        lastEventSeq: 2,
        events: [
          redeemed(),
          {
            seq: 2,
            at: NOW - 59_000,
            type: 'grant_active',
            portalId: 1,
            mac: MAC_B,
            grantId: null,
            localRef: 'o7-1',
            ip: '192.168.20.11',
          },
        ],
        grants: [
          usage(null, {
            localRef: 'o7-1',
            mac: MAC_B,
            bytesDown: 1000,
            revision: 1,
            ip: '192.168.20.11',
          }),
        ],
      }),
      false
    )
    assert.lengthOf(dbChanges.grantInserts, 1)
    assert.deepInclude(dbChanges.grantInserts[0], {
      localRef: 'o7-1',
      portalId: 1,
      mac: MAC_B,
      source: 'voucher',
      groupKey: 'v:12',
      voucherId: 12,
      state: 'active',
      delivery: 'applied',
      startedAt: NOW - 59_000,
      bytesDown: 1000,
      hostname: 'phone',
    })
    assert.deepEqual(voucherSet(dbChanges, 12), {
      boundPortalId: 1,
      firstUsedAt: NOW - 60_000,
      startsAt: NOW - 60_000,
      expiresAt: NOW - 60_000 + 7200_000,
      revision: 2,
    })
    assert.equal(voucherAdd(dbChanges, 12)?.bytesUsed, 1000)
    assert.deepInclude(opens(dbChanges)[0], { grant: { localRef: 'o7-1' } })
    assert.deepEqual(desired.grants, [
      {
        grantId: null,
        localRef: 'o7-1',
        portalId: 1,
        groupKey: 'v:12',
        mac: MAC_B,
        expiresAt: null,
        revision: 1,
      },
    ])
    assert.equal(dbChanges.events[0].type, 'offline_redeemed')
  })

  test('a move offline ends the old device with `moved`', ({ assert }) => {
    const s = state({
      grants: [grant(1, { groupKey: 'v:12', voucherId: 12 })],
      vouchers: [voucher(12)],
    })
    const { dbChanges } = reconcile(
      s,
      report({
        lastEventSeq: 2,
        events: [
          redeemed({ startsAt: null, expiresAt: null }),
          {
            seq: 2,
            at: NOW - 59_000,
            type: 'grant_ended',
            portalId: 1,
            mac: MAC_A,
            grantId: 1,
            reason: 'moved',
          },
        ],
      }),
      false
    )
    assert.equal(update(dbChanges, 1)?.endReason, 'moved')
    assert.lengthOf(dbChanges.grantInserts, 1)
    // The voucher's clock was already running: untouched.
    assert.isUndefined(voucherSet(dbChanges, 12)?.expiresAt)
  })

  test('a swap offline queues the data bucket', ({ assert }) => {
    const s = state({
      grants: [grant(1, { mac: MAC_B, groupKey: 'v:11', voucherId: 11 })],
      vouchers: [
        voucher(11, {}, { durationSeconds: null, expiresAt: null, quotaBytes: 1e9 }),
        voucher(12, { firstUsedAt: null, startsAt: null }, { expiresAt: null }),
      ],
    })
    const { dbChanges, desired } = reconcile(
      s,
      report({
        lastEventSeq: 1,
        events: [redeemed({ placement: 'swap', demotedGrantId: 1 })],
        grants: [usage(null, { localRef: 'o7-1', mac: MAC_B, state: 'pending_device' })],
      }),
      false
    )
    assert.equal(update(dbChanges, 1)?.state, 'queued')
    assert.deepEqual(
      desired.grants.map((g) => g.localRef),
      ['o7-1']
    )
  })

  test('already materialized: not inserted twice', ({ assert }) => {
    const s = state({
      grants: [grant(40, { mac: MAC_B, groupKey: 'v:12', voucherId: 12, localRef: 'o7-1' })],
      vouchers: [voucher(12)],
    })
    const { dbChanges } = reconcile(
      s,
      report({
        lastEventSeq: 1,
        events: [redeemed()],
        grants: [usage(40, { mac: MAC_B, localRef: 'o7-1' })],
      }),
      false
    )
    assert.lengthOf(dbChanges.grantInserts, 0)
  })

  test('revoked before the router redeemed it: recorded, then ended', ({ assert }) => {
    const s = state({ vouchers: [voucher(12, { revokedAt: NOW - HOUR, firstUsedAt: null })] })
    // The router holds it (it redeemed it): the end must be delivered.
    const { dbChanges, desired } = reconcile(
      s,
      report({
        lastEventSeq: 1,
        events: [redeemed()],
        grants: [usage(null, { localRef: 'o7-1', mac: MAC_B })],
      }),
      false
    )
    assert.deepInclude(dbChanges.grantInserts[0], {
      state: 'ended',
      endReason: 'revoked',
      delivery: 'pending',
    })
    assert.lengthOf(desired.grants, 0)
  })

  test('refused: unknown voucher, other portal, bad MAC, bad ref', ({ assert }) => {
    const cases: Array<[Record<string, unknown>, string, ServerVoucher[]]> = [
      [{ voucherId: 99 }, 'unknown_voucher', [voucher(12)]],
      [{ portalId: 5 }, 'unknown_portal', [voucher(12)]],
      [{}, 'wrong_portal', [voucher(12, { boundPortalId: 2, batchPortalId: 2 })]],
      [{ mac: 'ff:ff:ff:ff:ff:ff' }, 'invalid_mac', [voucher(12)]],
      [{ localRef: 'bad ref' }, 'invalid_local_ref', [voucher(12)]],
    ]
    for (const [patch, reason, vouchers] of cases) {
      const { dbChanges } = reconcile(
        state({
          portals: [
            { id: 1, enabled: true },
            { id: 2, enabled: true },
          ],
          vouchers,
        }),
        report({ lastEventSeq: 1, events: [redeemed(patch)] }),
        false
      )
      assert.lengthOf(dbChanges.grantInserts, 0, reason)
      assert.equal(dbChanges.events[0].type, 'offline_redeem_rejected', reason)
      assert.equal(dbChanges.events[0].detail.reason, reason)
    }
  })
})

test.group('reconcile: offline voucher list', () => {
  test('only vouchers no other gateway can redeem, active first then newest, capped', ({
    assert,
  }) => {
    const s = state({
      portals: [
        { id: 1, enabled: true },
        { id: 2, enabled: false },
      ],
      vouchers: [
        voucher(
          1,
          { firstUsedAt: null, boundPortalId: null, createdAt: NOW - 3 * HOUR },
          { expiresAt: null }
        ), // unused, batch portal 1
        voucher(
          2,
          { firstUsedAt: null, boundPortalId: null, batchPortalId: null },
          { expiresAt: null }
        ), // any portal: not offered
        voucher(
          3,
          { firstUsedAt: null, boundPortalId: null, batchPortalId: 9 },
          { expiresAt: null }
        ), // another gateway's portal
        voucher(4, { revokedAt: NOW - 1 }),
        voucher(5, {}, { expiresAt: NOW - 1 }), // expired
        voucher(6, { verifier: null }), // code unrecoverable
        voucher(7, { createdAt: NOW - 4 * HOUR }), // active (in use), older batch
        voucher(
          8,
          { firstUsedAt: null, boundPortalId: null, batchPortalId: 2, createdAt: NOW - HOUR },
          { expiresAt: null }
        ), // unused, disabled portal of this gateway
      ],
    })
    const { desired } = reconcile(s, report(), false)
    assert.deepEqual(
      desired.offlineVouchers!.map((v) => v.voucherId),
      [7, 8, 1]
    )
    assert.deepInclude(desired.offlineVouchers![0], {
      verifier: VERIFIER,
      portalIds: [1],
      groupKey: 'v:7',
      startMode: 'first_use',
      expiresAt: NOW + HOUR,
      revision: 1,
    })
    const capped = reconcile({ ...s, offline: { enabled: true, limit: 2 } }, report(), false)
    assert.deepEqual(
      capped.desired.offlineVouchers!.map((v) => v.voucherId),
      [7, 8]
    )
  })
})

test.group('reconcile: idempotence', () => {
  test('applying the changes and reconciling the same report again changes nothing', ({
    assert,
  }) => {
    const s = state({
      grants: [
        grant(
          1,
          { bytesDown: 100 },
          { state: 'pending_device', delivery: 'pending', startedAt: null }
        ),
        grant(
          2,
          { mac: MAC_B, groupKey: 'v:11', voucherId: 11 },
          { state: 'queued', startedAt: null }
        ),
        grant(3, { mac: MAC_B }, {}),
      ],
      vouchers: [
        voucher(10, { usage: { timeUsedSeconds: 0, bytesUsed: 100 } }, { maxDevices: 2 }),
        voucher(11, { startsAt: null }, { expiresAt: null }),
        voucher(
          12,
          { firstUsedAt: null, boundPortalId: null, startsAt: null },
          { expiresAt: null }
        ),
      ],
    })
    const r = report({
      lastEventSeq: 3,
      events: [
        {
          seq: 1,
          at: NOW - 9000,
          type: 'grant_ended',
          portalId: 1,
          mac: MAC_B,
          grantId: 3,
          reason: 'logout',
        },
        {
          seq: 2,
          at: NOW - 8000,
          type: 'offline_redeemed',
          portalId: 1,
          mac: '02:00:00:00:00:0c',
          voucherId: 12,
          localRef: 'o1',
          placement: 'current',
        },
        { seq: 3, at: NOW - 7000, type: 'external_auth', portalId: 1, mac: '02:00:00:00:00:0d' },
      ],
      grants: [
        usage(1, { bytesDown: 300 }),
        usage(null, { localRef: 'o1', mac: '02:00:00:00:00:0c', bytesDown: 50 }),
      ],
      externals: [
        { portalId: 1, mac: '02:00:00:00:00:0d', ip: null, since: null, bytesUp: 0, bytesDown: 0 },
      ],
    })
    const first = reconcile(s, r, true)
    assert.isFalse(isEmpty(first.dbChanges))
    const after = applyChanges(s, first.dbChanges)
    // The router saw the answer: it now reports ids and revisions.
    const idOf = new Map(after.grants.filter((g) => g.localRef).map((g) => [g.localRef!, g.id]))
    const r2 = report({
      lastEventSeq: 3,
      events: r.events,
      grants: [
        usage(1, { bytesDown: 300 }),
        usage(idOf.get('o1')!, { localRef: 'o1', mac: '02:00:00:00:00:0c', bytesDown: 50 }),
        usage(2, {
          mac: MAC_B,
          state: 'pending_device',
          revision: after.grants.find((g) => g.id === 2)!.lifecycle.revision,
          lastSeenAt: null,
          ip: null,
        }),
      ],
    })
    const second = reconcile(after, r2, true)
    const changedGrants = second.dbChanges.grantUpdates.filter((u) => u.id !== 2)
    assert.deepEqual(changedGrants, [])
    assert.lengthOf(second.dbChanges.grantInserts, 0)
    assert.lengthOf(second.dbChanges.events, 0)
    // Grant 2's promotion is acknowledged by the second snapshot.
    assert.deepEqual(second.dbChanges.grantUpdates.find((u) => u.id === 2)?.set, {
      delivery: 'applied',
    })
    const third = reconcile(applyChanges(after, second.dbChanges), r2, true)
    assert.isTrue(isEmpty(third.dbChanges), JSON.stringify(third.dbChanges))
  })
})
