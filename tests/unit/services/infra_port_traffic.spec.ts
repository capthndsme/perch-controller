import { MAX_BUCKET_DELTA_BYTES } from '#services/bucket_writer'
import { PORT_RATE_MAX_GAP_MS, PortTrafficTracker, splitDelta } from '#services/infra_port_traffic'
import {
  extractPortCounters,
  normalizePortReport,
  reportFingerprint,
  type PortCounters,
} from '#services/infra_ports'
import { test } from '@japa/runner'

const SLOT = 300_000
/** Some slot start, as epoch ms. */
const S = 1_790_000_100 * 1000 - ((1_790_000_100 * 1000) % SLOT)

const counters = (rxBytes: number, txBytes: number, scope: PortCounters['scope'] = 'port') => ({
  rxBytes,
  txBytes,
  scope,
})

test.group('infra_port_traffic | splitDelta', () => {
  test('an interval inside one slot goes to that slot', ({ assert }) => {
    assert.deepEqual(splitDelta(1000, 50, S + 10_000, S + 15_000), [
      { slotMs: S, rx: 1000, tx: 50 },
    ])
    // Ending exactly on the slot's end still belongs to it.
    assert.deepEqual(splitDelta(7, 3, S + 295_000, S + SLOT), [{ slotMs: S, rx: 7, tx: 3 }])
  })

  test('an interval over two slots is split by time, the last slot takes the remainder', ({
    assert,
  }) => {
    // 2 s in the first slot, 3 s in the second.
    assert.deepEqual(splitDelta(1001, 10, S + 298_000, S + 303_000), [
      { slotMs: S, rx: 400, tx: 4 },
      { slotMs: S + SLOT, rx: 601, tx: 6 },
    ])
  })

  test('the parts of a long interval add up to the delta', ({ assert }) => {
    const parts = splitDelta(999_999, 123_457, S + 1_000, S + 3_600_000)
    assert.lengthOf(parts, 12)
    assert.equal(
      parts.reduce((sum, part) => sum + part.rx, 0),
      999_999
    )
    assert.equal(
      parts.reduce((sum, part) => sum + part.tx, 0),
      123_457
    )
    assert.deepEqual(
      parts.map((part) => part.slotMs),
      Array.from({ length: 12 }, (_, i) => S + i * SLOT)
    )
  })

  test('more than an hour goes to the slot of the report', ({ assert }) => {
    assert.deepEqual(splitDelta(5, 6, S, S + 3_600_001), [{ slotMs: S + 12 * SLOT, rx: 5, tx: 6 }])
  })
})

test.group('infra_port_traffic | PortTrafficTracker', () => {
  test('the first sample gives nothing; the next gives parts and a rate in bits per second', ({
    assert,
  }) => {
    const tracker = new PortTrafficTracker()
    assert.deepEqual(tracker.observe(1, counters(1000, 5000), S + 10_000), {
      parts: [],
      rate: null,
    })
    assert.isTrue(tracker.hasSample(1))
    const next = tracker.observe(1, counters(3500, 5100), S + 15_000)
    assert.deepEqual(next.parts, [{ slotMs: S, rx: 2500, tx: 100 }])
    assert.deepEqual(next.rate, { rxBps: 4000, txBps: 160, scope: 'port', atMs: S + 15_000 })
    assert.deepEqual(tracker.rate(1), next.rate)
    assert.deepEqual([...tracker.rates().keys()], [1])
  })

  test('a counter that went backwards is a reset: new baseline, no delta, no rate', ({
    assert,
  }) => {
    const tracker = new PortTrafficTracker()
    tracker.observe(1, counters(1000, 5000), S)
    tracker.observe(1, counters(2000, 6000), S + 5_000)
    assert.isNotNull(tracker.rate(1))

    assert.deepEqual(tracker.observe(1, counters(10, 6500), S + 10_000), { parts: [], rate: null })
    assert.isNull(tracker.rate(1))
    // Counted again from the new baseline.
    assert.deepEqual(tracker.observe(1, counters(60, 6600), S + 15_000).parts, [
      { slotMs: S, rx: 50, tx: 100 },
    ])
  })

  test('a scope change is a new baseline', ({ assert }) => {
    const tracker = new PortTrafficTracker()
    tracker.observe(1, counters(1000, 5000, 'cpu'), S)
    assert.deepEqual(tracker.observe(1, counters(9000, 9000, 'port'), S + 5_000), {
      parts: [],
      rate: null,
    })
    assert.equal(tracker.observe(1, counters(9100, 9000, 'port'), S + 10_000).rate?.scope, 'port')
  })

  test('a delta the guard refuses is dropped', ({ assert }) => {
    const tracker = new PortTrafficTracker()
    tracker.observe(1, counters(0, 0), S)
    assert.deepEqual(tracker.observe(1, counters(MAX_BUCKET_DELTA_BYTES + 1, 0), S + 5_000), {
      parts: [],
      rate: null,
    })
    // The sample moved on: the next delta is small again.
    assert.deepEqual(
      tracker.observe(1, counters(MAX_BUCKET_DELTA_BYTES + 11, 0), S + 10_000).parts,
      [{ slotMs: S, rx: 10, tx: 0 }]
    )
  })

  test('two samples too far apart are accounted but give no rate', ({ assert }) => {
    const tracker = new PortTrafficTracker()
    tracker.observe(1, counters(0, 0), S)
    const late = tracker.observe(1, counters(600, 0), S + PORT_RATE_MAX_GAP_MS + 1_000)
    assert.isNull(late.rate)
    assert.equal(
      late.parts.reduce((sum, part) => sum + part.rx, 0),
      600
    )
    assert.isNotNull(tracker.observe(1, counters(700, 0), S + PORT_RATE_MAX_GAP_MS + 6_000).rate)
  })

  test('no counters drops the rate and keeps the sample', ({ assert }) => {
    const tracker = new PortTrafficTracker()
    tracker.observe(1, counters(0, 0), S)
    tracker.observe(1, counters(100, 100), S + 5_000)
    assert.deepEqual(tracker.observe(1, null, S + 10_000), { parts: [], rate: null })
    assert.isNull(tracker.rate(1))
    // The link comes back: the delta since the kept sample is counted.
    assert.deepEqual(tracker.observe(1, counters(150, 100), S + 15_000).parts, [
      { slotMs: S, rx: 50, tx: 0 },
    ])
  })

  test('a report not later than the last sample changes nothing', ({ assert }) => {
    const tracker = new PortTrafficTracker()
    tracker.observe(1, counters(0, 0), S + 10_000)
    const rate = tracker.observe(1, counters(100, 0), S + 15_000).rate
    assert.deepEqual(tracker.observe(1, counters(999, 999), S + 12_000), { parts: [], rate })
    assert.deepEqual(tracker.observe(1, counters(200, 0), S + 20_000).parts, [
      { slotMs: S, rx: 100, tx: 0 },
    ])
  })

  test('the tracker is bounded, the least recently reported port evicted first', ({ assert }) => {
    const tracker = new PortTrafficTracker(2)
    tracker.observe(1, counters(0, 0), S)
    tracker.observe(2, counters(0, 0), S)
    tracker.observe(1, counters(1, 1), S + 5_000)
    tracker.observe(3, counters(0, 0), S)
    assert.isTrue(tracker.hasSample(1))
    assert.isFalse(tracker.hasSample(2))
    assert.isTrue(tracker.hasSample(3))
  })
})

