import {
  type WireGrant,
  type WireGroup,
  type WireOfflineVoucher,
  canonicalEnvelope,
  canonicalGrant,
  canonicalGroup,
  canonicalOfflineVoucher,
  deriveGatewayKeys,
  deriveLookupKey,
  gatewayKeyForWire,
  gatewayKeysFrom,
  hexDigestMatches,
  newNonce,
  offlineVoucherVerifier,
  signEnvelope,
  signGrant,
  signGroup,
  signOfflineVoucher,
  signatureMatches,
  voucherCodeHash,
} from '#services/portal/crypto'
import { test } from '@japa/runner'

/**
 * Pinned vectors: the collector's Go implementation of the router side must
 * produce exactly these (docs/gateway/portal.md §6, "Test vectors"). They
 * were cross-checked against an independent HKDF/HMAC implementation.
 */
const APP_KEY = 'perch-test-app-key-0123456789abcdef'
const CODE = 'K7Q2M9XH4D'

const GRANT: WireGrant = {
  grantId: 42,
  localRef: null,
  portalId: 3,
  groupKey: 'v:17',
  mac: '02:00:00:aa:bb:cc',
  expiresAt: null,
  revision: 2,
}

const GROUP: WireGroup = {
  groupKey: 'v:17',
  durationMode: 'wall_clock',
  expiresAt: 1790000000000,
  durationSeconds: 3600,
  quotaBytes: 500000000,
  baseTimeUsedSeconds: 0,
  baseBytesUsed: 1234,
  downKbps: null,
  upKbps: null,
  maxDevices: 1,
  revision: 3,
}

function voucher(keys = deriveGatewayKeys(APP_KEY, 7, 1)): WireOfflineVoucher {
  return {
    voucherId: 17,
    verifier: offlineVoucherVerifier(keys, CODE),
    portalIds: [3],
    groupKey: 'v:17',
    durationMode: 'active_time',
    startMode: 'first_use',
    durationSeconds: 7200,
    quotaBytes: null,
    downKbps: 5000,
    upKbps: 1000,
    maxDevices: 2,
    redeemBy: 1791000000000,
    expiresAt: null,
    timeUsedSeconds: 0,
    bytesUsed: 0,
    revision: 1,
  }
}

