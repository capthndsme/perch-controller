import {
  _resetQosLive,
  classRateKey,
  computeRates,
  handleQosEvent,
  MAX_EVENTS,
  MAX_LIVE_COLLECTORS,
  MAX_REPORT_CLASSES,
  parseQosReport,
  qosLive,
  routerPaused,
  wanQueueLive,
  type QosReport,
} from '#services/qos_live'
import { parseProbe } from '#services/qos_sync'
import { test } from '@japa/runner'

const MAC = '02:00:00:00:00:21'

function klass(id: string, dir: 'down' | 'up', bytes: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    key: `d:${MAC}`,
    dir,
    rateKbit: 64,
    ceilKbit: 2000,
    bytes,
    packets: bytes / 1000,
    drops: 0,
    overlimits: 0,
    backlogBytes: 0,
    ...extra,
  }
}

function report(fields: Partial<Record<keyof QosReport, unknown>> = {}): QosReport {
  return parseQosReport({ epoch: 'e', state: 'active', ...fields })!
}

test.group('qos_live | parseQosReport', () => {
  test('absent or not an object = not reported', ({ assert }) => {
    assert.isNull(parseQosReport(undefined))
    assert.isNull(parseQosReport(null))
    assert.isNull(parseQosReport([]))
    assert.isNull(parseQosReport('active'))
  })

  test('a full section parses into the contract shape', ({ assert }) => {
    const parsed = parseQosReport({
      epoch: 1727000000,
      state: 'paused',
      pausedBy: 'router',
      configRevision: 7,
      devicesRevision: 12,
      wan: [
        {
          device: 'wan',
          egress: { kind: 'cake', bandwidthKbit: 10000, bytes: 5, packets: 1, drops: 0 },
          ingress: null,
        },
      ],
      classes: [klass('1:2A0', 'down', 1000), { ...klass('1:12', 'up', 1), key: 'b:12' }],
      devices: [{ mac: '02-00-00-00-00-21', classId: '1:2a0', network: 'lan', dynamic: false }],
      quotas: [{ mac: MAC, usedBytes: 10, limitBytes: 100, exhausted: false }],
      schedules: [{ name: 's7', active: true, since: '2026-09-23T18:00:00Z', until: null }],
      errors: [{ code: 'pool_exhausted', detail: 'guest: 1024 classes', device: 'br-guest' }],
    })!
    assert.deepEqual(parsed, {
      epoch: '1727000000',
      state: 'paused',
      pausedBy: 'router',
      configRevision: 7,
      devicesRevision: 12,
      wan: [
        {
          device: 'wan',
          section: null,
          egress: {
            kind: 'cake',
            bandwidthKbit: 10000,
            bytes: 5,
            packets: 1,
            drops: 0,
            overlimits: 0,
            backlogBytes: 0,
            ecnMarks: null,
            peakDelayUs: null,
          },
          ingress: null,
        },
      ],
      classes: [
        {
          id: '1:2a0',
          key: `d:${MAC}`,
          dir: 'down',
          rateKbit: 64,
          ceilKbit: 2000,
          bytes: 1000,
          packets: 1,
          drops: 0,
          overlimits: 0,
          backlogBytes: 0,
        },
        {
          id: '1:12',
          key: 'b:12',
          dir: 'up',
          rateKbit: 64,
          ceilKbit: 2000,
          bytes: 1,
          packets: 0,
          drops: 0,
          overlimits: 0,
          backlogBytes: 0,
        },
      ],
      devices: [{ mac: MAC, classId: '1:2a0', network: 'lan', dynamic: false, state: null }],
      quotas: [{ mac: MAC, usedBytes: 10, limitBytes: 100, exhausted: false }],
      schedules: [{ name: 's7', active: true, since: '2026-09-23T18:00:00Z', until: null }],
      errors: [{ code: 'pool_exhausted', detail: 'guest: 1024 classes', device: 'br-guest' }],
    })
    // perch-collector sends revisions of UCI origin as strings.
    assert.equal(parseQosReport({ configRevision: '42' })!.configRevision, 42)
    assert.isNull(parseQosReport({ configRevision: 'abc' })!.configRevision)
  })

  test('malformed items are dropped one by one; unknown state reads active', ({ assert }) => {
    const parsed = parseQosReport({
      state: 'weird',
      devicesRevision: -1,
      classes: [
        klass('1:200', 'down', 1),
        klass('nope', 'down', 1),
        { ...klass('1:201', 'down', 1), key: 'x:1' },
        { ...klass('1:202', 'down', 1), dir: 'sideways' },
        { ...klass('1:203', 'down', 1), bytes: -5, packets: 'many' },
        'garbage',
      ],
      devices: [{ mac: 'not-a-mac' }, { mac: MAC, classId: 'zz' }, { mac: MAC }],
      quotas: [{ mac: 'x' }, { mac: MAC, usedBytes: 1.9, limitBytes: 3 }],
      errors: [{ detail: 'no code' }],
      wan: [{ egress: {} }],
    })!
    assert.equal(parsed.epoch, '')
    assert.equal(parsed.state, 'active')
    assert.isNull(parsed.devicesRevision)
    assert.deepEqual(
      parsed.classes.map((c) => [c.id, c.bytes, c.packets]),
      [
        ['1:200', 1, 0],
        ['1:203', 0, 0],
      ]
    )
    assert.deepEqual(parsed.devices, [
      { mac: MAC, classId: null, network: null, dynamic: false, state: null },
    ])
    assert.deepEqual(parsed.quotas, [{ mac: MAC, usedBytes: 1, limitBytes: 3, exhausted: false }])
    assert.lengthOf(parsed.errors, 0)
    assert.lengthOf(parsed.wan, 0)
  })

  test('lists are capped at the protocol limits', ({ assert }) => {
    const classes = Array.from({ length: MAX_REPORT_CLASSES + 10 }, (_, i) =>
      klass(`1:${(0x200 + i).toString(16)}`, 'down', i)
    )
    assert.lengthOf(parseQosReport({ classes })!.classes, MAX_REPORT_CLASSES)
  })
})

