import {
  MASS_KEY,
  apOfflineKey,
  collectorOfflineKey,
  evaluateAgents,
  massOfflineHolds,
} from '#services/alerts/detectors/agents'
import {
  deviceKey,
  evaluateWatches,
  isRandomizedMac,
  newDeviceParams,
  selectNewDevices,
  type NewDeviceCandidate,
} from '#services/alerts/detectors/devices'
import { groupsFailedHolds, summarizeSections } from '#services/alerts/detectors/gateway'
import { isSilent } from '#services/alerts/detectors/liveness'
import { portalNotEnforcing, terminalConditions } from '#services/alerts/detectors/portal'
import {
  flappingHolds,
  newBaseline,
  observeCounter,
  observeSpeed,
  portIsDown,
  resumeBaseline,
} from '#services/alerts/detectors/ports'
import {
  checkoutAmount,
  mapApJoined,
  mapCheckout,
  mapGatewayEvent,
  mapPendingCollector,
  mapPortalEvent,
} from '#services/alerts/detectors/scans'
import {
  diskPath,
  diskSeverity,
  retentionStalled,
  rollupStalled,
} from '#services/alerts/detectors/system'
import { evaluateWan, wanUp, type WanMemory } from '#services/alerts/detectors/wan'
import type { Mwan3Observation, ObservedInterface } from '#services/gateway_observation_parts'
import type { DevicePresence } from '#services/wifi_presence'
import { test } from '@japa/runner'

const MASS = { enabled: true, fractionPercent: 75, minAgents: 3 }

test.group('alerts detectors | agents', () => {
  test('silence is strictly past the bound; never reported is not silent', ({ assert }) => {
    assert.isFalse(isSilent(30, 30))
    assert.isTrue(isSilent(31, 30))
    assert.isFalse(isSilent(null, 30))
  })

  test('mass-offline guard: at least minAgents and the fraction', ({ assert }) => {
    assert.isTrue(massOfflineHolds(3, 4, MASS))
    assert.isFalse(massOfflineHolds(2, 4, MASS))
    // Fewer monitored than minAgents: never.
    assert.isFalse(massOfflineHolds(2, 2, MASS))
    // The fraction rounds up: 75 % of 10 = 7.5 → 8.
    assert.isFalse(massOfflineHolds(7, 10, MASS))
    assert.isTrue(massOfflineHolds(8, 10, MASS))
    assert.isFalse(massOfflineHolds(4, 4, { ...MASS, enabled: false }))
  })

  const agents = (silent: boolean[]) =>
    silent.map((s, i) => ({
      key: i === 0 ? collectorOfflineKey(1) : apOfflineKey(i + 1),
      name: i === 0 ? 'gateway' : `AP ${i + 1}`,
      silent: s,
    }))

  test('one silent agent holds its own alert', ({ assert }) => {
    const verdict = evaluateAgents({
      agents: agents([false, true, false, false]),
      live: new Map(),
      inBootGrace: false,
      massOffline: MASS,
    })
    assert.deepEqual(verdict.hold, [apOfflineKey(2)])
    assert.isNull(verdict.mass)
  })

  test('3 of 4 silent: one system.agents_unreachable, no per-agent raise', ({ assert }) => {
    const verdict = evaluateAgents({
      agents: agents([true, true, true, false]),
      live: new Map(),
      inBootGrace: false,
      massOffline: MASS,
    })
    assert.deepEqual(verdict.hold, [])
    assert.deepEqual(verdict.mass, {
      silent: 3,
      monitored: 4,
      names: ['gateway', 'AP 2', 'AP 3'],
    })
  })

  test('the guard drops pending per-agent alerts and keeps notified ones', ({ assert }) => {
    // Two agents fell silent a tick before the rest: their alerts are pending.
    const verdict = evaluateAgents({
      agents: agents([true, true, true, true]),
      live: new Map([
        [collectorOfflineKey(1), 'active'],
        [apOfflineKey(2), 'pending'],
      ]),
      inBootGrace: false,
      massOffline: MASS,
    })
    assert.deepEqual(verdict.hold, [collectorOfflineKey(1)])
    assert.equal(verdict.mass?.silent, 4)
  })

  test('boot grace raises nothing new but keeps what is live and lets recoveries clear', ({
    assert,
  }) => {
    const verdict = evaluateAgents({
      agents: agents([false, true, true, true]),
      live: new Map([
        [apOfflineKey(2), 'active'],
        [collectorOfflineKey(1), 'active'],
      ]),
      inBootGrace: true,
      massOffline: MASS,
    })
    // Mass holds (3 of 4) but is not live: not raised in grace; AP 2 is active: kept.
    assert.isNull(verdict.mass)
    assert.deepEqual(verdict.hold, [apOfflineKey(2)])
    // The collector recovered: left out, so it clears.
    assert.notInclude(verdict.hold, collectorOfflineKey(1))

    const kept = evaluateAgents({
      agents: agents([true, true, true, true]),
      live: new Map([[MASS_KEY, 'active']]),
      inBootGrace: true,
      massOffline: MASS,
    })
    assert.isNotNull(kept.mass)
  })
})

