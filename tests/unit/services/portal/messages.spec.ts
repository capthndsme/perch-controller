import {
  deriveGatewayKeys,
  gatewayKeysFrom,
  signEnvelope,
  signGrant,
  signGroup,
  signOfflineVoucher,
  signatureMatches,
} from '#services/portal/crypto'
import {
  bindInsertedGrantIds,
  buildAuthorizeParams,
  buildDeauthorizeParams,
  buildVouchersParams,
} from '#services/portal/messages'
import type { DesiredPortalState } from '#services/portal/reconcile'
import { test } from '@japa/runner'

const APP_KEY = 'perch-test-app-key-0123456789abcdef'
const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA'

function desired(patch: Partial<DesiredPortalState> = {}): DesiredPortalState {
  return {
    gatewayId: 7,
    full: true,
    serverNow: 1_790_000_000_000,
    ackedEventSeq: 12,
    groups: [
      {
        groupKey: 'v:17',
        durationMode: 'wall_clock',
        expiresAt: 1_790_000_600_000,
        durationSeconds: 600,
        quotaBytes: null,
        baseTimeUsedSeconds: 0,
        baseBytesUsed: 0,
        downKbps: null,
        upKbps: null,
        maxDevices: 1,
        revision: 2,
      },
    ],
    grants: [
      {
        grantId: 42,
        localRef: null,
        portalId: 3,
        groupKey: 'v:17',
        mac: '02:00:00:aa:bb:cc',
        expiresAt: null,
        revision: 1,
      },
      {
        grantId: null,
        localRef: 'o1',
        portalId: 3,
        groupKey: 'v:17',
        mac: '02:00:00:aa:bb:cd',
        expiresAt: null,
        revision: 1,
      },
    ],
    revertExternals: [{ portalId: 3, mac: '02:00:00:00:00:09' }],
    offlineVouchers: [
      {
        voucherId: 18,
        verifier: 'b'.repeat(64),
        portalIds: [3],
        groupKey: 'v:18',
        durationMode: 'active_time',
        startMode: 'first_use',
        durationSeconds: 3600,
        quotaBytes: null,
        downKbps: null,
        upKbps: null,
        maxDevices: 1,
        redeemBy: null,
        expiresAt: null,
        timeUsedSeconds: 0,
        bytesUsed: 0,
        revision: 1,
      },
    ],
    ...patch,
  }
}

test.group('portal messages', () => {
  const keys = deriveGatewayKeys(APP_KEY, 7, 1)

  test('authorize: every item signed, envelope over them in order', ({ assert }) => {
    const d = desired()
    const p = buildAuthorizeParams(d, keys, NONCE)
    assert.equal(p.keyEpoch, 1)
    assert.equal(p.ackedEventSeq, 12)
    assert.equal(p.groups[0].sig, signGroup(keys, d.groups[0]))
    assert.equal(p.grants[1].sig, signGrant(keys, d.grants[1]))
    // What the router does: recompute from the key it holds and compare.
    const router = gatewayKeysFrom(keys.gatewayKey, 7, 1)
    const expected = signEnvelope(router, {
      kind: 'authorize',
      full: true,
      serverNow: p.serverNow,
      nonce: p.nonce,
      itemSignatures: [...p.groups, ...p.grants].map((x) => x.sig),
      ackedEventSeq: p.ackedEventSeq,
      externals: p.revertExternals,
    })
    assert.isTrue(signatureMatches(expected, p.sig))
    // Dropping a grant breaks the envelope.
    const trimmed = signEnvelope(router, {
      kind: 'authorize',
      full: true,
      serverNow: p.serverNow,
      nonce: p.nonce,
      itemSignatures: [...p.groups, p.grants[0]].map((x) => x.sig),
      ackedEventSeq: p.ackedEventSeq,
      externals: p.revertExternals,
    })
    assert.isFalse(signatureMatches(trimmed, p.sig))
  })

  test('authorize refuses keys of another gateway', ({ assert }) => {
    assert.throws(
      () => buildAuthorizeParams(desired(), deriveGatewayKeys(APP_KEY, 8, 1)),
      /another gateway/
    )
  })

  test('nonces are fresh by default', ({ assert }) => {
    assert.notEqual(
      buildAuthorizeParams(desired(), keys).nonce,
      buildAuthorizeParams(desired(), keys).nonce
    )
  })

  test('vouchers: signed list; disabled = empty list flagged off', ({ assert }) => {
    const on = buildVouchersParams(desired(), keys, NONCE)
    assert.isTrue(on.enabled)
    assert.equal(on.vouchers[0].sig, signOfflineVoucher(keys, desired().offlineVouchers![0]))
    const off = buildVouchersParams(desired({ offlineVouchers: null }), keys, NONCE)
    assert.isFalse(off.enabled)
    assert.deepEqual(off.vouchers, [])
    assert.notEqual(off.sig, buildVouchersParams(desired({ offlineVouchers: [] }), keys, NONCE).sig)
  })

  test('deauthorize: ids deduplicated and sorted', ({ assert }) => {
    const p = buildDeauthorizeParams([5, 2, 5], 'revoked', keys, 1, NONCE)
    assert.deepEqual(p.grantIds, [2, 5])
    assert.equal(
      p.sig,
      signEnvelope(keys, {
        kind: 'deauthorize',
        full: false,
        serverNow: 1,
        nonce: NONCE,
        itemSignatures: [],
        grantIds: [2, 5],
        reason: 'revoked',
      })
    )
  })

  test('bindInsertedGrantIds fills ids by localRef only', ({ assert }) => {
    const bound = bindInsertedGrantIds(
      desired(),
      new Map([
        ['o1', 77],
        ['zz', 1],
      ])
    )
    assert.deepEqual(
      bound.grants.map((g) => [g.grantId, g.localRef]),
      [
        [42, null],
        [77, 'o1'],
      ]
    )
  })
})