test.group('qos_live | routerPaused', () => {
  test("perch-collector's config / local, and the generic forms", ({ assert }) => {
    const paused = (pausedBy: string | null) =>
      parseQosReport({ epoch: 'e', state: 'paused', pausedBy })!
    assert.isFalse(routerPaused(null, false))
    assert.isTrue(routerPaused(paused('local'), true))
    assert.isTrue(routerPaused(paused('router'), false))
    assert.isTrue(routerPaused(paused('config'), false), 'globals.enabled 0 edited on the router')
    assert.isFalse(routerPaused(paused('config'), true), "the controller's own pause")
    assert.isFalse(routerPaused(paused('controller'), false))
    assert.isTrue(routerPaused(paused(null), false))
    assert.isFalse(routerPaused(parseQosReport({ epoch: 'e', state: 'active' }), false))
  })
})

test.group('qos_live | computeRates', () => {
  const at = 1_000_000

  test('kbit/s from byte deltas, drop share from packet deltas', ({ assert }) => {
    const before = report({
      classes: [klass('1:200', 'down', 1_000_000, { packets: 1000, drops: 0 })],
      wan: [{ device: 'wan', egress: { kind: 'cake', bytes: 0 } }],
    })
    const now = report({
      classes: [klass('1:200', 'down', 2_250_000, { packets: 1990, drops: 10 })],
      wan: [{ device: 'wan', egress: { kind: 'cake', bytes: 625_000 } }],
    })
    const rates = computeRates(now, at + 5000, { report: before, receivedAt: at })
    assert.deepEqual(rates.classes.get(classRateKey('1:200', 'down')), { kbit: 2000, dropPct: 1 })
    assert.deepEqual(rates.wan.get('wan|egress'), { kbit: 1000 })
  })

  test('null on the first report, a new epoch, a counter reset or an odd gap', ({ assert }) => {
    const before = report({ classes: [klass('1:200', 'down', 5000)] })
    const later = report({ classes: [klass('1:200', 'down', 10_000)] })
    const key = classRateKey('1:200', 'down')
    assert.isNull(computeRates(later, at, null).classes.get(key)!.kbit)
    const epoch = parseQosReport({ epoch: 'other', classes: [klass('1:200', 'down', 10_000)] })!
    assert.isNull(
      computeRates(epoch, at + 5000, { report: before, receivedAt: at }).classes.get(key)!.kbit
    )
    const reset = report({ classes: [klass('1:200', 'down', 10)] })
    assert.isNull(
      computeRates(reset, at + 5000, { report: before, receivedAt: at }).classes.get(key)!.kbit
    )
    assert.isNull(
      computeRates(later, at + 200, { report: before, receivedAt: at }).classes.get(key)!.kbit
    )
    assert.isNull(
      computeRates(later, at + 10 * 60_000, { report: before, receivedAt: at }).classes.get(key)!
        .kbit
    )
    // Down and up of the same class id are separate.
    const both = report({ classes: [klass('1:200', 'down', 10_000), klass('1:200', 'up', 0)] })
    const rates = computeRates(both, at + 5000, { report: before, receivedAt: at })
    assert.equal(rates.classes.get(key)!.kbit, 8)
    assert.isNull(rates.classes.get(classRateKey('1:200', 'up'))!.kbit)
  })

  test('wanQueueLive maps the report onto QosWanQueue.live', ({ assert }) => {
    assert.isNull(wanQueueLive(null, 'wan'))
  })
})