test.group('alerts detectors | devices', () => {
  const candidate = (mac: string, network: string | null = 'lan', at = '2026-09-30T01:00:00Z') =>
    ({ mac, network, firstSeenAt: at }) satisfies NewDeviceCandidate
  const none = {
    known: new Set<string>(),
    portalNetworks: new Set<string>(),
    alerted: new Set<string>(),
  }

  test('randomised MACs are the locally administered ones', ({ assert }) => {
    assert.isTrue(isRandomizedMac('02:00:00:5e:10:22'))
    assert.isTrue(isRandomizedMac('da:a1:19:00:00:01'))
    assert.isFalse(isRandomizedMac('00:1a:2b:3c:4d:5e'))
    assert.isFalse(isRandomizedMac('f0:9f:c2:00:00:01'))
  })

  test('params fall back to the catalogue defaults', ({ assert }) => {
    assert.deepEqual(newDeviceParams(undefined), {
      minPresenceMinutes: 10,
      ignoreRandomizedMacs: false,
      excludePortalNetworks: true,
      excludeNetworks: [],
    })
    assert.equal(newDeviceParams({ minPresenceMinutes: 0 }).minPresenceMinutes, 0)
    assert.equal(newDeviceParams({ minPresenceMinutes: 'x' as never }).minPresenceMinutes, 10)
  })

  test('exclusions: known MACs, already alerted, networks, portal networks, randomised', ({
    assert,
  }) => {
    const candidates = [
      candidate('00:11:22:33:44:01'),
      candidate('00:11:22:33:44:02'),
      candidate('00:11:22:33:44:03'),
      candidate('00:11:22:33:44:04', 'guest'),
      candidate('00:11:22:33:44:05', 'iot'),
      candidate('02:00:00:00:00:06'),
    ]
    const exclusions = {
      known: new Set(['00:11:22:33:44:01']),
      alerted: new Set(['00:11:22:33:44:02']),
      portalNetworks: new Set(['guest']),
    }
    const params = newDeviceParams({ excludeNetworks: ['iot'] })
    assert.deepEqual(
      selectNewDevices(candidates, exclusions, params).chosen.map((c) => c.mac),
      ['00:11:22:33:44:03', '02:00:00:00:00:06']
    )
    assert.deepEqual(
      selectNewDevices(candidates, exclusions, {
        ...params,
        ignoreRandomizedMacs: true,
      }).chosen.map((c) => c.mac),
      ['00:11:22:33:44:03']
    )
    // Portal networks count only with the switch on.
    assert.include(
      selectNewDevices(candidates, exclusions, {
        ...params,
        excludePortalNetworks: false,
      }).chosen.map((c) => c.mac),
      '00:11:22:33:44:04'
    )
  })

  test('at most 50 per scan, oldest first; the rest wait for the next scan', ({ assert }) => {
    const candidates = Array.from({ length: 60 }, (_, i) =>
      candidate(
        `00:11:22:33:${String(Math.floor(i / 256)).padStart(2, '0')}:${i.toString(16).padStart(2, '0')}`,
        'lan',
        `2026-09-30T01:${String(59 - i).padStart(2, '0')}:00Z`
      )
    )
    const { chosen, deferred } = selectNewDevices(candidates, none, newDeviceParams({}))
    assert.lengthOf(chosen, 50)
    assert.equal(deferred, 10)
    assert.equal(chosen[0].firstSeenAt, '2026-09-30T01:00:00Z')
  })

  const presence = (entries: Record<string, DevicePresence['status']>) =>
    new Map(
      Object.entries(entries).map(([mac, status]) => [
        mac,
        { status, via: 'wifi' as const, lastSeenAt: null },
      ])
    )
  const A = '02:00:00:00:00:0a'
  const B = '02:00:00:00:00:0b'

  test('watched offline holds while disconnected; arrival on disconnected → connected', ({
    assert,
  }) => {
    const watches = [
      { mac: A, offline: true, arrival: false },
      { mac: B, offline: false, arrival: true },
    ]
    const first = evaluateWatches({
      watches,
      presence: presence({ [A]: 'disconnected', [B]: 'disconnected' }),
      live: new Map(),
      previous: {},
      agentTrouble: false,
    })
    assert.deepEqual(first.offline, [A])
    assert.deepEqual(first.arrivals, [])
    assert.deepEqual(first.remember, { [B]: 'disconnected' })

    const second = evaluateWatches({
      watches,
      presence: presence({ [A]: 'connected', [B]: 'connected' }),
      live: new Map([[deviceKey('device.offline', A), 'active']]),
      previous: first.remember,
      agentTrouble: false,
    })
    assert.deepEqual(second.offline, [])
    assert.deepEqual(second.arrivals, [B])
    assert.deepEqual(second.remember, { [B]: 'connected' })
  })

  test('agent trouble withholds new offline alerts and freezes arrivals', ({ assert }) => {
    const watches = [
      { mac: A, offline: true, arrival: false },
      { mac: B, offline: true, arrival: true },
    ]
    const verdict = evaluateWatches({
      watches,
      presence: presence({ [A]: 'disconnected', [B]: 'connected' }),
      live: new Map([[deviceKey('device.offline', A), 'pending']]),
      previous: { [B]: 'disconnected' },
      agentTrouble: true,
    })
    // A's alert is only pending: dropped (a blip); nothing new raised.
    assert.deepEqual(verdict.offline, [])
    // B is connected again, but the memory is frozen: no arrival.
    assert.deepEqual(verdict.arrivals, [])
    assert.deepEqual(verdict.remember, { [B]: 'disconnected' })

    const kept = evaluateWatches({
      watches,
      presence: presence({ [A]: 'disconnected' }),
      live: new Map([[deviceKey('device.offline', A), 'active']]),
      previous: {},
      agentTrouble: true,
    })
    assert.include(kept.offline, A)
  })
})

