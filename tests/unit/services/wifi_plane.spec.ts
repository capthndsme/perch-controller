import type { SectionState } from '#services/gateway_config/sync_engine'
import type { ApplyOp } from '#services/gateway_config/types'
import { isSecurityDowngrade, resolutionsFor } from '#services/wifi_config/fleet_service'
import { apWireOps, wireSecretRefs } from '#services/wifi_config/lifecycle'
import { parseWifiConfigBlock, writeBlockCode } from '#services/wifi_config/registry'
import { rolloutOrder, type OrderCandidate } from '#services/wifi_config/rollout_order'
import { wifiFingerprint } from '#services/wifi_config/secrets'
import { networkStatus } from '#transformers/wifi_config'
import { test } from '@japa/runner'

/**
 * The Wi-Fi plane's pure parts (docs/design/wifi controller.md sections 4
 * and 6, protocol.md sections 2 and 3): the unbound fingerprint's shared
 * vector, the hello block parser, the AP's wire form of apply ops, the
 * rollout order, the network status rollup and the resolution table.
 */

test.group('wifi plane: fingerprints', () => {
  test('the unbound fingerprint matches the kit vector (raw key bytes)', ({ assert }) => {
    const key = Buffer.alloc(32, 0x44)
    assert.equal(wifiFingerprint(key, 'key', 'correct horse battery'), 'hmac:ac349a3eb980336c')
    assert.equal(wifiFingerprint(key, 'key', ['a', 'b']), 'hmac:afe901da1eba8775')
    // The key is bytes, not its hex text.
    assert.notEqual(
      wifiFingerprint(Buffer.from(key.toString('hex')), 'key', 'correct horse battery'),
      'hmac:ac349a3eb980336c'
    )
  })
})

test.group('wifi plane: the hello block', () => {
  test('parses the block and tolerates what an agent leaves out', ({ assert }) => {
    const block = parseWifiConfigBlock({
      protocol: 1,
      access: 'write',
      transportOk: true,
      hashes: { wireless: 'aa', network: 'bb', bogus: 7 },
      apply: {
        state: 'pending_confirm',
        applyId: 'a4-1f0c2e9b7d11',
        kind: 'apply',
        deadline: '2026-10-02T10:01:30Z',
        health: 'pending',
      },
      results: [
        { applyId: 'a4-0a1b2c3d4e5f', kind: 'apply', outcome: 'rolled_back', reason: 'reboot' },
        { nonsense: true },
      ],
      management: { network: 'lan', device: 'br-lan.1', radios: ['radio2'] },
      groups: { engine: true, enabled: false, state: 'idle', handedOver: false },
    })!
    assert.equal(block.access, 'write')
    assert.deepEqual(block.hashes, { wireless: 'aa', network: 'bb' })
    assert.equal(block.apply.state, 'pending_confirm')
    assert.equal(block.apply.health, 'pending')
    assert.lengthOf(block.results, 1)
    assert.equal(block.results[0].reason, 'reboot')
    assert.deepEqual(block.management?.radios, ['radio2'])
    assert.equal(block.groups?.state, 'idle')
    assert.equal(block.signing.key, 'none')

    const minimal = parseWifiConfigBlock({ access: 'bogus' })!
    assert.equal(minimal.access, 'none')
    assert.equal(minimal.apply.state, 'idle')
    assert.isNull(minimal.management)
    assert.isNull(parseWifiConfigBlock('nope'))
  })

  test('write blocks map to the documented refusal codes', ({ assert }) => {
    assert.equal(writeBlockCode('offline'), 'agent_offline')
    assert.equal(writeBlockCode('router_access'), 'router_access_insufficient')
    assert.equal(writeBlockCode('guard_missing'), 'guard_missing')
  })
})

function row(
  partial: Partial<SectionState> & Pick<SectionState, 'perchId' | 'name'>
): SectionState {
  return {
    config: 'wireless',
    type: 'wifi-iface',
    anonymous: false,
    scope: 'synced',
    domain: 'wifi_ifaces',
    ownership: { kind: 'options', options: ['ssid', 'hidden', 'key', 'device'] },
    issue: null,
    base: null,
    baseRevision: null,
    router: null,
    desired: null,
    status: 'ahead',
    conflict: null,
    driftSince: null,
    position: null,
    ...partial,
  }
}

