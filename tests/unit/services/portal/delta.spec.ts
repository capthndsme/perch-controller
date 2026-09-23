import { offlineVoucherList, portalDelta } from '#services/portal/delta'
import {
  type RouterPortalReport,
  type ServerGrant,
  type ServerPortalState,
  type ServerVoucher,
  reconcile,
} from '#services/portal/reconcile'
import { shapingEntries } from '#services/portal_shaping'
import { test } from '@japa/runner'

const NOW = 1_790_000_000_000
const HOUR = 3_600_000
const MAC_A = '02:00:00:00:00:0a'
const MAC_B = '02:00:00:00:00:0b'

function voucher(id: number, patch: Partial<ServerVoucher> = {}): ServerVoucher {
  return {
    id,
    batchPortalId: 1,
    boundPortalId: 1,
    firstUsedAt: NOW - HOUR,
    revokedAt: null,
    batchRevokedAt: null,
    exhaustedAt: null,
    redeemBy: null,
    usage: { timeUsedSeconds: 0, bytesUsed: 9000 },
    revision: 3,
    createdAt: NOW - 2 * HOUR,
    verifier: 'a'.repeat(64),
    startsAt: NOW - HOUR,
    limits: {
      durationSeconds: 7200,
      durationMode: 'wall_clock',
      startMode: 'first_use',
      quotaBytes: 1_000_000,
      downKbps: 2048,
      upKbps: 512,
      maxDevices: 2,
      expiresAt: NOW + HOUR,
    },
    ...patch,
  }
}

function grant(id: number, patch: Partial<ServerGrant> = {}): ServerGrant {
  return {
    id,
    portalId: 1,
    mac: MAC_A,
    groupKey: 'v:10',
    source: 'voucher',
    voucherId: 10,
    expiresAt: null,
    createdAt: NOW - HOUR,
    bytesUp: 1000,
    bytesDown: 3000,
    timeUsedSeconds: 0,
    ip: null,
    hostname: null,
    lastSeenAt: null,
    localRef: null,
    lifecycle: {
      state: 'active',
      delivery: 'applied',
      revision: 2,
      startedAt: NOW - HOUR,
      endedAt: null,
      endReason: null,
    },
    ...patch,
  }
}

function server(patch: Partial<ServerPortalState> = {}): ServerPortalState {
  return {
    gatewayId: 7,
    now: NOW,
    ackedEventSeq: 4,
    portals: [{ id: 1, enabled: true }],
    grants: [
      grant(1),
      grant(2, { mac: MAC_B, bytesUp: 500, bytesDown: 500 }),
      grant(3, {
        mac: '02:00:00:00:00:0c',
        lifecycle: { ...grant(3).lifecycle, state: 'queued' },
      }),
    ],
    groups: [],
    vouchers: [voucher(10)],
    offline: { enabled: true, limit: 100 },
    ...patch,
  }
}

test.group('portal delta', () => {
  test('carries the live grants asked for and their group with base usage', ({ assert }) => {
    const delta = portalDelta(server(), [2, 3, 99])
    assert.deepEqual(
      delta.grants.map((g) => g.grantId),
      [2]
    )
    assert.lengthOf(delta.groups, 1)
    const [group] = delta.groups
    // base = voucher total − both live grants on this router (4000 + 1000).
    assert.equal(group.baseBytesUsed, 9000 - 5000)
    assert.equal(group.revision, 3)
    assert.equal(group.expiresAt, NOW + HOUR)
  })

  test('agrees with the full set reconcile sends', ({ assert }) => {
    const state = server({
      grants: [grant(1), grant(2, { mac: MAC_B, bytesUp: 500, bytesDown: 500 })],
    })
    const report: RouterPortalReport = {
      lastEventSeq: 4,
      truncated: false,
      events: [],
      grants: state.grants
        .filter((g) => g.lifecycle.state !== 'queued')
        .map((g) => ({
          grantId: g.id,
          localRef: null,
          portalId: 1,
          mac: g.mac,
          ip: null,
          bytesUp: g.bytesUp,
          bytesDown: g.bytesDown,
          activeSeconds: 0,
          state: 'active' as const,
          lastSeenAt: NOW,
          revision: g.lifecycle.revision,
        })),
      externals: [],
    }
    const { desired } = reconcile(state, report, false)
    const delta = portalDelta(state, [1, 2])
    assert.deepEqual(delta.groups, desired.groups)
    assert.deepEqual(delta.grants, desired.grants)
    assert.deepEqual(offlineVoucherList(state), desired.offlineVouchers)
  })

  test('a disabled portal or offline redemption sends nothing', ({ assert }) => {
    assert.deepEqual(portalDelta(server({ portals: [{ id: 1, enabled: false }] }), [1]), {
      groups: [],
      grants: [],
    })
    assert.isNull(offlineVoucherList(server({ offline: { enabled: false, limit: 100 } })))
  })

  test('shaping entries: caps per device, quota only for one-device groups', ({ assert }) => {
    const delta = portalDelta(server(), [1])
    const shared = shapingEntries(delta.grants, delta.groups)
    assert.deepEqual(shared, [
      {
        sourceRef: 'portal-grant:1',
        portalId: 1,
        mac: MAC_A,
        downKbps: 2048,
        upKbps: 512,
        quotaBytes: null,
        expiresAt: NOW + HOUR,
      },
    ])
    const single = portalDelta(
      server({ vouchers: [voucher(10, { limits: { ...voucher(10).limits, maxDevices: 1 } })] }),
      [1]
    )
    const [entry] = shapingEntries(
      single.grants,
      single.groups,
      new Map([['portal-grant:1', 4000]])
    )
    assert.equal(entry.quotaBytes, 1_000_000 - single.groups[0].baseBytesUsed - 4000)
  })
})