test.group('alerts detectors | system', () => {
  test('disk severity by free percent', ({ assert }) => {
    const p = { warnPercentFree: 10, criticalPercentFree: 3 }
    assert.isNull(diskSeverity(50, p))
    assert.equal(diskSeverity(9.9, p), 'warning')
    assert.equal(diskSeverity(2.5, p), 'critical')
    assert.equal(diskPath({ path: ['/srv/perch'] }), '/srv/perch')
    assert.equal(diskPath({ path: ['relative'] }), '/data')
    assert.equal(diskPath(undefined), '/data')
  })

  test('rollup stalled only while native data arrives', ({ assert }) => {
    assert.isTrue(rollupStalled({ nativeAgeMinutes: 0.2, rollupAgeMinutes: 47 }, 30))
    assert.isFalse(rollupStalled({ nativeAgeMinutes: 0.2, rollupAgeMinutes: 6 }, 30))
    // Nothing arrives (collector down): not a rollup problem.
    assert.isFalse(rollupStalled({ nativeAgeMinutes: 25, rollupAgeMinutes: 47 }, 30))
    assert.isFalse(rollupStalled({ nativeAgeMinutes: null, rollupAgeMinutes: null }, 30))
    assert.isTrue(rollupStalled({ nativeAgeMinutes: 1, rollupAgeMinutes: null }, 30))
  })

  test('retention stalled past retention + grace; off when pruning is off', ({ assert }) => {
    assert.isFalse(retentionStalled(31.5, 30, 2))
    assert.isTrue(retentionStalled(32.5, 30, 2))
    assert.isFalse(retentionStalled(400, 0, 2))
    assert.isFalse(retentionStalled(null, 30, 2))
  })
})

// ── WAN ────────────────────────────────────────────────────────────────────

function iface(network: string, overrides: Partial<ObservedInterface> = {}): ObservedInterface {
  return {
    network,
    device: overrides.device ?? network,
    up: true,
    proto: 'dhcp',
    ipv4: [],
    ipv6: [],
    defaultRoute: false,
    metric: null,
    uptimeSeconds: 100,
    gateway4: null,
    gateway6: null,
    dnsServers: [],
    error: null,
    ipv6Prefixes: [],
    ipv6Assigned: [],
    ...overrides,
  }
}

