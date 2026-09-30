import {
  DDNS_FAILED_TYPE,
  DDNS_MISMATCH_TYPE,
  WG_STALE_TYPE,
  ddnsConditions,
  ddnsVerdicts,
  peerSilent,
  wireguardConditions,
} from '#services/alerts/detectors/gateway_sync'
import { getAlertType } from '#services/alerts/catalogue/index'
import type { DdnsServiceView } from '#services/gateway_config/ddns_service'
import type { WgInterfaceView, WgPeerView } from '#services/gateway_config/wireguard_service'
import { test } from '@japa/runner'

/**
 * The `gateway_sync` detector's rules (design gateway-sync README 14): DDNS
 * errors and stale records, silent WireGuard peers. Unknown keeps a live
 * alert, a disabled service or interface clears.
 */

function service(overrides: Partial<DdnsServiceView> = {}): DdnsServiceView {
  return {
    id: 'ab12cd',
    name: 'home',
    enabled: true,
    domain: 'home.example.com',
    live: {
      registeredIp: '203.0.113.10',
      lastUpdateAt: '2026-09-30T00:00:00Z',
      running: true,
      lastError: null,
      wanIp: '203.0.113.10',
      matches: true,
      observedAt: '2026-09-30T00:05:00Z',
    },
    ...overrides,
  } as DdnsServiceView
}

function peer(live: Partial<NonNullable<WgPeerView['live']>> | null): WgPeerView {
  return {
    id: 'pe01',
    interface: 'wg0',
    label: 'phone',
    publicKey: 'x'.repeat(43) + '=',
    live:
      live === null
        ? null
        : {
            endpoint: null,
            latestHandshakeAt: '2026-09-30T00:00:00Z',
            online: true,
            rxBytes: 0,
            txBytes: 0,
            ...live,
          },
  } as WgPeerView
}

const iface = (peers: WgPeerView[], enabled = true) =>
  ({ network: 'wg0', enabled, peers }) as unknown as WgInterfaceView

test.group('alerts | gateway_sync detector', () => {
  test('the catalogue has the three conditions', ({ assert }) => {
    for (const type of [DDNS_FAILED_TYPE, DDNS_MISMATCH_TYPE, WG_STALE_TYPE]) {
      assert.equal(getAlertType(type)?.kind, 'condition', type)
    }
  })

  test('DDNS: an error fails, another address mismatches, unknown stays unknown', ({ assert }) => {
    assert.deepEqual(ddnsVerdicts(service()), { failing: false, mismatch: false })
    const failing = service({ live: { ...service().live!, lastError: 'badauth' } })
    assert.isTrue(ddnsVerdicts(failing).failing)
    const stale = service({
      live: { ...service().live!, registeredIp: '203.0.113.9', matches: false },
    })
    assert.isTrue(ddnsVerdicts(stale).mismatch)
    const noWan = service({ live: { ...service().live!, wanIp: null, matches: null } })
    assert.isNull(ddnsVerdicts(noWan).mismatch)
    assert.deepEqual(ddnsVerdicts(service({ live: null })), { failing: null, mismatch: null })
    assert.deepEqual(ddnsVerdicts({ ...failing, enabled: false }), {
      failing: false,
      mismatch: false,
    })
  })

  test('DDNS conditions: keyed per gateway and service; unknown keeps only a live one', ({
    assert,
  }) => {
    const failing = service({ live: { ...service().live!, lastError: 'badauth' } })
    const d = ddnsConditions(3, [failing], new Map())
    assert.lengthOf(d.failing, 1)
    assert.equal(d.failing[0].dedupeKey, `${DDNS_FAILED_TYPE}:3:ab12cd`)
    assert.deepEqual(d.failing[0].subject, { kind: 'gateway', id: 3 })
    assert.deepInclude(d.failing[0].payload!, { service: 'home', error: 'badauth' })
    assert.lengthOf(d.mismatch, 0)

    const unknown = service({ live: null })
    assert.lengthOf(ddnsConditions(3, [unknown], new Map()).failing, 0)
    const kept = ddnsConditions(3, [unknown], new Map([[`${DDNS_FAILED_TYPE}:3:ab12cd`, 'active']]))
    assert.lengthOf(kept.failing, 1)
    assert.isUndefined(kept.failing[0].payload)
  })

  test('WireGuard: silent after a handshake; never shaken or disabled is not silent', ({
    assert,
  }) => {
    assert.isFalse(peerSilent({ enabled: true }, peer({})))
    assert.isTrue(peerSilent({ enabled: true }, peer({ online: false })))
    assert.isNull(peerSilent({ enabled: true }, peer({ latestHandshakeAt: null, online: false })))
    assert.isNull(peerSilent({ enabled: true }, peer(null)))
    assert.isFalse(peerSilent({ enabled: false }, peer({ online: false })))

    const out = wireguardConditions(3, [iface([peer({ online: false })])], new Map())
    assert.lengthOf(out, 1)
    assert.equal(out[0].dedupeKey, `${WG_STALE_TYPE}:3:pe01`)
    assert.deepInclude(out[0].payload!, { interface: 'wg0', label: 'phone' })
    assert.lengthOf(wireguardConditions(3, [iface([peer({ online: false })], false)], new Map()), 0)
  })
})
