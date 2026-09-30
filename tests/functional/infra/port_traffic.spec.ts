import Collector from '#models/collector'
import { handleMetricsPush } from '#services/ap_agent_metrics'
import { handleCollectorPush } from '#services/collector_agent'
import { apiKeyFingerprint } from '#services/collector_announce'
import { recordPortTraffic } from '#services/infra_port_traffic'
import { recordAgentPorts, type PortBinding } from '#services/infra_ports'
import { seedAgentAp, seedSetupComplete } from '#tests/helpers/ap_agent'
import { TEST_API_KEY, TEST_INSTANCE_ID, device, reading } from '#tests/helpers/collector_agent'
import {
  apPorts,
  closeAgentSessions,
  metricsPush,
  nodeFor,
  onlineAp,
  portReport,
  resetInfraTests,
  seedLink,
  seedManualNode,
  setLastSeen,
} from '#tests/helpers/infra'
import db from '@adonisjs/lucid/services/db'
import type { ApiClient } from '@japa/api-client'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

/**
 * Port traffic (docs/infrastructure-view.md, amendment A6): counters in the
 * agents' port reports, the rates of `/infra/state`, the accounting rows and
 * the three traffic reads. Placeholder MACs only.
 */

const STATE = '/api/v1/infra/state'

/** A port entry with byte counters, as perch-apd / perch-collector send it since A6. */
function counted(
  name: string,
  rxBytes: number,
  txBytes: number,
  scope: 'port' | 'cpu' = 'port',
  fields: Parameters<typeof portReport>[1] = {}
) {
  return { ...portReport(name, fields), rxBytes, txBytes, counterScope: scope }
}

/**
 * The four `apPorts()` ports with counters on those named in `values`
 * (`[rxBytes, txBytes, scope?]`). A report always names every port: one it
 * leaves out is marked missing, and pruned when nothing holds it.
 */
function apCounted(
  values: Record<string, [number, number, ('port' | 'cpu')?]>,
  overrides: Parameters<typeof apPorts>[0] = {}
) {
  return apPorts(overrides).map((port) => {
    const value = values[port.name]
    return value
      ? { ...port, rxBytes: value[0], txBytes: value[1], counterScope: value[2] ?? 'port' }
      : port
  })
}

/** One report the way both ingest paths make it: the ports, then their counters. */
async function report(binding: PortBinding, ports: unknown[], at: DateTime) {
  const recorded = await recordAgentPorts(binding, ports, at)
  if (!recorded) throw new Error('report wrote nothing')
  await recordPortTraffic(recorded.nodeId, ports, at, { portsChanged: recorded.changed > 0 })
  return recorded.nodeId
}

/** An agent AP with the four `apPorts()` ports, not connected (enough for the reads). */
async function agentAp(name: string, mac: string) {
  const { ap } = await seedAgentAp({ name, macs: [mac] })
  const binding = { type: 'ap' as const, id: ap.id }
  const nodeId = await report(binding, apPorts(), DateTime.utc().minus({ hours: 3 }))
  const rows = await db.from('infra_ports').where('node_id', nodeId)
  return {
    binding,
    nodeId,
    ports: Object.fromEntries(rows.map((row) => [row.port_key, Number(row.id)])),
  }
}

function iso(at: DateTime): string {
  return new Date(at.toMillis()).toISOString()
}

async function stateOf(client: ApiClient, token: string) {
  const response = await client.get(STATE).bearerToken(token)
  response.assertStatus(200)
  return response.body().data
}

function byId(items: Array<{ id: number }>, id: number): any {
  const found = items.find((item) => item.id === id)
  if (!found) throw new Error(`no entry ${id}`)
  return found
}