const T0 = new Date('2026-09-30T00:00:00Z')
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000)

/** The live gateway's shape (IPs are placeholders). */
const LIVE = [
  iface('wan', { device: 'wan0', defaultRoute: true, metric: 1, ipv4: ['203.0.113.10/20'] }),
  iface('lan2', { device: 'wan2', defaultRoute: true, metric: 2, ipv4: ['192.168.8.2/24'] }),
  iface('globe', { device: 'globe', up: false, proto: 'dhcp' }),
  iface('wan6', { device: 'wan0', up: false, proto: 'dhcpv6' }),
  iface('lan', { device: 'lan0', proto: 'static', metric: 0, ipv4: ['192.168.1.1/24'] }),
]
const MWAN3_OFF: Mwan3Observation = {
  service: { installed: true, enabled: false, running: false },
  configInterfaces: [
    { name: 'wan', enabled: true, family: 'ipv4', trackIps: [] },
    { name: 'lan2', enabled: true, family: 'ipv4', trackIps: [] },
    { name: 'globe', enabled: true, family: 'ipv4', trackIps: [] },
  ],
  configPolicies: {},
  interfaces: [],
  policies: {},
}

test.group('alerts detectors | wan', () => {
  test('a default route makes a WAN; mwan3 config counts only while mwan3 runs', ({ assert }) => {
    const e = evaluateWan({
      interfaces: LIVE,
      mwan3: MWAN3_OFF,
      memory: {},
      now: T0,
      forgetHours: 24,
    })
    assert.sameMembers(Object.keys(e.memory), ['wan', 'lan2'])
    assert.deepEqual(
      e.wans.map((w) => [w.network, w.up]),
      [
        ['wan', true],
        ['lan2', true],
      ]
    )
    assert.deepEqual(e.active, { network: 'wan', device: 'wan0' })
    assert.isNull(e.failover)
    assert.isFalse(e.allDown)

    const running = evaluateWan({
      interfaces: LIVE,
      mwan3: { ...MWAN3_OFF, service: { installed: true, enabled: true, running: true } },
      memory: {},
      now: T0,
      forgetHours: 24,
    })
    assert.sameMembers(Object.keys(running.memory), ['wan', 'lan2', 'globe'])
  })

  test('down on link loss or lost route; failover to the next metric; failback clears', ({
    assert,
  }) => {
    const first = evaluateWan({
      interfaces: LIVE,
      mwan3: null,
      memory: {},
      now: T0,
      forgetHours: 24,
    })
    // wan loses its link: lan2 carries the default route.
    const down = evaluateWan({
      interfaces: [
        iface('wan', { device: 'wan0', up: false, defaultRoute: false, metric: null }),
        LIVE[1],
      ],
      mwan3: null,
      memory: first.memory,
      now: at(1),
      forgetHours: 24,
    })
    const wan = down.wans.find((w) => w.network === 'wan')!
    assert.isFalse(wan.up)
    assert.equal(wan.reason, 'link_down')
    assert.equal(wan.since, at(1).toISOString())
    // The remembered metric keeps wan preferred while it is down.
    assert.equal(wan.metric, 1)
    assert.isFalse(down.allDown)
    assert.deepEqual(down.failover, {
      from: { network: 'wan', device: 'wan0' },
      to: { network: 'lan2', device: 'wan2' },
      reason: 'link_down',
    })

    // Up but without its route: route_lost.
    const routeLost = evaluateWan({
      interfaces: [iface('wan', { device: 'wan0', defaultRoute: false }), LIVE[1]],
      mwan3: null,
      memory: down.memory,
      now: at(2),
      forgetHours: 24,
    })
    assert.equal(routeLost.wans.find((w) => w.network === 'wan')!.reason, 'route_lost')
    // The outage start is kept across ticks.
    assert.equal(routeLost.wans.find((w) => w.network === 'wan')!.since, at(1).toISOString())

    const back = evaluateWan({
      interfaces: LIVE,
      mwan3: null,
      memory: routeLost.memory,
      now: at(9),
      forgetHours: 24,
    })
    assert.isNull(back.failover)
    assert.isTrue(back.wans.every((w) => w.up))
    assert.isNull(back.memory.wan.downSince)
  })

  test('all remembered WANs down: allDown, no active WAN, no failover', ({ assert }) => {
    const first = evaluateWan({
      interfaces: LIVE,
      mwan3: null,
      memory: {},
      now: T0,
      forgetHours: 24,
    })
    const e = evaluateWan({
      interfaces: [
        iface('wan', { device: 'wan0', up: false, defaultRoute: false }),
        iface('lan2', { device: 'wan2', up: true, defaultRoute: false, error: 'NO_DEVICE' }),
      ],
      mwan3: null,
      memory: first.memory,
      now: at(1),
      forgetHours: 24,
    })
    assert.isTrue(e.allDown)
    assert.isNull(e.active)
    assert.isNull(e.failover)
    assert.equal(e.wans.find((w) => w.network === 'lan2')!.reason, 'netifd_error')
  })

  test('mwan3 status decides when mwan3 runs', ({ assert }) => {
    const mwan3 = (status: string): Mwan3Observation => ({
      ...MWAN3_OFF,
      service: { installed: true, enabled: true, running: true },
      interfaces: [
        {
          name: 'wan',
          status,
          enabled: true,
          running: true,
          up: true,
          uptimeSeconds: 1,
          tracking: 'active',
          trackIps: [],
        },
      ],
    })
    assert.deepEqual(wanUp(LIVE[0], mwan3('offline')), { up: false, reason: 'mwan3_offline' })
    assert.deepEqual(wanUp(iface('wan', { up: false }), mwan3('online')), {
      up: true,
      reason: null,
    })
    // Other statuses fall through to netifd.
    assert.deepEqual(wanUp(LIVE[0], mwan3('notracking')), { up: true, reason: null })
  })

  test('forgotten after forgetHours absent, or when an admin resolved it', ({ assert }) => {
    const first = evaluateWan({
      interfaces: LIVE,
      mwan3: null,
      memory: {},
      now: T0,
      forgetHours: 24,
    })
    const absent = [LIVE[0]]
    const later = evaluateWan({
      interfaces: absent,
      mwan3: null,
      memory: first.memory,
      now: at(23 * 60),
      forgetHours: 24,
    })
    assert.property(later.memory, 'lan2')
    // Absent: not evaluated (neither up nor down).
    assert.deepEqual(
      later.wans.map((w) => w.network),
      ['wan']
    )
    const gone = evaluateWan({
      interfaces: absent,
      mwan3: null,
      memory: later.memory,
      now: at(24 * 60 + 5),
      forgetHours: 24,
    })
    assert.notProperty(gone.memory, 'lan2')

    const forgotten = evaluateWan({
      interfaces: [iface('wan', { device: 'wan0', up: false }), LIVE[1]],
      mwan3: null,
      memory: first.memory,
      now: at(5),
      forgetHours: 24,
      forgotten: new Set(['wan']),
    })
    assert.notProperty(forgotten.memory, 'wan')
    assert.isFalse(forgotten.wans.some((w) => w.network === 'wan'))
  })

  test('public address change from one non-empty value to another', ({ assert }) => {
    const first = evaluateWan({
      interfaces: LIVE,
      mwan3: null,
      memory: {},
      now: T0,
      forgetHours: 24,
    })
    assert.deepEqual(first.ipChanges, [])
    // Down (no address) keeps the last one; back with a new one: a change.
    const down = evaluateWan({
      interfaces: [iface('wan', { device: 'wan0', up: false }), LIVE[1]],
      mwan3: null,
      memory: first.memory,
      now: at(1),
      forgetHours: 24,
    })
    assert.deepEqual(down.ipChanges, [])
    const back = evaluateWan({
      interfaces: [
        iface('wan', { device: 'wan0', defaultRoute: true, metric: 1, ipv4: ['203.0.113.77/20'] }),
        LIVE[1],
      ],
      mwan3: null,
      memory: down.memory,
      now: at(2),
      forgetHours: 24,
    })
    assert.deepEqual(back.ipChanges, [{ network: 'wan', from: '203.0.113.10', to: '203.0.113.77' }])
  })

  test('the memory is stable tick to tick (no state write per tick)', ({ assert }) => {
    const first = evaluateWan({
      interfaces: LIVE,
      mwan3: null,
      memory: {},
      now: T0,
      forgetHours: 24,
    })
    const next = evaluateWan({
      interfaces: LIVE,
      mwan3: null,
      memory: first.memory as WanMemory,
      now: new Date(T0.getTime() + 15_000),
      forgetHours: 24,
    })
    assert.deepEqual(next.memory, first.memory)
  })
})