test.group('portal crypto: pinned vectors', () => {
  const keys = deriveGatewayKeys(APP_KEY, 7, 1)

  test('lookup key and code hash', ({ assert }) => {
    const lookup = deriveLookupKey(APP_KEY)
    assert.equal(
      lookup.toString('hex'),
      'df9107c705d83bbc11aa97dc6b6443d3cfa0d71d346d58043034fbf06893e4a9'
    )
    assert.equal(
      voucherCodeHash(lookup, CODE),
      '8e73b0adbbaad5211dcd1b816eb9b9d927eb2394944d625b54a533c567057867'
    )
  })

  test('gateway key and its sub-keys', ({ assert }) => {
    assert.equal(
      keys.gatewayKey.toString('base64url'),
      '5xWg3o-mXyuxbPvlpxL3dGgcnUXrgB-JeSJjxfHfySU'
    )
    assert.equal(
      keys.voucherKey.toString('hex'),
      '77c9f47a3aa4c958b236c4805831b6090a0e9a44db4dfe8fe7ada0618c009703'
    )
    assert.equal(
      keys.signKey.toString('hex'),
      '82c4ea733b93eed127a9a15ea6f09751eae22970c0d9a631357cf79b906989de'
    )
    assert.deepEqual(gatewayKeyForWire(keys), {
      epoch: 1,
      gatewayKey: '5xWg3o-mXyuxbPvlpxL3dGgcnUXrgB-JeSJjxfHfySU',
    })
  })

  test('offline verifier', ({ assert }) => {
    assert.equal(
      offlineVoucherVerifier(keys, CODE),
      '0026473bc23eeae443961e14eb2db086f0870607cedb8ea0225eca9106112af6'
    )
  })

  test('grant record', ({ assert }) => {
    assert.equal(
      canonicalGrant(keys, GRANT),
      'perch-portal-grant-v1\n7\n1\n42\n\n3\nv:17\n02:00:00:aa:bb:cc\n\n2'
    )
    assert.equal(signGrant(keys, GRANT), 'fcGv3MNx9X1ku6Egf23WIq_MHxQkC6PcgobSjfLs7VY')
  })

  test('group record', ({ assert }) => {
    assert.equal(
      canonicalGroup(keys, GROUP),
      'perch-portal-group-v1\n7\n1\nv:17\nwall_clock\n1790000000000\n3600\n500000000\n0\n1234\n\n\n1\n3'
    )
    assert.equal(signGroup(keys, GROUP), '-OY5PsYD9P4oVsTi-rr9xIozfwJT0ojy06e2XtuhipQ')
  })

  test('offline voucher record', ({ assert }) => {
    assert.equal(
      canonicalOfflineVoucher(keys, voucher(keys)),
      'perch-portal-voucher-v1\n7\n1\n17\n0026473bc23eeae443961e14eb2db086f0870607cedb8ea0225eca9106112af6\n3\nv:17\nactive_time\nfirst_use\n7200\n\n5000\n1000\n2\n1791000000000\n\n0\n0\n1'
    )
    assert.equal(
      signOfflineVoucher(keys, voucher(keys)),
      '8_FWs60NXD4EoTssIGvOlJPTWKhemRFJSiNjoYKjVz8'
    )
  })

  test('authorize envelope', ({ assert }) => {
    const envelope = {
      kind: 'authorize' as const,
      full: true,
      serverNow: 1790000000123,
      nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
      itemSignatures: [signGroup(keys, GROUP), signGrant(keys, GRANT)],
      ackedEventSeq: 9,
      externals: [{ portalId: 3, mac: '02:00:00:00:00:09' }],
    }
    assert.equal(
      canonicalEnvelope(keys, envelope),
      'perch-portal-authorize-v1\n7\n1\n1\n1790000000123\nAAAAAAAAAAAAAAAAAAAAAA\n9\n\n\n2\n1\n' +
        '-OY5PsYD9P4oVsTi-rr9xIozfwJT0ojy06e2XtuhipQ\nfcGv3MNx9X1ku6Egf23WIq_MHxQkC6PcgobSjfLs7VY\n' +
        'ext:3:02:00:00:00:00:09'
    )
    assert.equal(signEnvelope(keys, envelope), 'cARMzBOVvRS3e43pF1xkGJl3Zg_640uqJ6OFPhourAU')
  })
})

test.group('portal crypto: key separation', () => {
  test('lookup, gateway and sub-keys are all different', ({ assert }) => {
    const lookup = deriveLookupKey(APP_KEY).toString('hex')
    const k = deriveGatewayKeys(APP_KEY, 7, 1)
    const all = [lookup, k.gatewayKey, k.voucherKey, k.signKey].map((b) =>
      typeof b === 'string' ? b : b.toString('hex')
    )
    assert.equal(new Set(all).size, 4)
    // None of them is APP_KEY itself.
    assert.notInclude(all, Buffer.from(APP_KEY).toString('hex'))
  })

  test('gateway id and epoch each change every key', ({ assert }) => {
    const a = deriveGatewayKeys(APP_KEY, 7, 1)
    const b = deriveGatewayKeys(APP_KEY, 8, 1)
    const c = deriveGatewayKeys(APP_KEY, 7, 2)
    assert.notEqual(a.gatewayKey.toString('hex'), b.gatewayKey.toString('hex'))
    assert.notEqual(a.gatewayKey.toString('hex'), c.gatewayKey.toString('hex'))
    assert.notEqual(a.signKey.toString('hex'), c.signKey.toString('hex'))
  })

  test('another APP_KEY gives other keys and hashes', ({ assert }) => {
    const other = 'another-app-key-0123456789abcdef'
    assert.notEqual(
      voucherCodeHash(deriveLookupKey(APP_KEY), CODE),
      voucherCodeHash(deriveLookupKey(other), CODE)
    )
  })

  test('the router derives the same sub-keys from the gateway key it received', ({ assert }) => {
    const k = deriveGatewayKeys(APP_KEY, 7, 1)
    const router = gatewayKeysFrom(Buffer.from(gatewayKeyForWire(k).gatewayKey, 'base64url'), 7, 1)
    assert.equal(router.voucherKey.toString('hex'), k.voucherKey.toString('hex'))
    assert.equal(router.signKey.toString('hex'), k.signKey.toString('hex'))
    assert.equal(signGrant(router, GRANT), signGrant(k, GRANT))
  })

  test('the verifier is bound to the gateway', ({ assert }) => {
    // Same gateway key material, different id: a copied list matches nothing.
    const k = deriveGatewayKeys(APP_KEY, 7, 1)
    const moved = gatewayKeysFrom(k.gatewayKey, 8, 1)
    assert.notEqual(offlineVoucherVerifier(k, CODE), offlineVoucherVerifier(moved, CODE))
  })

  test('the code hash and the verifier are unrelated', ({ assert }) => {
    const k = deriveGatewayKeys(APP_KEY, 7, 1)
    assert.notEqual(
      voucherCodeHash(deriveLookupKey(APP_KEY), CODE),
      offlineVoucherVerifier(k, CODE)
    )
  })

  test('refuses weak input', ({ assert }) => {
    assert.throws(() => deriveLookupKey('short'), /too short/)
    assert.throws(() => deriveGatewayKeys(APP_KEY, 0, 1), /gateway id/)
    assert.throws(() => deriveGatewayKeys(APP_KEY, 1, 0), /key epoch/)
    assert.throws(() => deriveGatewayKeys(APP_KEY, 1.5, 1), /gateway id/)
    assert.throws(() => gatewayKeysFrom(Buffer.alloc(16), 1, 1), /32 bytes/)
  })
})