/** A 5-minute slot start an hour ago, plus a minute: every report of a test lands in the past. */
const SLOT = 300
const T = DateTime.fromSeconds(Math.floor((Date.now() / 1000 - 3600) / SLOT) * SLOT, {
  zone: 'utc',
})
const at = (seconds: number) => T.plus({ seconds })
/** The window of the read tests: two slots before T to three after (five buckets). */
const WINDOW = `from=${encodeURIComponent(at(-600).toISO()!)}&to=${encodeURIComponent(at(900).toISO()!)}`

test.group('infra | port traffic on /infra/state', (group) => {
  group.each.setup(resetInfraTests)
  group.each.teardown(closeAgentSessions)

  test('ports and cables carry their rate; a cable takes the larger end per direction', async ({
    client,
    assert,
  }) => {
    const { operatorToken } = await seedSetupComplete()
    const one = await onlineAp('ap-garage', '02:00:00:00:00:10', apPorts())
    const two = await onlineAp('ap-porch', '02:00:00:00:00:30', apPorts())
    const sw = await seedManualNode('switch', 'Switch', ['1', '2'])
    const between = await seedLink(one.ports.lan1, two.ports.wan)
    const toSwitch = await seedLink(one.ports.lan2, sw.ports['1'])
    const oneAp = { type: 'ap' as const, id: one.apId }
    const twoAp = { type: 'ap' as const, id: two.apId }

    const t1 = DateTime.utc().minus({ seconds: 10 })
    const t2 = t1.plus({ seconds: 5 })
    await report(oneAp, apCounted({ lan1: [0, 0], lan2: [0, 0, 'cpu'] }), t1)
    await report(twoAp, apCounted({ wan: [0, 0] }), t1)
    // 5 s later. one.lan1 sent 20 000 B, two.wan received only 15 000 of them;
    // two.wan sent 10 000 B, one.lan1 counted 5000.
    await report(oneAp, apCounted({ lan1: [5000, 20_000], lan2: [1000, 2000, 'cpu'] }), t2)
    await report(twoAp, apCounted({ wan: [15_000, 10_000] }), t2)

    const state = await stateOf(client, operatorToken)
    assert.deepEqual(byId(state.ports, one.ports.lan1).traffic, {
      rxBps: 8000,
      txBps: 32_000,
      scope: 'port',
      at: iso(t2),
      derivedFrom: null,
    })
    assert.isNull(byId(state.ports, one.ports.wan).traffic, 'no counters')
    assert.deepEqual(byId(state.links, between).traffic, {
      aToBBps: 32_000,
      bToABps: 16_000,
      partial: false,
      at: iso(t2),
      ends: {
        a: { rxBps: 8000, txBps: 32_000, scope: 'port' },
        b: { rxBps: 24_000, txBps: 16_000, scope: 'port' },
      },
    })
    // One measuring end, and it only sees the CPU's frames.
    assert.deepEqual(byId(state.links, toSwitch).traffic, {
      aToBBps: 3200,
      bToABps: 1600,
      partial: true,
      at: iso(t2),
      ends: { a: { rxBps: 1600, txBps: 3200, scope: 'cpu' }, b: null },
    })
    // The switch port sees the far end turned around.
    assert.deepEqual(byId(state.ports, sw.ports['1']).traffic, {
      rxBps: 3200,
      txBps: 1600,
      scope: 'cpu',
      at: iso(t2),
      derivedFrom: toSwitch,
    })
    assert.isNull(byId(state.ports, sw.ports['2']).traffic)

    // The porch AP goes silent: its end no longer measures.
    await setLastSeen('wifi_access_points', two.apId, 600)
    const silent = await stateOf(client, operatorToken)
    assert.isNull(byId(silent.ports, two.ports.wan).traffic)
    assert.deepInclude(byId(silent.links, between).traffic, {
      aToBBps: 32_000,
      bToABps: 8000,
      partial: false,
    })
    assert.isNull(byId(silent.links, between).traffic.ends.b)

    // one.lan1 loses its carrier (no counters): nothing measures the cable.
    await report(
      oneAp,
      apCounted({ lan2: [1000, 2000, 'cpu'] }, { lan1: { carrier: false } }),
      t2.plus({ seconds: 5 })
    )
    const down = await stateOf(client, operatorToken)
    assert.isNull(byId(down.ports, one.ports.lan1).traffic)
    assert.isNull(byId(down.links, between).traffic)
  })

  test('an agent without counters: no rates and no accounting rows', async ({ client, assert }) => {
    const { operatorToken } = await seedSetupComplete()
    const ap = await onlineAp('ap-garage', '02:00:00:00:00:10', apPorts())
    const binding = { type: 'ap' as const, id: ap.apId }
    await report(binding, apPorts(), DateTime.utc().minus({ seconds: 10 }))
    await report(binding, apPorts(), DateTime.utc().minus({ seconds: 5 }))

    const state = await stateOf(client, operatorToken)
    for (const id of Object.values(ap.ports)) assert.isNull(byId(state.ports, id).traffic)
    assert.lengthOf(await db.from('infra_port_buckets_5m'), 0)
    assert.lengthOf(await db.from('infra_port_buckets_hourly'), 0)
  })
})

