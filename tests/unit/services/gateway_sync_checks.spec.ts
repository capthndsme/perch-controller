import {
  checkedConfirmWindow,
  checksAllowConfirm,
  checksParam,
  checksView,
  failedCheckItems,
  mergeChecksReport,
  nextChecksState,
  parseChecksReport,
  wireChecks,
} from '#services/gateway_config/apply_checks'
import { GATEWAY_CONFIG_DEFAULTS } from '#services/gateway_config/gateway_config_settings'
import {
  GATEWAY_SYNC_DEFAULTS,
  checkGatewaySyncPatch,
  normalizeGatewaySyncSettings,
  resolveNameProblem,
} from '#services/gateway_config/gateway_sync_settings'
import { wanTransitionsBetween } from '#services/gateway_config/gateway_wan_transitions'
import { GatewayPlaneError } from '#services/gateway_config/errors'
import { test } from '@japa/runner'

/**
 * Gateway sync B0 checks on the controller (domains.md 1.5, protocol.md 1):
 * the wire form of a job's checks, the agent's reports merged into the apply
 * row, the confirm gate, the view; Settings → Gateway sync's limits; the WAN
 * transitions between two observations.
 */

const ITEMS = [
  { id: 'up:wan', kind: 'interface_up', network: 'wan', family: 4 as const, mustPass: true },
  { id: 'route4', kind: 'default_route', family: 4 as const },
  { id: 'dns', kind: 'resolve', name: 'example.com' },
]

test.group('gateway sync | apply checks, controller side', () => {
  test('the budget is clamped to the window minus 20 s (10–900); none stays explicit', ({
    assert,
  }) => {
    const plan = { timeoutSeconds: 150, items: ITEMS as any }
    assert.equal(wireChecks(plan, 300)!.timeoutSeconds, 150)
    assert.equal(wireChecks(plan, 120)!.timeoutSeconds, 100)
    assert.equal(wireChecks({ ...plan, timeoutSeconds: 2 }, 300)!.timeoutSeconds, 10)
    assert.isNull(wireChecks(null, 300))
    const none = wireChecks({ timeoutSeconds: 0, items: [] }, 300)!
    assert.deepEqual(checksParam(none), { v: 1, items: [] })
    assert.deepEqual(checksParam(wireChecks(plan, 300)), {
      v: 1,
      timeoutSeconds: 150,
      items: ITEMS,
    })
    // The agent's own net is never sent back.
    assert.isNull(checksParam({ v: 1, timeoutSeconds: 90, agentAdded: true, items: [] }))
  })

  test('the WAN window: the setting, or the management window when protected', ({ assert }) => {
    const settings = { ...GATEWAY_CONFIG_DEFAULTS, managementConfirmTimeoutSeconds: 600 }
    const sync = { ...GATEWAY_SYNC_DEFAULTS, wanConfirmTimeoutSeconds: 300 }
    assert.equal(checkedConfirmWindow(settings, sync, { protected: false }), 300)
    assert.equal(checkedConfirmWindow(settings, sync, { protected: true }), 600)
    assert.equal(
      checkedConfirmWindow(settings, sync, { protected: true, routerMaxSeconds: 400 }),
      400
    )
  })

  test('reports: the reply’s baseline, notifications, a result; skipped stays skipped', ({
    assert,
  }) => {
    const reply = parseChecksReport({
      state: 'pending',
      timeoutSeconds: 60,
      baseline: [
        { id: 'up:wan', state: 'failed', detail: 'wan is down', at: 'a' },
        { id: 'route4', state: 'skipped', detail: 'no default route', at: 'a' },
        { id: 'dns', state: 'passed', detail: 'ok', at: 'a' },
      ],
    })!
    const first = mergeChecksReport(null, reply, ITEMS)
    assert.deepEqual(
      first.items.map((i) => [i.id, i.state]),
      [
        ['up:wan', 'pending'],
        ['route4', 'skipped'],
        ['dns', 'pending'],
      ]
    )
    assert.equal(first.timeoutSeconds, 60)
    const running = parseChecksReport({
      applyId: 'g1-x',
      state: 'running',
      startedAt: '2026-10-02T10:00:03Z',
      elapsedSeconds: 4,
      items: [{ id: 'up:wan', state: 'passed', detail: 'up after 4.1 s', at: 'b' }],
    })!
    const second = mergeChecksReport(first, running, ITEMS)
    assert.equal(second.state, 'running')
    assert.equal(second.startedAt, '2026-10-02T10:00:03Z')
    assert.deepEqual(
      second.items.map((i) => [i.id, i.state]),
      [
        ['up:wan', 'passed'],
        ['route4', 'skipped'],
        ['dns', 'pending'],
      ]
    )
    assert.isNull(parseChecksReport({ nothing: true }))
    assert.isNull(parseChecksReport('x'))
  })

  test('the gate, and a late report never moves a finished set back', ({ assert }) => {
    assert.isTrue(checksAllowConfirm(null))
    assert.isTrue(checksAllowConfirm('passed'))
    assert.isTrue(checksAllowConfirm('overridden'))
    assert.isFalse(checksAllowConfirm('running'))
    assert.isFalse(checksAllowConfirm('failed'))
    assert.equal(nextChecksState('running', 'passed'), 'passed')
    assert.equal(nextChecksState('passed', 'running'), 'passed')
    assert.equal(nextChecksState('overridden', 'failed'), 'overridden')
    assert.equal(nextChecksState(null, null), null)
  })

  test('the view merges what was sent with what the router reported', ({ assert }) => {
    const checks = wireChecks({ timeoutSeconds: 60, items: ITEMS as any }, 300)
    const results = {
      state: 'failed',
      startedAt: 's',
      timeoutSeconds: 60,
      allSkipped: false,
      items: [
        { id: 'up:wan', state: 'failed', detail: 'wan is down', at: 'c' },
        { id: 'route4', state: 'passed', detail: 'ok', at: 'c' },
      ],
    }
    const view = checksView(
      { checks, checkResults: results, checksState: 'failed', checksOverriddenAt: null },
      null
    )!
    assert.equal(view.state, 'failed')
    assert.deepEqual(view.items[0], {
      id: 'up:wan',
      kind: 'interface_up',
      network: 'wan',
      family: 4,
      targets: null,
      name: null,
      mustPass: true,
      state: 'failed',
      detail: 'wan is down',
      at: 'c',
    })
    assert.equal(view.items[2].state, 'pending', 'not reported yet')
    assert.deepEqual(
      failedCheckItems(checks, results).map((i) => i.id),
      ['up:wan']
    )
    assert.isNull(
      checksView(
        {
          checks: { v: 1, timeoutSeconds: 0, items: [] },
          checkResults: null,
          checksState: null,
          checksOverriddenAt: null,
        },
        null
      ),
      'no checks by request: no checks shown'
    )
  })
})