test.group('portal crypto: canonical records', () => {
  const keys = deriveGatewayKeys(APP_KEY, 7, 1)

  test('every field of a grant is covered by its signature', ({ assert }) => {
    const base = signGrant(keys, GRANT)
    const variants: Partial<WireGrant>[] = [
      { grantId: 43 },
      { portalId: 4 },
      { groupKey: 'v:18' },
      { mac: '02:00:00:aa:bb:cd' },
      { expiresAt: 1 },
      { revision: 3 },
      { grantId: null, localRef: 'o1' },
    ]
    for (const v of variants)
      assert.notEqual(signGrant(keys, { ...GRANT, ...v }), base, JSON.stringify(v))
  })

  test('every field of a group is covered by its signature', ({ assert }) => {
    const base = signGroup(keys, GROUP)
    const variants: Partial<WireGroup>[] = [
      { groupKey: 'g:17' },
      { durationMode: 'active_time' },
      { expiresAt: null },
      { durationSeconds: 3601 },
      { quotaBytes: null },
      { baseTimeUsedSeconds: 1 },
      { baseBytesUsed: 1235 },
      { downKbps: 1 },
      { upKbps: 1 },
      { maxDevices: 2 },
      { revision: 4 },
    ]
    for (const v of variants)
      assert.notEqual(signGroup(keys, { ...GROUP, ...v }), base, JSON.stringify(v))
  })

  test('null and 0 are different values', ({ assert }) => {
    assert.notEqual(signGroup(keys, { ...GROUP, downKbps: 0 }), signGroup(keys, GROUP))
  })

  test('voucher portal lists are sorted, so order does not matter', ({ assert }) => {
    const v = voucher(keys)
    assert.equal(
      signOfflineVoucher(keys, { ...v, portalIds: [5, 3] }),
      signOfflineVoucher(keys, { ...v, portalIds: [3, 5] })
    )
    assert.notEqual(
      signOfflineVoucher(keys, { ...v, portalIds: [3, 5] }),
      signOfflineVoucher(keys, v)
    )
  })

  test('a signature from one gateway does not verify on another', ({ assert }) => {
    const other = deriveGatewayKeys(APP_KEY, 8, 1)
    assert.notEqual(signGrant(keys, GRANT), signGrant(other, GRANT))
  })

  test('delimiter injection and bad numbers are refused', ({ assert }) => {
    assert.throws(() => canonicalGrant(keys, { ...GRANT, localRef: 'a\nb' }), /canonical token/)
    assert.throws(() => canonicalGrant(keys, { ...GRANT, mac: '02:00:00:AA:BB:CC' }), /mac/)
    assert.throws(() => canonicalGrant(keys, { ...GRANT, groupKey: 'x:1' }), /groupKey/)
    assert.throws(() => canonicalGrant(keys, { ...GRANT, revision: -1 }), /non-negative/)
    assert.throws(() => canonicalGrant(keys, { ...GRANT, revision: 1.5 }), /non-negative/)
    assert.throws(() => canonicalGrant(keys, { ...GRANT, grantId: null }), /grantId or a localRef/)
    assert.throws(
      () => canonicalGroup(keys, { ...GROUP, baseBytesUsed: Number.NaN }),
      /non-negative/
    )
    assert.throws(
      () => canonicalOfflineVoucher(keys, { ...voucher(keys), verifier: 'abc' }),
      /verifier/
    )
    assert.throws(
      () => canonicalOfflineVoucher(keys, { ...voucher(keys), portalIds: [] }),
      /portalIds/
    )
  })

  test('envelopes bind order, count, externals and journal position', ({ assert }) => {
    const items = [signGroup(keys, GROUP), signGrant(keys, GRANT)]
    const base = {
      kind: 'authorize' as const,
      full: true,
      serverNow: 1,
      nonce: newNonce(),
      itemSignatures: items,
      ackedEventSeq: 4,
      externals: [] as { portalId: number | null; mac: string }[],
    }
    const sig = signEnvelope(keys, base)
    assert.notEqual(signEnvelope(keys, { ...base, itemSignatures: [...items].reverse() }), sig)
    assert.notEqual(signEnvelope(keys, { ...base, itemSignatures: items.slice(0, 1) }), sig)
    assert.notEqual(signEnvelope(keys, { ...base, ackedEventSeq: 5 }), sig)
    assert.notEqual(signEnvelope(keys, { ...base, full: false }), sig)
    assert.notEqual(signEnvelope(keys, { ...base, kind: 'vouchers' }), sig)
    assert.notEqual(
      signEnvelope(keys, { ...base, externals: [{ portalId: null, mac: '02:00:00:00:00:01' }] }),
      sig
    )
    assert.throws(() => signEnvelope(keys, { ...base, nonce: 'short' }), /nonce/)
    assert.throws(() => signEnvelope(keys, { ...base, itemSignatures: ['x'] }), /signature/)
    assert.throws(
      () => signEnvelope(keys, { ...base, externals: [{ portalId: 1, mac: 'nope' }] }),
      /invalid mac/
    )
  })

  test('deauthorize envelopes sort grant ids', ({ assert }) => {
    const e = {
      kind: 'deauthorize' as const,
      full: false,
      serverNow: 1,
      nonce: newNonce(),
      itemSignatures: [],
    }
    assert.equal(
      signEnvelope(keys, { ...e, grantIds: [3, 1, 2], reason: 'revoked' }),
      signEnvelope(keys, { ...e, grantIds: [1, 2, 3], reason: 'revoked' })
    )
    assert.notEqual(
      signEnvelope(keys, { ...e, grantIds: [1, 2, 3], reason: 'revoked' }),
      signEnvelope(keys, { ...e, grantIds: [1, 2, 3], reason: 'expired' })
    )
  })

  test('nonces are 16 random bytes', ({ assert }) => {
    const a = newNonce()
    assert.match(a, /^[A-Za-z0-9_-]{22}$/)
    assert.notEqual(a, newNonce())
  })
})

test.group('portal crypto: comparisons', () => {
  test('signatureMatches is exact', ({ assert }) => {
    const s = 'fcGv3MNx9X1ku6Egf23WIq_MHxQkC6PcgobSjfLs7VY'
    assert.isTrue(signatureMatches(s, s))
    assert.isFalse(signatureMatches(s, s.slice(0, -1) + 'W'))
    assert.isFalse(signatureMatches(s, s.slice(1)))
    assert.isFalse(signatureMatches(s, undefined))
    assert.isFalse(signatureMatches(s, 42))
  })

  test('hexDigestMatches accepts only 64 lower-case hex chars', ({ assert }) => {
    const h = '0026473bc23eeae443961e14eb2db086f0870607cedb8ea0225eca9106112af6'
    assert.isTrue(hexDigestMatches(h, h))
    assert.isFalse(hexDigestMatches(h, h.toUpperCase()))
    assert.isFalse(hexDigestMatches(h, h.replace(/.$/, '7')))
    assert.isFalse(hexDigestMatches(h, null))
    assert.isFalse(hexDigestMatches('zz', h))
  })
})