test.group('infra | port counters through the ingest paths', (group) => {
  group.each.setup(resetInfraTests)
  group.each.teardown(closeAgentSessions)

  test('metrics.push: the counters become 5-minute and hourly rows', async ({ assert }) => {
    const { ap } = await seedAgentAp()
    await db.from('wifi_access_points').where('id', ap.id).update({ poll_interval_seconds: 1 })
    const push = (seq: number, rx: number, tx: number, seconds: number) =>
      handleMetricsPush(ap.id, metricsPush(seq, [counted('lan1', rx, tx)]), {
        receivedAt: at(seconds),
      })
    const first = await push(1, 1000, 2000, 60)
    const second = await push(2, 4000, 2500, 65)
    assert.equal(first.status, 'ingested')
    assert.equal(second.status, 'ingested')

    const node = await nodeFor({ apId: ap.id })
    const port = await db.from('infra_ports').where('node_id', node.id).first()
    const slots = await db.from('infra_port_buckets_5m').where('port_id', port.id)
    assert.lengthOf(slots, 1)
    assert.equal(Number(slots[0].rx_bytes), 3000)
    assert.equal(Number(slots[0].tx_bytes), 500)
    const hours = await db.from('infra_port_buckets_hourly').where('port_id', port.id)
    assert.lengthOf(hours, 1)
    assert.equal(Number(hours[0].rx_bytes), 3000)

    // A third push adds to the same slot.
    await push(3, 4100, 2600, 70)
    const again = await db.from('infra_port_buckets_5m').where('port_id', port.id).first()
    assert.equal(Number(again.rx_bytes), 3100)
    assert.equal(Number(again.tx_bytes), 600)
  })

  test('collector.push: the gateway ports count the same way', async ({ assert }) => {
    const row = await Collector.create({
      name: 'gateway',
      baseUrl: null,
      transport: 'agent',
      instanceId: TEST_INSTANCE_ID,
      source: 'announced',
      lifecycle: 'adopted',
      enabled: true,
      pollIntervalSeconds: 5,
      version: '1.1.0',
      apiKey: TEST_API_KEY,
      apiKeyFingerprint: apiKeyFingerprint(TEST_API_KEY),
      lastStatus: null,
    })
    const gateway = (rx: number, tx: number) => ({
      collectedAt: '2026-09-30T04:00:00Z',
      wan: [],
      wanSource: 'default-route',
      ports: [counted('lan0', rx, tx, 'port', { medium: 'virtual', speedMbps: 10000 })],
    })
    const push = (seq: number, rx: number, tx: number, seconds: number) =>
      handleCollectorPush(
        row.id,
        reading([device('02:00:00:00:00:20', { bytesIn: seq, bytesOut: seq })], {
          seq,
          gateway: gateway(rx, tx),
        }),
        { receivedAt: at(seconds) }
      )
    await push(1, 10_000, 20_000, 60)
    await push(2, 12_000, 20_700, 70)

    const node = await nodeFor({ collectorId: row.id })
    const port = await db.from('infra_ports').where('node_id', node.id).first()
    const slot = await db.from('infra_port_buckets_5m').where('port_id', port.id).first()
    assert.equal(Number(slot.rx_bytes), 2000)
    assert.equal(Number(slot.tx_bytes), 700)
  })
})

