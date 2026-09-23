import Collector from '#models/collector'
import { handleCollectorPush } from '#services/collector_agent'
import { apiKeyFingerprint } from '#services/collector_announce'
import { pollOnce } from '#services/collector_poller'
import { eventually, seedSetupComplete } from '#tests/helpers/ap_agent'
import {
  FakeCollector,
  TEST_API_KEY,
  TEST_INSTANCE_ID,
  device,
  reading,
} from '#tests/helpers/collector_agent'
import {
  closeAgentSessions,
  nodeFor,
  portReport,
  portRows,
  resetInfraTests,
} from '#tests/helpers/infra'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

const MAC = '02:00:00:00:00:20'
const T0 = DateTime.utc().minus({ minutes: 10 }).startOf('second')

/** A router in a container: its ports are veths (docs/infrastructure-view.md section 2). */
function gatewayPorts(overrides: { lanCarrier?: boolean } = {}) {
  return [
    portReport('wan0', {
      role: 'wan',
      medium: 'virtual',
      speedMbps: 10000,
      mac: '02:00:00:00:00:31',
    }),
    portReport('lan0', {
      role: 'lan',
      medium: 'virtual',
      speedMbps: 10000,
      mac: '02:00:00:00:00:32',
      carrier: overrides.lanCarrier ?? true,
    }),
  ]
}

/** A gateway report (section 4.3), with `ports` only when given (older collectors send none). */
function gatewayReport(ports?: unknown) {
  return {
    collectedAt: '2026-09-23T11:17:10Z',
    conntrack: { entries: 2495, limit: 262144 },
    tcpEstablished: 2,
    load: { load1: 1.44, load5: 1.1, load15: 1.49 },
    memory: { totalBytes: 15637843968, availableBytes: 15525001216 },
    wan: [{ name: 'wan0', rxBytes: 693974698743, txBytes: 1697321558462 }],
    wanSource: 'default-route',
    ...(ports === undefined ? {} : { ports }),
  }
}

/** An adopted socket collector, as if adopted earlier. */
async function seedSocketCollector() {
  return Collector.create({
    name: 'gateway',
    baseUrl: null,
    transport: 'agent',
    instanceId: TEST_INSTANCE_ID,
    source: 'announced',
    lifecycle: 'adopted',
    enabled: true,
    pollIntervalSeconds: 5,
    version: '0.3.0',
    apiKey: TEST_API_KEY,
    apiKeyFingerprint: apiKeyFingerprint(TEST_API_KEY),
    lastStatus: null,
  })
}

async function seedPolledCollector() {
  return Collector.create({
    name: 'gateway',
    baseUrl: 'http://192.168.1.1:9800',
    transport: 'poll',
    source: 'manual',
    lifecycle: 'adopted',
    enabled: true,
    pollIntervalSeconds: 5,
    version: '0.3.0',
    apiKey: null,
    lastStatus: null,
  })
}