// ── ports ──────────────────────────────────────────────────────────────────

test.group('alerts detectors | ports', () => {
  const WINDOW = 15 * 60_000
  const m = (minutes: number) => T0.getTime() + minutes * 60_000

  test('link state from carrier, else operstate', ({ assert }) => {
    assert.isTrue(portIsDown(false, 'up'))
    assert.isFalse(portIsDown(true, 'down'))
    assert.isTrue(portIsDown(null, 'lowerlayerdown'))
    assert.isTrue(portIsDown(null, 'down'))
    assert.isFalse(portIsDown(null, 'up'))
    assert.isFalse(portIsDown(null, null))
  })

  test('flapping: 6 changes within 15 min hold; stable for a window clears', ({ assert }) => {
    const b = newBaseline(103, m(0))
    const holds = (nowMs: number, wasHolding: boolean, counter: number) => {
      const { rise } = observeCounter(b, counter, nowMs, WINDOW)
      return flappingHolds({
        rise,
        changes: 6,
        lastMoveAt: b.lastMoveAt,
        nowMs,
        windowMs: WINDOW,
        wasHolding,
      })
    }
    assert.isFalse(holds(m(1), false, 105))
    assert.isFalse(holds(m(2), false, 107))
    assert.isTrue(holds(m(3), false, 109))
    // Still moving a little: stays raised.
    assert.isTrue(holds(m(10), true, 110))
    // Quiet for less than a window: still raised.
    assert.isTrue(holds(m(24), true, 110))
    // Quiet for a whole window since the last move (m(10)): clears.
    assert.isFalse(holds(m(25), true, 110))
  })

  test('the window slides: slow changes never add up to a flap', ({ assert }) => {
    const b = newBaseline(0, m(0))
    let raised = false
    for (let i = 1; i <= 20; i++) {
      const { rise } = observeCounter(b, i, m(i * 4), WINDOW)
      raised ||= rise >= 6
    }
    // One change every 4 minutes = at most 4 in any 15-minute window.
    assert.isFalse(raised)
  })

  test('a decrease is a counter reset: re-baseline, no rise', ({ assert }) => {
    const b = newBaseline(103, m(0))
    observeCounter(b, 108, m(1), WINDOW)
    const { rise, reset } = observeCounter(b, 2, m(2), WINDOW)
    assert.isTrue(reset)
    assert.equal(rise, 0)
    assert.isNull(b.lastMoveAt)
    assert.equal(observeCounter(b, 4, m(3), WINDOW).rise, 2)
  })

  test('a counter that appears late (agent upgrade) is a baseline, not a rise', ({ assert }) => {
    const b = newBaseline(null, m(0))
    assert.equal(observeCounter(b, 103, m(1), WINDOW).rise, 0)
    assert.equal(observeCounter(b, 104, m(2), WINDOW).rise, 1)
  })

  test('resume after a restart: within the window keep it, else re-baseline', ({ assert }) => {
    const persisted = newBaseline(100, m(0))
    observeCounter(persisted, 104, m(1), WINDOW)
    persisted.persistedAt = m(2)
    const resumed = resumeBaseline(persisted, 106, m(5), WINDOW)
    assert.equal(observeCounter(resumed, 106, m(5), WINDOW).rise, 6)
    const stale = resumeBaseline(persisted, 106, m(30), WINDOW)
    assert.equal(observeCounter(stale, 106, m(30), WINDOW).rise, 0)
    const reset = resumeBaseline(persisted, 3, m(5), WINDOW)
    assert.equal(reset.value, 3)
  })

  test('speed degraded once per drop, below the best of the last 7 days', ({ assert }) => {
    const b = newBaseline(0, m(0))
    assert.isNull(observeSpeed(b, 1000, true, m(0)))
    assert.equal(observeSpeed(b, 100, true, m(1)), 1000)
    // Same degraded speed: once.
    assert.isNull(observeSpeed(b, 100, true, m(2)))
    // Link down: nothing.
    assert.isNull(observeSpeed(b, null, false, m(3)))
    assert.isNull(observeSpeed(b, 1000, true, m(4)))
    assert.equal(observeSpeed(b, 100, true, m(5)), 1000)
    // Eight days later the old best is forgotten.
    assert.isNull(observeSpeed(b, 100, true, m(8 * 24 * 60)))
  })
})