test.group('gateway sync | settings', () => {
  const refusal = (fn: () => void) => {
    try {
      fn()
    } catch (error) {
      if (error instanceof GatewayPlaneError) return error
      throw error
    }
    throw new Error('expected a refusal')
  }

  test('defaults (D2: import), clamping of stored values, the limits', ({ assert }) => {
    const s = normalizeGatewaySyncSettings({
      authoritativeWan: 'bogus',
      wanConfirmTimeoutSeconds: 99999,
      checkTargets: ['nope', '$gateway'],
      checkResolveName: 'router.lan',
    })
    assert.equal(s.authoritativeWan, 'import')
    assert.equal(s.wanConfirmTimeoutSeconds, 1800)
    assert.deepEqual(s.checkTargets, ['$gateway'])
    assert.equal(s.checkResolveName, 'example.com')
    assert.equal(refusal(() => checkGatewaySyncPatch({ checkTcpPort: 0 })).code, 'invalid_setting')
    assert.equal(
      refusal(() => checkGatewaySyncPatch({ checkTargets: ['1.1.1.1', 'x'] })).data.field,
      'checkTargets'
    )
  })

  test('the resolve name: an internet name with room for the fresh label', ({ assert }) => {
    assert.isNull(resolveNameProblem('example.com'))
    assert.isNull(resolveNameProblem(''))
    assert.isNotNull(resolveNameProblem('example'))
    assert.isNotNull(resolveNameProblem('printer.local'))
    assert.isNotNull(resolveNameProblem('nas.home.arpa'))
    assert.isNotNull(resolveNameProblem(`${'a.'.repeat(117)}com`))
  })
})

test.group('gateway sync | WAN transitions', () => {
  const iface = (network: string, up: boolean, extra: object = {}) => ({
    network,
    device: `${network}0`,
    up,
    proto: 'dhcp',
    ipv4: up ? ['203.0.113.10/24'] : [],
    ipv6: [],
    defaultRoute: up,
    metric: network === 'wan' ? 1 : 2,
    ...extra,
  })
  const uplinks = new Set(['wan', 'lan2'])

  test('down, up, failover, ip change; the first report records nothing', ({ assert }) => {
    assert.deepEqual(wanTransitionsBetween(null, [iface('wan', true)], uplinks), [])
    const down = wanTransitionsBetween(
      [iface('wan', true), iface('lan2', true)],
      [iface('wan', false), iface('lan2', true)],
      uplinks
    )
    assert.deepEqual(
      down.map((t) => [t.event, t.network, t.detail]),
      [
        ['down', 'wan', null],
        ['failover', 'lan2', { from: 'wan', to: 'lan2' }],
      ]
    )
    const back = wanTransitionsBetween(
      [iface('wan', false), iface('lan2', true)],
      [iface('wan', true, { ipv4: ['203.0.113.11/24'] }), iface('lan2', true)],
      uplinks
    )
    assert.deepEqual(
      back.map((t) => [t.event, t.network]),
      [
        ['up', 'wan'],
        ['failover', 'wan'],
      ]
    )
    const ip = wanTransitionsBetween(
      [iface('wan', true)],
      [iface('wan', true, { ipv4: ['203.0.113.12/24'] })],
      uplinks
    )
    assert.deepEqual(
      ip.map((t) => [t.event, t.detail]),
      [['ip_changed', { before: ['203.0.113.10/24'], after: ['203.0.113.12/24'] }]]
    )
    // A LAN interface is never a transition.
    assert.deepEqual(
      wanTransitionsBetween([iface('lan', true)], [iface('lan', false)], uplinks),
      []
    )
  })
})