test.group('wifi plane: apply ops on the wire', () => {
  test('router-owned options and secrets the AP holds travel as $keep', ({ assert }) => {
    const existing = row({
      perchId: 'p1',
      name: 'default_radio0',
      router: {
        type: 'wifi-iface',
        options: { ssid: 'Home', ifname: 'home-2g', device: 'radio0' },
        secrets: { key: { fingerprint: 'hmac:1111111111111111' } },
      },
      desired: {
        type: 'wifi-iface',
        options: { ssid: 'Home', ifname: 'home-2g', device: 'radio0', hidden: '1' },
        secrets: { key: { fingerprint: 'hmac:1111111111111111', ref: 'sref1' } },
      },
    })
    const rekeyed = row({
      perchId: 'p2',
      name: 'default_radio1',
      router: {
        type: 'wifi-iface',
        options: { ssid: 'Home' },
        secrets: { key: { fingerprint: 'hmac:1111111111111111' } },
      },
      desired: {
        type: 'wifi-iface',
        options: { ssid: 'Home' },
        secrets: { key: { fingerprint: 'hmac:2222222222222222', ref: 'sref2' } },
      },
    })
    const created = row({ perchId: 'p3', name: 'perch_n1_radio0' })
    const ops: ApplyOp[] = [
      {
        op: 'put',
        config: 'wireless',
        section: 'default_radio0',
        type: 'wifi-iface',
        options: {
          ssid: 'Home',
          ifname: 'home-2g',
          device: 'radio0',
          hidden: '1',
          key: { $secret: 'sref1' },
        },
      },
      {
        op: 'put',
        config: 'wireless',
        section: 'default_radio1',
        type: 'wifi-iface',
        options: { ssid: 'Home', key: { $secret: 'sref2' } },
      },
      {
        op: 'put',
        config: 'wireless',
        section: 'perch_n1_radio0',
        type: 'wifi-iface',
        options: { ssid: 'Guest', mode: 'ap', key: { $secret: 'sref2' } },
      },
      { op: 'adopt', config: 'wireless', section: 'default_radio0', perchId: 'p1' },
    ]
    const wire = apWireOps(ops, [existing, rekeyed, created])
    const first = wire[0] as Extract<ApplyOp, { op: 'put' }>
    assert.deepEqual(first.options.ifname, { $keep: true })
    assert.deepEqual(first.options.key, { $keep: true })
    assert.equal(first.options.hidden, '1')
    const second = wire[1] as Extract<ApplyOp, { op: 'put' }>
    assert.deepEqual(second.options.key, { $secret: 'sref2' })
    const third = wire[2] as Extract<ApplyOp, { op: 'put' }>
    assert.equal(third.options.mode, 'ap')
    assert.deepEqual(wire[3], ops[3])
    assert.deepEqual(wireSecretRefs(wire), ['sref2'])
  })
})

function candidate(apId: number, partial: Partial<OrderCandidate> = {}): OrderCandidate {
  return {
    apId,
    name: `ap-${apId}`,
    online: true,
    protected: false,
    clients: 0,
    adminDeviceHere: false,
    ...partial,
  }
}

test.group('wifi plane: rollout order', () => {
  test('canary: online first, fewest clients first, the admin’s AP and protected jobs last', ({
    assert,
  }) => {
    const order = rolloutOrder(
      [
        candidate(1, { clients: 12 }),
        candidate(2, { clients: 3, adminDeviceHere: true }),
        candidate(3, { clients: 7 }),
        candidate(4, { online: false }),
        candidate(5, { protected: true }),
        candidate(6, { clients: 7 }),
      ],
      'canary'
    )
    assert.deepEqual(order, [3, 6, 1, 2, 5, 4])
  })

  test('name order, and an explicit order wins', ({ assert }) => {
    const list = [
      candidate(1, { name: 'garage' }),
      candidate(2, { name: 'attic' }),
      candidate(3, { name: 'den' }),
    ]
    assert.deepEqual(rolloutOrder(list, 'name'), [2, 3, 1])
    assert.deepEqual(rolloutOrder(list, 'canary', [3, 9, 3]), [3, 1, 2])
  })
})

test.group('wifi plane: rollups and resolutions', () => {
  test('network status over its managed slots', ({ assert }) => {
    assert.equal(networkStatus([]), 'unmanaged')
    assert.equal(networkStatus(['unsupported']), 'unmanaged')
    assert.equal(networkStatus(['in_sync', 'in_sync']), 'in_sync')
    assert.equal(networkStatus(['ahead', 'offline']), 'ahead')
    assert.equal(networkStatus(['ahead', 'in_sync']), 'partial')
    assert.equal(networkStatus(['pending', 'diverged']), 'applying')
    assert.equal(networkStatus(['diverged', 'ahead']), 'diverged')
    assert.equal(networkStatus(['conflict', 'pending']), 'conflict')
  })

  test('the resolutions each divergence offers (controller.md 5.3)', ({ assert }) => {
    assert.deepEqual(resolutionsFor({ kind: 'option', option: 'ssid' }), [
      'fleet',
      'revert',
      'split',
    ])
    assert.deepEqual(resolutionsFor({ kind: 'option', option: 'key' }), [
      'fleet',
      'override',
      'revert',
    ])
    assert.deepEqual(resolutionsFor({ kind: 'option', option: 'ieee80211r' }), ['fleet', 'revert'])
    assert.deepEqual(resolutionsFor({ kind: 'removed', option: null }), ['override', 'revert'])
    assert.deepEqual(resolutionsFor({ kind: 'unassigned', option: null }), ['split'])
    assert.deepEqual(resolutionsFor({ kind: 'country', option: 'country' }), [
      'fleet',
      'override',
      'revert',
    ])
  })

  test('security downgrades (the step-up rule)', ({ assert }) => {
    assert.isTrue(isSecurityDowngrade('wpa3', 'wpa2'))
    assert.isTrue(isSecurityDowngrade('wpa2', 'open'))
    assert.isFalse(isSecurityDowngrade('wpa2', 'wpa2_wpa3'))
    assert.isFalse(isSecurityDowngrade('owe', 'owe'))
  })
})