test.group('alerts detectors | gateway, portal', () => {
  test('drift and conflict per gateway with counts and five examples', ({ assert }) => {
    const rows = Array.from({ length: 7 }, (_, i) => ({
      gatewayId: 1,
      status: 'drift' as const,
      config: 'dhcp',
      section: `s${i}`,
      domain: 'dhcp',
      driftSince: `2026-09-30T00:0${i}:00Z`,
    }))
    const out = summarizeSections([
      ...rows,
      {
        gatewayId: 1,
        status: 'conflict',
        config: 'firewall',
        section: 'r1',
        domain: null,
        driftSince: null,
      },
    ])
    const drift = out.find((o) => o.status === 'drift')!
    assert.equal(drift.sections, 7)
    assert.lengthOf(drift.examples, 5)
    assert.equal(drift.since, '2026-09-30T00:00:00Z')
    assert.equal(out.find((o) => o.status === 'conflict')!.sections, 1)
  })

  test('AP groups: failed / rolled_back hold, applied clears, the rest leave it', ({ assert }) => {
    assert.isTrue(groupsFailedHolds('failed'))
    assert.isTrue(groupsFailedHolds('rolled_back'))
    assert.isFalse(groupsFailedHolds('applied'))
    for (const state of ['offline', 'waiting', 'sending', 'pending_confirm', 'unsupported']) {
      assert.isNull(groupsFailedHolds(state))
    }
  })

  test('portal not enforcing', ({ assert }) => {
    assert.isTrue(portalNotEnforcing('error', 0))
    assert.isTrue(portalNotEnforcing('waiting_device', 0))
    assert.isFalse(portalNotEnforcing('active', 0))
    assert.isTrue(portalNotEnforcing('active', 3))
    assert.isFalse(portalNotEnforcing('disabled', 5))
    assert.isNull(portalNotEnforcing('unknown', 0))
    assert.isNull(portalNotEnforcing(null, 0))
  })

  test('terminals: offline after 90 s; error only in a fresh report', ({ assert }) => {
    assert.deepEqual(
      terminalConditions({ silentSeconds: 91, statusAgeSeconds: 91, error: 'jam' }),
      {
        offline: true,
        error: false,
      }
    )
    assert.deepEqual(
      terminalConditions({ silentSeconds: 10, statusAgeSeconds: 10, error: 'jam' }),
      {
        offline: false,
        error: true,
      }
    )
    assert.deepEqual(
      terminalConditions({ silentSeconds: 10, statusAgeSeconds: 200, error: 'jam' }),
      {
        offline: false,
        error: false,
      }
    )
    assert.deepEqual(terminalConditions({ silentSeconds: 10, statusAgeSeconds: 10, error: '' }), {
      offline: false,
      error: false,
    })
  })
})