test.group('infra | port traffic reads', (group) => {
  group.each.setup(resetInfraTests)
  group.each.teardown(closeAgentSessions)

  test('a port: dense 5-minute points, totals and since', async ({ client, assert }) => {
    const { operatorToken } = await seedSetupComplete()
    const ap = await agentAp('ap-garage', '02:00:00:00:00:10')
    await report(ap.binding, apCounted({ lan1: [1000, 5000] }), at(60))
    await report(ap.binding, apCounted({ lan1: [4000, 5600] }), at(70))
    // Into the next slot.
    await report(ap.binding, apCounted({ lan1: [4300, 5700] }), at(310))

    const response = await client
      .get(`/api/v1/infra/ports/${ap.ports.lan1}/traffic?${WINDOW}`)
      .bearerToken(operatorToken)
    response.assertStatus(200)
    const data = response.body().data
    assert.deepInclude(data, {
      portId: ap.ports.lan1,
      nodeId: ap.nodeId,
      measuredBy: { portId: ap.ports.lan1, linkId: null },
      window: { from: at(-600).toISO(), to: at(900).toISO() },
      bucketSeconds: 300,
      source: '5m',
      since: iso(T),
      totals: { rxBytes: 3300, txBytes: 700 },
    })
    assert.lengthOf(data.points, 5)
    assert.deepEqual(
      data.points.map((p: any) => [p.bucketStart, p.seconds, p.rxBytes, p.txBytes]),
      [
        [iso(at(-600)), 300, 0, 0],
        [iso(at(-300)), 300, 0, 0],
        // 60 → 70 s, then 70 → 310 s split: 230 s in the first slot, 10 s in the next.
        [iso(T), 300, 3000 + 287, 600 + 95],
        [iso(at(300)), 300, 13, 5],
        [iso(at(600)), 300, 0, 0],
      ]
    )
    assert.equal(data.points[2].rxBps, Math.round(((3287 * 8) / 300) * 1000) / 1000)
  })

  test('a manual port is measured by the far end of its cable, turned around', async ({
    client,
    assert,
  }) => {
    const { operatorToken } = await seedSetupComplete()
    const ap = await agentAp('ap-garage', '02:00:00:00:00:10')
    const sw = await seedManualNode('switch', 'Switch', ['1', '2'])
    const linkId = await seedLink(ap.ports.lan2, sw.ports['1'])
    await report(ap.binding, apCounted({ lan2: [0, 0] }), at(60))
    await report(ap.binding, apCounted({ lan2: [100, 900] }), at(65))

    const measured = await client
      .get(`/api/v1/infra/ports/${sw.ports['1']}/traffic?${WINDOW}`)
      .bearerToken(operatorToken)
    measured.assertStatus(200)
    assert.deepInclude(measured.body().data, {
      measuredBy: { portId: ap.ports.lan2, linkId },
      totals: { rxBytes: 900, txBytes: 100 },
      since: iso(T),
    })

    const alone = await client
      .get(`/api/v1/infra/ports/${sw.ports['2']}/traffic?${WINDOW}`)
      .bearerToken(operatorToken)
    alone.assertStatus(200)
    const data = alone.body().data
    assert.deepInclude(data, { measuredBy: null, since: null, totals: { rxBytes: 0, txBytes: 0 } })
    assert.lengthOf(data.points, 5, 'still dense')

    // An agent port that never sent counters measures nothing either.
    const quiet = await client
      .get(`/api/v1/infra/ports/${ap.ports.lan3}/traffic?${WINDOW}`)
      .bearerToken(operatorToken)
    assert.isNull(quiet.body().data.measuredBy)
  })

  test('a cable: per bucket and direction the larger of its two ends', async ({
    client,
    assert,
  }) => {
    const { operatorToken } = await seedSetupComplete()
    const one = await agentAp('ap-garage', '02:00:00:00:00:10')
    const two = await agentAp('ap-porch', '02:00:00:00:00:30')
    const sw = await seedManualNode('switch', 'Switch', ['1'])
    const between = await seedLink(one.ports.lan1, two.ports.wan)
    const toSwitch = await seedLink(one.ports.lan2, sw.ports['1'])

    await report(one.binding, apCounted({ lan1: [0, 0], lan2: [0, 0] }), at(60))
    await report(two.binding, apCounted({ wan: [0, 0] }), at(60))
    // Slot T: one.lan1 sent 1000 (two.wan received 800); two.wan sent 50 (one.lan1 counted 70).
    await report(one.binding, apCounted({ lan1: [70, 1000], lan2: [5, 7] }), at(65))
    await report(two.binding, apCounted({ wan: [800, 50] }), at(65))
    // 65 → 360 s: 235 s in slot T, 60 s in the next. one.lan1 sent 100 more
    // (79 + 21), two.wan received 300 more (238 + 62).
    await report(one.binding, apCounted({ lan1: [70, 1100], lan2: [5, 7] }), at(360))
    await report(two.binding, apCounted({ wan: [1100, 50] }), at(360))

    const response = await client
      .get(`/api/v1/infra/links/${between}/traffic?${WINDOW}`)
      .bearerToken(operatorToken)
    response.assertStatus(200)
    const data = response.body().data
    assert.deepInclude(data, {
      linkId: between,
      measuredBy: { a: one.ports.lan1, b: two.ports.wan },
      bucketSeconds: 300,
      source: '5m',
      since: iso(T),
      // Slot T: a sent 1079, b received 1038; slot T+300: a sent 21, b received 62.
      totals: { aToBBytes: 1079 + 62, bToABytes: 70 },
    })
    assert.deepEqual(
      data.points.map((p: any) => [p.aToBBytes, p.bToABytes]),
      [
        [0, 0],
        [0, 0],
        [1079, 70],
        [62, 0],
        [0, 0],
      ]
    )
    assert.equal(data.points[2].aToBBps, Math.round(((1079 * 8) / 300) * 1000) / 1000)

    // One measuring end.
    const half = await client
      .get(`/api/v1/infra/links/${toSwitch}/traffic?${WINDOW}`)
      .bearerToken(operatorToken)
    assert.deepInclude(half.body().data, {
      measuredBy: { a: one.ports.lan2, b: null },
      totals: { aToBBytes: 7, bToABytes: 5 },
    })
  })

  test('a node: per-port totals in display order, manual ports through their cable', async ({
    client,
    assert,
  }) => {
    const { operatorToken } = await seedSetupComplete()
    const ap = await agentAp('ap-garage', '02:00:00:00:00:10')
    const sw = await seedManualNode('switch', 'Switch', ['1', '2'])
    const linkId = await seedLink(ap.ports.lan1, sw.ports['2'])
    await report(ap.binding, apCounted({ wan: [0, 0], lan1: [0, 0] }), at(60))
    await report(ap.binding, apCounted({ wan: [10, 20], lan1: [300, 400] }), at(65))

    const own = await client
      .get(`/api/v1/infra/nodes/${ap.nodeId}/traffic?${WINDOW}`)
      .bearerToken(operatorToken)
    own.assertStatus(200)
    const data = own.body().data
    assert.equal(data.nodeId, ap.nodeId)
    assert.equal(data.coveredFrom, at(-600).toISO())
    assert.deepEqual(data.ports, [
      {
        portId: ap.ports.wan,
        measuredBy: { portId: ap.ports.wan, linkId: null },
        rxBytes: 10,
        txBytes: 20,
      },
      {
        portId: ap.ports.lan1,
        measuredBy: { portId: ap.ports.lan1, linkId: null },
        rxBytes: 300,
        txBytes: 400,
      },
      { portId: ap.ports.lan2, measuredBy: null, rxBytes: 0, txBytes: 0 },
      { portId: ap.ports.lan3, measuredBy: null, rxBytes: 0, txBytes: 0 },
    ])

    // Longer than two days: the hourly rows, from the hour of the window start.
    const from = at(-3 * 86_400 - 90)
    const swWide = await client
      .get(
        `/api/v1/infra/nodes/${sw.id}/traffic?from=${encodeURIComponent(from.toISO()!)}&to=${encodeURIComponent(at(900).toISO()!)}`
      )
      .bearerToken(operatorToken)
    swWide.assertStatus(200)
    assert.equal(swWide.body().data.coveredFrom, from.startOf('hour').toISO())
    assert.deepEqual(swWide.body().data.ports, [
      { portId: sw.ports['1'], measuredBy: null, rxBytes: 0, txBytes: 0 },
      {
        portId: sw.ports['2'],
        measuredBy: { portId: ap.ports.lan1, linkId },
        rxBytes: 400,
        txBytes: 300,
      },
    ])
  })

  test('404 for an unknown port, cable or node; 422 for a bad window', async ({
    client,
    assert,
  }) => {
    const { operatorToken } = await seedSetupComplete()
    const port = await client.get('/api/v1/infra/ports/999999/traffic').bearerToken(operatorToken)
    port.assertStatus(404)
    assert.deepInclude(port.body(), { error: 'infra_port_not_found', portId: 999999 })
    const link = await client.get('/api/v1/infra/links/999999/traffic').bearerToken(operatorToken)
    link.assertStatus(404)
    assert.deepInclude(link.body(), { error: 'infra_link_not_found', linkId: 999999 })
    const node = await client.get('/api/v1/infra/nodes/999999/traffic').bearerToken(operatorToken)
    node.assertStatus(404)
    assert.deepInclude(node.body(), { error: 'infra_node_not_found', nodeId: 999999 })

    const ap = await agentAp('ap-garage', '02:00:00:00:00:10')
    const bad = await client
      .get(`/api/v1/infra/ports/${ap.ports.lan1}/traffic?from=yesterday`)
      .bearerToken(operatorToken)
    bad.assertStatus(422)
    assert.equal(bad.body().errors[0].field, 'from')
    const backwards = await client
      .get(
        `/api/v1/infra/links/1/traffic?from=${encodeURIComponent(at(60).toISO()!)}&to=${encodeURIComponent(at(0).toISO()!)}`
      )
      .bearerToken(operatorToken)
    backwards.assertStatus(422)
    assert.equal(backwards.body().errors[0].field, 'to')
    const resolution = await client
      .get(`/api/v1/infra/nodes/${ap.nodeId}/traffic?resolution=0`)
      .bearerToken(operatorToken)
    resolution.assertStatus(422)

    // The default window: the last 24 hours, 5-minute buckets.
    const standard = await client
      .get(`/api/v1/infra/ports/${ap.ports.lan1}/traffic`)
      .bearerToken(operatorToken)
    standard.assertStatus(200)
    assert.equal(bodyOf(standard).data.bucketSeconds, 300)
    assert.approximately(bodyOf(standard).data.points.length, 288, 1)

    const anonymous = await client.get(`/api/v1/infra/ports/${ap.ports.lan1}/traffic`)
    anonymous.assertStatus(401)
  })
})

/** Response bodies as untyped JSON (the registry types some of these routes as `void | …`). */
function bodyOf(response: { body(): unknown }): any {
  return response.body()
}