test.group('qos_live | events and bounds', (group) => {
  group.each.setup(() => _resetQosLive())

  test('the event ring keeps the last MAX_EVENTS; malformed events are dropped', async ({
    assert,
  }) => {
    for (let i = 0; i < MAX_EVENTS + 5; i++) {
      await handleQosEvent(1, { type: 'apply_failed', at: `t${i}`, detail: { i } })
    }
    assert.isNull(await handleQosEvent(1, { type: '' }))
    assert.isNull(await handleQosEvent(1, 'nope'))
    const events = qosLive(1)!.events
    assert.lengthOf(events, MAX_EVENTS)
    assert.equal(events[0].at, 't5')
    // Oversized detail is replaced by null.
    const big = await handleQosEvent(1, { type: 'apply_failed', detail: 'x'.repeat(5000) })
    assert.isNull(big!.detail)
  })

  test('live state is bounded to MAX_LIVE_COLLECTORS (oldest first out)', async ({ assert }) => {
    for (let id = 1; id <= MAX_LIVE_COLLECTORS + 3; id++) {
      await handleQosEvent(id, { type: 'local_pause' })
    }
    assert.isNull(qosLive(1))
    assert.isNull(qosLive(3))
    assert.isNotNull(qosLive(4))
    assert.isNotNull(qosLive(MAX_LIVE_COLLECTORS + 3))
  })
})

test.group('qos_sync | parseProbe', () => {
  test('normalises a probe answer and tolerates missing parts', ({ assert }) => {
    assert.isNull(parseProbe(null))
    assert.isNull(parseProbe([1]))
    const probe = parseProbe(
      {
        sqm: { installed: true, version: '1.6.0', queues: ['wan', 3] },
        kernel: { htb: true, cake: 'yes', flower: false },
        conflicts: ['qosify'],
        lanDevices: [{ network: 'lan', device: 'br-lan', prefixes: ['192.168.1.0/24'] }, {}],
      },
      '2026-09-23T00:00:00Z'
    )
    assert.deepEqual(probe, {
      sqm: { installed: true, version: '1.6.0', luci: false, queues: ['wan'] },
      kernel: { htb: true, flower: false },
      conflicts: ['qosify'],
      flowOffload: { software: false, hardware: false },
      lanDevices: [{ network: 'lan', device: 'br-lan', prefixes: ['192.168.1.0/24'] }],
      timezone: null,
      clockSynced: null,
      configured: null,
      tc: null,
      at: '2026-09-23T00:00:00Z',
    })
    const extra = parseProbe({
      tz: 'Asia/Manila',
      clockSynced: true,
      configured: false,
      tc: 'tiny',
    })!
    assert.containsSubset(extra, {
      timezone: 'Asia/Manila',
      clockSynced: true,
      configured: false,
      tc: 'tiny',
    })
  })
})