test.group('alerts detectors | scan mappers', () => {
  test('rolled back without a user is an alert; an admin revert is not', ({ assert }) => {
    const row = {
      id: 92,
      gatewayId: 1,
      event: 'rolled_back',
      applyId: 1,
      revision: 42,
      userId: null,
      detail: JSON.stringify({ applyId: 'g1-x', reason: 'confirm_timeout', discardedConfigs: [] }),
    }
    const input = mapGatewayEvent(row)!
    assert.equal(input.type, 'gateway.apply_rolled_back')
    assert.equal(input.dedupeKey, 'gateway.apply_rolled_back:1')
    assert.deepEqual(input.subject, { kind: 'gateway', id: 1 })
    assert.equal(input.phase, 'instant')
    assert.include(input.payload!, { reason: 'confirm_timeout', revision: 42, applyKey: 'g1-x' })
    assert.isNull(mapGatewayEvent({ ...row, userId: 3 }))
    assert.isNull(
      mapGatewayEvent({ ...row, detail: JSON.stringify({ applyId: 'g1-x', requested: true }) })
    )
    assert.isNull(mapGatewayEvent({ ...row, event: 'applied' }))
  })

  test('the other config-plane events', ({ assert }) => {
    const base = { id: 5, gatewayId: 2, applyId: 9, revision: null, userId: null }
    assert.equal(
      mapGatewayEvent({ ...base, event: 'failed', detail: '{"error":"x","message":"boom"}' })!
        .dedupeKey,
      'gateway.apply_failed:9'
    )
    assert.equal(
      mapGatewayEvent({ ...base, event: 'expired', detail: '{}', queueExpiryHours: 24 })!.payload!
        .queueExpiryHours,
      24
    )
    assert.equal(
      mapGatewayEvent({ ...base, event: 'pairing_lost', detail: '{"keyId":"k1"}' })!.dedupeKey,
      'gateway.pairing_lost:k1'
    )
    assert.equal(
      mapGatewayEvent({
        ...base,
        event: 'section_ambiguous',
        detail: '{"config":"firewall","section":"cfg1"}',
      })!.type,
      'gateway.section_ambiguous'
    )
    assert.equal(
      mapGatewayEvent({ ...base, event: 'unmodeled_changed', detail: '{}' })!.type,
      'gateway.unmodeled_changed'
    )
  })

  test('hotspot rows: never a guest MAC; amounts in major units and as text', ({ assert }) => {
    assert.deepEqual(checkoutAmount({ amount: 500, currency: 'PHP', decimals: 2 }), {
      amount: 5,
      currency: 'PHP',
      amountText: 'PHP 5.00',
    })
    const unclaimed = mapCheckout({
      id: 7,
      kind: 'unclaimed',
      terminalId: 3,
      terminalExists: true,
      terminalName: 'Lobby',
      portalId: 2,
      portalName: 'Guests',
      amount: 500,
      currency: 'PHP',
      decimals: 2,
      reason: 'late',
      mac: '02:00:00:00:aa:01',
    })!
    assert.deepEqual(unclaimed.subject, { kind: 'terminal', id: 3 })
    assert.notProperty(unclaimed.payload!, 'mac')
    assert.equal(unclaimed.payload!.amountText, 'PHP 5.00')
    // The terminal is gone: its portal.
    assert.deepEqual(
      mapCheckout({ id: 8, kind: 'unclaimed', terminalId: 3, terminalExists: false, portalId: 2 })!
        .subject,
      { kind: 'portal', id: 2 }
    )
    assert.equal(
      mapCheckout({ id: 9, kind: 'payment', portalId: 2, amount: 100 })!.type,
      'hotspot.payment'
    )
    assert.isNull(mapCheckout({ id: 10, kind: 'refund', portalId: 2 }))
  })

  test('portal events', ({ assert }) => {
    const rejected = mapPortalEvent({
      id: 1,
      gatewayId: 1,
      type: 'checkout_rejected',
      detail: '{"reason":"bad_signature","checkoutRef":"c-1"}',
    })!
    assert.equal(rejected.type, 'hotspot.checkout_rejected')
    assert.include(rejected.payload!, { reason: 'bad_signature', checkoutRef: 'c-1' })
    const quota = mapPortalEvent({
      id: 2,
      gatewayId: 1,
      type: 'shaping_quota_exhausted',
      portalId: 4,
      grantId: 11,
      mac: '02:00:00:00:aa:01',
    })!
    assert.deepEqual(quota.subject, { kind: 'portal', id: 4 })
    assert.notProperty(quota.payload!, 'mac')
    assert.deepEqual(
      mapPortalEvent({ id: 3, gatewayId: 1, type: 'shaping_quota_exhausted', portalId: null })!
        .subject,
      { kind: 'gateway', id: 1 }
    )
    assert.equal(
      mapPortalEvent({ id: 4, gatewayId: 1, type: 'external_auth_reverted', portalId: 4 })!.type,
      'portal.external_auth'
    )
    assert.isNull(mapPortalEvent({ id: 5, gatewayId: 1, type: 'grant_lost' }))
  })

  test('pending collectors and AP joins', ({ assert }) => {
    const pending = mapPendingCollector({
      id: 4,
      lifecycle: 'pending',
      hostname: 'router',
      version: '1.1.0',
      announcedBaseUrl: 'http://192.168.1.1:9800',
    })!
    assert.equal(pending.type, 'collector.pending')
    assert.equal(pending.payload!.address, '192.168.1.1')
    assert.isNull(mapPendingCollector({ id: 5, lifecycle: 'adopted' }))
    assert.equal(mapApJoined({ id: 3, name: 'First Floor AP' }).type, 'ap.joined')
  })
})
