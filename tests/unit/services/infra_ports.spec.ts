import {
  MAX_AGENT_PORTS,
  MAX_REMEMBERED_REPORTS,
  ReportFingerprints,
  normalizePort,
  normalizePortReport,
  recordAgentPorts,
  reportFingerprint,
} from '#services/infra_ports'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

const FULL = {
  name: 'lan1',
  label: 'lan1',
  role: 'lan',
  medium: 'copper',
  mac: '02:00:00:00:00:10',
  adminUp: true,
  carrier: true,
  operstate: 'up',
  speedMbps: 1000,
  duplex: 'full',
  carrierChanges: 3,
}

test.group('infra_ports | normalizePort', () => {
  test('keeps every field of a well-formed entry', ({ assert }) => {
    assert.deepEqual(normalizePort(FULL), FULL)
  })

  test('drops unknown fields and bad values field by field', ({ assert }) => {
    assert.deepEqual(
      normalizePort({
        ...FULL,
        label: 'x'.repeat(49),
        role: 'dmz',
        medium: 'coax',
        mac: 'not-a-mac',
        adminUp: 'yes',
        carrier: 1,
        operstate: 'x'.repeat(17),
        speedMbps: -1,
        duplex: 'unknown',
        carrierChanges: 2 ** 31,
        driver: 'mtk_soc_eth',
      }),
      { name: 'lan1' }
    )
    assert.deepEqual(normalizePort({ name: 'wan', speedMbps: 2.5 }), { name: 'wan' })
    assert.deepEqual(normalizePort({ name: 'wan', speedMbps: 1_000_001 }), { name: 'wan' })
    assert.deepEqual(normalizePort({ name: 'wan', speedMbps: 0 }), { name: 'wan' })
  })

  test('lowercases MACs and cleans labels', ({ assert }) => {
    assert.deepEqual(
      normalizePort({ name: 'eth1', mac: '02-00-00-00-00-AB', label: ' WAN\u0000 ' }),
      {
        name: 'eth1',
        label: 'WAN',
        mac: '02:00:00:00:00:ab',
      }
    )
  })

  test('an entry without a usable name is dropped', ({ assert }) => {
    for (const entry of [
      null,
      'lan1',
      42,
      ['lan1'],
      {},
      { name: '' },
      { name: '-lan' },
      { name: 'lan 1' },
      { name: 'x'.repeat(33) },
      { name: 7 },
    ]) {
      assert.isNull(normalizePort(entry), JSON.stringify(entry))
    }
    assert.deepEqual(normalizePort({ name: 'lan1@eth0' }), { name: 'lan1@eth0' })
    assert.deepEqual(normalizePort({ name: 'eth0.2' }), { name: 'eth0.2' })
  })
})

test.group('infra_ports | normalizePortReport', () => {
  test('caps the report at 64 ports and keeps the agent order', ({ assert }) => {
    const report = normalizePortReport(
      Array.from({ length: 65 }, (_, i) => ({ name: `lan${i + 1}` }))
    )
    assert.lengthOf(report, MAX_AGENT_PORTS)
    assert.equal(report[0].name, 'lan1')
    assert.equal(report[63].name, 'lan64')
  })

  test('drops junk entries and a second spelling of the same key', ({ assert }) => {
    const report = normalizePortReport([
      { name: 'wan', role: 'wan' },
      'junk',
      { label: 'no name' },
      { name: 'LAN1' },
      { name: 'lan1' },
      null,
      { name: 'lan2' },
    ])
    assert.deepEqual(
      report.map((port) => port.name),
      ['wan', 'LAN1', 'lan2']
    )
  })

  test('the fingerprint follows every field', ({ assert }) => {
    const base = normalizePortReport([FULL])
    assert.equal(reportFingerprint(base), reportFingerprint(normalizePortReport([{ ...FULL }])))
    assert.notEqual(
      reportFingerprint(base),
      reportFingerprint(normalizePortReport([{ ...FULL, carrier: false }]))
    )
    assert.notEqual(
      reportFingerprint(base),
      reportFingerprint(normalizePortReport([{ ...FULL, carrierChanges: 4 }]))
    )
  })
})

test.group('infra_ports | the last report per agent', () => {
  test('is bounded, evicting the least recently written agent', ({ assert }) => {
    const cache = new ReportFingerprints()
    assert.equal(cache.limit, MAX_REMEMBERED_REPORTS)
    for (let id = 1; id <= MAX_REMEMBERED_REPORTS + 1; id++) {
      cache.set(`ap:${id}`, { fingerprint: `f${id}`, nodeId: id })
    }
    assert.equal(cache.size, MAX_REMEMBERED_REPORTS)
    assert.isUndefined(cache.get('ap:1'))
    assert.deepEqual(cache.get('ap:2'), { fingerprint: 'f2', nodeId: 2 })
  })

  test('a write makes an agent the most recent', ({ assert }) => {
    const cache = new ReportFingerprints(2)
    cache.set('ap:1', { fingerprint: 'a', nodeId: 1 })
    cache.set('ap:2', { fingerprint: 'b', nodeId: 2 })
    cache.set('ap:1', { fingerprint: 'c', nodeId: 1 })
    cache.set('collector:1', { fingerprint: 'd', nodeId: 3 })
    assert.isUndefined(cache.get('ap:2'))
    assert.equal(cache.get('ap:1')?.fingerprint, 'c')
    cache.delete('ap:1')
    assert.isUndefined(cache.get('ap:1'))
    cache.clear()
    assert.equal(cache.size, 0)
  })

  test('a report that is not an array writes nothing', async ({ assert }) => {
    for (const ports of [undefined, null, {}, 'lan1', 42]) {
      assert.isNull(await recordAgentPorts({ type: 'ap', id: 1 }, ports, DateTime.utc()))
    }
  })
})