test.group('infra_ports | extractPortCounters', () => {
  test('keeps both counters and the scope, by lowercased name', ({ assert }) => {
    const found = extractPortCounters([
      { name: 'LAN1', rxBytes: 17260817141, txBytes: 275427536004, counterScope: 'port' },
      { name: 'lan2', rxBytes: 0, txBytes: 5, counterScope: 'cpu' },
      { name: 'wan', rxBytes: 1, txBytes: 2 },
    ])
    assert.deepEqual(
      [...found.entries()],
      [
        ['lan1', { rxBytes: 17260817141, txBytes: 275427536004, scope: 'port' }],
        ['lan2', { rxBytes: 0, txBytes: 5, scope: 'cpu' }],
        ['wan', { rxBytes: 1, txBytes: 2, scope: null }],
      ]
    )
  })

  test('a port without both valid counters maps to null; a bad scope to null', ({ assert }) => {
    const found = extractPortCounters([
      { name: 'a', rxBytes: 1 },
      { name: 'b', rxBytes: -1, txBytes: 2 },
      { name: 'c', rxBytes: 1.5, txBytes: 2 },
      { name: 'd', rxBytes: '1', txBytes: 2 },
      { name: 'e', rxBytes: 2 ** 53, txBytes: 2 },
      { name: 'f', rxBytes: 1, txBytes: 2, counterScope: 'switch' },
      { name: 'g', carrier: false },
    ])
    assert.deepEqual(
      [...found.entries()],
      [
        ['a', null],
        ['b', null],
        ['c', null],
        ['d', null],
        ['e', null],
        ['f', { rxBytes: 1, txBytes: 2, scope: null }],
        ['g', null],
      ]
    )
  })

  test('skips bad entries and the second of a case-insensitive pair', ({ assert }) => {
    const found = extractPortCounters([
      null,
      'lan1',
      { name: '-bad', rxBytes: 1, txBytes: 1 },
      { name: 'lan1', rxBytes: 1, txBytes: 1 },
      { name: 'LAN1', rxBytes: 9, txBytes: 9 },
    ])
    assert.deepEqual([...found.entries()], [['lan1', { rxBytes: 1, txBytes: 1, scope: null }]])
  })

  test('counters leave the port report and its fingerprint alone', ({ assert }) => {
    const plain = [{ name: 'lan1', carrier: true, speedMbps: 1000 }]
    const counted = [{ ...plain[0], rxBytes: 123, txBytes: 456, counterScope: 'port' }]
    assert.deepEqual(normalizePortReport(counted), normalizePortReport(plain))
    assert.equal(
      reportFingerprint(normalizePortReport(counted)),
      reportFingerprint(normalizePortReport(plain))
    )
  })
})