/** A polled collector's /summary (with the gateway report) and /devices. */
function fetcherFor(gateway: Record<string, unknown> | null): typeof fetch {
  const params = reading([device(MAC, { bytesIn: 1000, bytesOut: 2000 })])
  return (async (url: Parameters<typeof fetch>[0]) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '')
    const body =
      path === '/api/v1/summary'
        ? { summary: params.summary, meta: params.meta, ...(gateway ? { gateway } : {}) }
        : path === '/api/v1/devices'
          ? { devices: params.devices }
          : null
    if (body === null) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

async function pushReading(collectorId: number, seconds: number, gateway: Record<string, unknown>) {
  return handleCollectorPush(
    collectorId,
    reading([device(MAC, { bytesIn: 1000 + seconds, bytesOut: 2000 })], { gateway }),
    { receivedAt: T0.plus({ seconds }) }
  )
}

async function gatewayNodeId(collectorId: number): Promise<number> {
  const node = await nodeFor({ collectorId })
  if (!node) throw new Error(`collector ${collectorId} has no node`)
  return Number(node.id)
}

test.group('infra | port ingest from the Gateway agent', (group) => {
  group.each.setup(resetInfraTests)
  group.each.teardown(closeAgentSessions)

  test('ports in a collector.push create the gateway node and its rows', async ({ assert }) => {
    const row = await seedSocketCollector()
    const collector = await FakeCollector.connect()
    await collector.hello()
    await collector.waitFor('agent.configure')

    collector.notifyServer(
      'collector.push',
      reading([device(MAC, { bytesIn: 1, bytesOut: 1 })], {
        gateway: gatewayReport(gatewayPorts()),
      })
    )
    // The collector row is saved after the ports: once it says so, both are in.
    const fresh = await eventually(
      () => Collector.findOrFail(row.id),
      (current) => current.lastStatus?.gateway?.portsReported === true
    )
    assert.deepEqual(fresh.lastStatus?.gateway?.wanInterfaces, ['wan0'])

    const node = await nodeFor({ collectorId: row.id })
    assert.equal(node.kind, 'gateway')
    assert.equal(node.origin, 'agent')
    const ports = await portRows(Number(node.id))
    assert.deepEqual(Object.keys(ports), ['wan0', 'lan0'])
    assert.equal(ports.wan0.reported_role, 'wan')
    assert.equal(ports.wan0.reported_medium, 'virtual')
    assert.equal(ports.wan0.speed_mbps, 10000)
    assert.equal(ports.lan0.mac, '02:00:00:00:00:32')
    await collector.close()
  })

  test('the HTTP poll path writes the same rows', async ({ assert }) => {
    const collector = await seedPolledCollector()
    const outcome = await pollOnce(collector, {
      now: () => T0,
      fetcher: fetcherFor(gatewayReport(gatewayPorts())),
    })
    assert.equal(outcome.status, 'baseline')

    const ports = await portRows(await gatewayNodeId(collector.id))
    assert.deepEqual(Object.keys(ports), ['wan0', 'lan0'])
    assert.equal(Number(ports.lan0.carrier), 1)
    await collector.refresh()
    assert.isTrue(collector.lastStatus?.gateway?.portsReported)

    // A later poll with a changed carrier updates the row.
    await pollOnce(collector, {
      now: () => T0.plus({ seconds: 10 }),
      fetcher: fetcherFor(gatewayReport(gatewayPorts({ lanCarrier: false }))),
    })
    const after = await portRows(await gatewayNodeId(collector.id))
    assert.equal(Number(after.lan0.carrier), 0)
  })

  test('an old collector (no ports key) writes nothing and reads portsSupported null', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const row = await seedSocketCollector()
    await row.merge({ version: '0.2.0' }).save()

    const outcome = await pushReading(row.id, 0, gatewayReport())
    assert.equal(outcome.status, 'ingested')
    assert.isNull(await nodeFor({ collectorId: row.id }), 'the push creates no node')
    await row.refresh()
    assert.isDefined(row.lastStatus?.gateway)
    assert.isUndefined(row.lastStatus?.gateway?.portsReported)

    // The layout brings the Gateway agent's node along, without ports.
    const layout = await client.get('/api/v1/infra/layout').bearerToken(adminToken)
    layout.assertStatus(200)
    const body = layout.body().data
    const node = body.nodes.find((n: any) => n.binding?.type === 'collector')
    assert.equal(node.kind, 'gateway')
    assert.deepEqual(node.binding, {
      type: 'collector',
      id: row.id,
      name: 'gateway',
      transport: 'agent',
      version: '0.2.0',
      portsSupported: null,
    })
    assert.deepEqual(node.ports, [])
    assert.isTrue(node.isRoot)
    assert.equal(body.rootNodeId, node.id)
  })

  test('once a report carries ports, portsSupported is true; an older report erases nothing', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const row = await seedSocketCollector()
    await pushReading(row.id, 0, gatewayReport(gatewayPorts()))
    const nodeId = await gatewayNodeId(row.id)
    const before = await db.from('infra_ports').where('node_id', nodeId).orderBy('id')

    const layout = await client.get('/api/v1/infra/layout').bearerToken(adminToken)
    const node = layout.body().data.nodes.find((n: any) => n.id === nodeId)
    assert.isTrue(node.binding.portsSupported)
    assert.deepEqual(
      node.ports.map((port: any) => [port.key, port.role, port.medium, port.origin]),
      [
        ['wan0', 'wan', 'virtual', 'agent'],
        ['lan0', 'lan', 'virtual', 'agent'],
      ]
    )

    // The collector is downgraded: its reports have no ports any more.
    await pushReading(row.id, 10, gatewayReport())
    assert.deepEqual(await db.from('infra_ports').where('node_id', nodeId).orderBy('id'), before)
    await row.refresh()
    assert.isUndefined(row.lastStatus?.gateway?.portsReported)
    const again = await client.get('/api/v1/infra/layout').bearerToken(adminToken)
    const stale = again.body().data.nodes.find((n: any) => n.id === nodeId)
    assert.isNull(stale.binding.portsSupported)
    assert.lengthOf(stale.ports, 2)
  })

  test('a collector without gateway stats gets no node', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const collector = await seedPolledCollector()
    await pollOnce(collector, { now: () => T0, fetcher: fetcherFor(null) })

    const layout = await client.get('/api/v1/infra/layout').bearerToken(adminToken)
    layout.assertStatus(200)
    assert.deepEqual(layout.body().data.nodes, [])
    assert.isNull(layout.body().data.rootNodeId)
  })
})
