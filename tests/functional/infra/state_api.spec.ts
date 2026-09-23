import Collector from '#models/collector'
import { apiKeyFingerprint } from '#services/collector_announce'
import { saveDeviceLabel } from '#services/device_labels'
import { recordAgentPorts } from '#services/infra_ports'
import { updatePresenceSettings } from '#services/presence_settings'
import { eventually, seedSetupComplete } from '#tests/helpers/ap_agent'
import { FakeCollector, TEST_API_KEY, TEST_INSTANCE_ID } from '#tests/helpers/collector_agent'
import {
  apPorts,
  closeAgentSessions,
  nodeFor,
  onlineAp,
  portReport,
  resetInfraTests,
  seedGatewayCollector,
  seedLink,
  seedManualNode,
  seedScrapeAp,
  setLastSeen,
} from '#tests/helpers/infra'
import db from '@adonisjs/lucid/services/db'
import type { ApiClient } from '@japa/api-client'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

const STATE = '/api/v1/infra/state'
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/

async function stateOf(client: ApiClient, token: string) {
  const response = await client.get(STATE).bearerToken(token)
  response.assertStatus(200)
  return response.body().data
}

/** The entry of a state array with this id (response bodies are untyped JSON). */
function byId(items: Array<{ id: number }>, id: number): any {
  const found = items.find((item) => item.id === id)
  if (!found) throw new Error(`no entry ${id}`)
  return found
}

test.group('infra | state', (group) => {
  group.each.setup(resetInfraTests)
  group.each.teardown(closeAgentSessions)

  test('an agent AP: online while connected and fresh, stale past its bound, then offline', async ({
    client,
    assert,
  }) => {
    const { operatorToken } = await seedSetupComplete()
    const ap = await onlineAp(
      'ap-garage',
      '02:00:00:00:00:10',
      apPorts({ lan3: { carrier: false } })
    )

    const online = await stateOf(client, operatorToken)
    assert.match(online.generatedAt, ISO)
    const node = byId(online.nodes, ap.nodeId)
    assert.deepInclude(node, { status: 'online', live: true, version: '0.1.0', presence: null })
    assert.match(node.lastSeenAt, ISO)
    const lan1 = byId(online.ports, ap.ports.lan1)
    assert.deepEqual(lan1, {
      id: ap.ports.lan1,
      nodeId: ap.nodeId,
      present: true,
      live: true,
      up: true,
      adminUp: true,
      operstate: 'up',
      speedMbps: 1000,
      duplex: 'full',
      carrierChanges: null,
      changedAt: lan1.changedAt,
      derivedFrom: null,
    })
    assert.match(lan1.changedAt, ISO)
    assert.deepInclude(byId(online.ports, ap.ports.lan3), {
      live: true,
      up: false,
      speedMbps: null,
    })

    // 15 s interval: silent after max(3 × 15 s, 30 s) = 45 s.
    await setLastSeen('wifi_access_points', ap.apId, 50)
    const stale = await stateOf(client, operatorToken)
    assert.deepInclude(byId(stale.nodes, ap.nodeId), { status: 'stale', live: false })
    // Not live, but the last state stays (the dashboard greys it).
    assert.deepInclude(byId(stale.ports, ap.ports.lan1), { live: false, up: true, speedMbps: 1000 })

    // The bound is Settings → Presence's, read per request.
    await updatePresenceSettings({ apStaleIntervals: 10 })
    const longer = await stateOf(client, operatorToken)
    assert.equal(byId(longer.nodes, ap.nodeId).status, 'online')

    await ap.agent.close()
    const offline = await eventually(
      () => stateOf(client, operatorToken),
      (state) => byId(state.nodes, ap.nodeId).status === 'offline'
    )
    assert.isFalse(byId(offline.nodes, ap.nodeId).live)
  })

  test('scraped APs and polled collectors: online while the last poll is good and fresh', async ({
    client,
    assert,
  }) => {
    const { operatorToken } = await seedSetupComplete()
    const scrape = await seedScrapeAp('ap-attic')
    const good = JSON.stringify({ ok: true, checkedAt: DateTime.utc().toISO() })
    await db.from('wifi_access_points').where('id', scrape.id).update({ last_status: good })
    await setLastSeen('wifi_access_points', scrape.id, 10)
    const gateway = await seedGatewayCollector({ version: '0.2.0' })
    await setLastSeen('collectors', gateway.id, 10)
    await client.get('/api/v1/infra/layout').bearerToken(operatorToken)
    const scrapeRow = await nodeFor({ apId: scrape.id })
    const gatewayRow = await nodeFor({ collectorId: gateway.id })
    const scrapeNode = Number(scrapeRow.id)
    const gatewayNode = Number(gatewayRow.id)

    const fresh = await stateOf(client, operatorToken)
    assert.deepInclude(byId(fresh.nodes, scrapeNode), { status: 'online', version: null })
    assert.deepInclude(byId(fresh.nodes, gatewayNode), { status: 'online', version: '0.2.0' })

    // Past the bound: 45 s for a 15 s AP, the 30 s floor for a 5 s collector.
    await setLastSeen('wifi_access_points', scrape.id, 50)
    await setLastSeen('collectors', gateway.id, 31)
    const old = await stateOf(client, operatorToken)
    assert.equal(byId(old.nodes, scrapeNode).status, 'offline')
    assert.equal(byId(old.nodes, gatewayNode).status, 'offline')

    // Fresh, but the last poll failed.
    await gateway.refresh()
    gateway.lastStatus = { ...gateway.lastStatus!, ok: false, error: 'connect ECONNREFUSED' }
    await gateway.save()
    await setLastSeen('collectors', gateway.id, 5)
    const failed = await stateOf(client, operatorToken)
    assert.equal(byId(failed.nodes, gatewayNode).status, 'offline')
  })

  test('a socket collector: online, stale, offline', async ({ client, assert }) => {
    const { operatorToken } = await seedSetupComplete()
    const row = await Collector.create({
      name: 'gateway',
      baseUrl: null,
      transport: 'agent',
      instanceId: TEST_INSTANCE_ID,
      source: 'announced',
      lifecycle: 'adopted',
      enabled: true,
      pollIntervalSeconds: 5,
      apiKey: TEST_API_KEY,
      apiKeyFingerprint: apiKeyFingerprint(TEST_API_KEY),
      lastStatus: null,
    })
    await recordAgentPorts(
      { type: 'collector', id: row.id },
      [portReport('lan0', { role: 'lan', medium: 'virtual', speedMbps: 10000 })],
      DateTime.utc()
    )
    const nodeRow = await nodeFor({ collectorId: row.id })
    const nodeId = Number(nodeRow.id)
    const collector = await FakeCollector.connect()
    await collector.hello()
    await collector.waitFor('agent.configure')

    await setLastSeen('collectors', row.id, 5)
    const online = await stateOf(client, operatorToken)
    assert.deepInclude(byId(online.nodes, nodeId), {
      status: 'online',
      live: true,
      version: '0.2.0',
    })
    await setLastSeen('collectors', row.id, 31)
    const stale = await stateOf(client, operatorToken)
    assert.equal(byId(stale.nodes, nodeId).status, 'stale')

    await collector.close()
    await eventually(
      () => stateOf(client, operatorToken),
      (state) => byId(state.nodes, nodeId).status === 'offline'
    )
  })

  test('manual nodes are unmanaged; a node whose agent row is gone is detached', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const sw = await seedManualNode('switch', 'Switch', ['1'])
    const detached = await seedManualNode('access_point', 'Old AP', ['wan'], { origin: 'agent' })
    const state = await stateOf(client, adminToken)
    assert.deepEqual(byId(state.nodes, sw.id), {
      id: sw.id,
      status: 'unmanaged',
      live: false,
      lastSeenAt: null,
      version: null,
      presence: null,
    })
    assert.equal(byId(state.nodes, detached.id).status, 'detached')
    assert.deepEqual(byId(state.ports, sw.ports['1']), {
      id: sw.ports['1'],
      nodeId: sw.id,
      present: true,
      live: false,
      up: null,
      adminUp: null,
      operstate: null,
      speedMbps: null,
      duplex: null,
      carrierChanges: null,
      changedAt: null,
      derivedFrom: null,
    })
  })

  test('a manual port shows the live agent port at the far end of its cable', async ({
    client,
    assert,
  }) => {
    const { operatorToken } = await seedSetupComplete()
    const ap = await onlineAp(
      'ap-garage',
      '02:00:00:00:00:10',
      apPorts({ lan2: { speedMbps: 100 } })
    )
    const sw = await seedManualNode('switch', 'Switch', ['1', '2', '3'])
    const upLink = await seedLink(sw.ports['1'], ap.ports.lan1)
    await seedLink(sw.ports['2'], ap.ports.lan2)

    const state = await stateOf(client, operatorToken)
    const derived = byId(state.ports, sw.ports['1'])
    assert.deepInclude(derived, {
      live: true,
      up: true,
      speedMbps: 1000,
      duplex: 'full',
      adminUp: null,
      operstate: null,
      carrierChanges: null,
      derivedFrom: upLink,
    })
    assert.match(derived.changedAt, ISO)
    assert.equal(byId(state.ports, sw.ports['2']).speedMbps, 100)
    assert.deepInclude(byId(state.ports, sw.ports['3']), {
      live: false,
      up: null,
      derivedFrom: null,
    })

    // The AP goes silent: nothing to derive from.
    await setLastSeen('wifi_access_points', ap.apId, 600)
    const silent = await stateOf(client, operatorToken)
    assert.deepInclude(byId(silent.ports, sw.ports['1']), {
      live: false,
      up: null,
      speedMbps: null,
      derivedFrom: null,
    })
    assert.deepInclude(byId(silent.links, upLink), { state: 'unknown', speedMbps: null })
  })

  test('cable state: up, down, unknown, and mismatch when the agent ends disagree', async ({
    client,
    assert,
  }) => {
    const { operatorToken } = await seedSetupComplete()
    const one = await onlineAp('ap-garage', '02:00:00:00:00:10', apPorts())
    const two = await onlineAp('ap-porch', '02:00:00:00:00:30', apPorts())
    const sw = await seedManualNode('switch', 'Switch', ['1', '2'])
    const between = await seedLink(one.ports.lan1, two.ports.wan)
    const toSwitch = await seedLink(one.ports.lan2, sw.ports['1'])
    const pc = await seedManualNode('device', 'PC', ['eth0'])
    const manualOnly = await seedLink(sw.ports['2'], pc.ports.eth0)
    const report = (apId: number, ports: unknown[]) =>
      recordAgentPorts({ type: 'ap', id: apId }, ports, DateTime.utc())

    let state = await stateOf(client, operatorToken)
    assert.deepEqual(byId(state.links, between), {
      id: between,
      state: 'up',
      speedMbps: 1000,
      detail: null,
    })
    assert.deepInclude(byId(state.links, toSwitch), { state: 'up', speedMbps: 1000 })
    assert.deepInclude(byId(state.links, manualOnly), { state: 'unknown', speedMbps: null })

    await report(two.apId, apPorts({ wan: { speedMbps: 100 } }))
    state = await stateOf(client, operatorToken)
    assert.deepEqual(byId(state.links, between), {
      id: between,
      state: 'mismatch',
      speedMbps: 100,
      detail: 'speed',
    })

    await report(two.apId, apPorts({ wan: { carrier: false } }))
    state = await stateOf(client, operatorToken)
    assert.deepInclude(byId(state.links, between), { state: 'mismatch', detail: 'carrier' })

    await report(one.apId, apPorts({ lan1: { carrier: false }, lan2: { carrier: false } }))
    state = await stateOf(client, operatorToken)
    assert.deepEqual(byId(state.links, between), {
      id: between,
      state: 'down',
      speedMbps: null,
      detail: null,
    })
    assert.deepInclude(byId(state.links, toSwitch), { state: 'down' })
    assert.deepInclude(byId(state.ports, sw.ports['1']), { live: true, up: false })

    // One end silent: the live end decides.
    await report(one.apId, apPorts())
    await setLastSeen('wifi_access_points', two.apId, 600)
    state = await stateOf(client, operatorToken)
    assert.deepInclude(byId(state.links, between), { state: 'up', detail: null })
  })

  test('a device node carries the presence /devices/:mac/presence reports', async ({
    client,
    assert,
  }) => {
    const { operatorToken } = await seedSetupComplete()
    const [collector] = await Collector.all()
    const mac = '02:00:00:00:00:21'
    await db.rawQuery(
      `INSERT INTO device_identities (collector_id, mac, primary_ip, ips, first_seen_at, last_seen_at, created_at)
       VALUES (?, ?, '192.168.1.20', '["192.168.1.20"]', UTC_TIMESTAMP() - INTERVAL 1 HOUR,
               UTC_TIMESTAMP() - INTERVAL 2 MINUTE, UTC_TIMESTAMP())`,
      [collector.id, mac]
    )
    const nas = await seedManualNode('device', 'NAS', ['eth0'], { device_mac: mac })
    const other = await seedManualNode('device', 'Unknown', ['eth0'], {
      device_mac: '02:00:00:00:00:99',
    })

    const expected = await client.get(`/api/v1/devices/${mac}/presence`).bearerToken(operatorToken)
    expected.assertStatus(200)
    const state = await stateOf(client, operatorToken)
    const presence = byId(state.nodes, nas.id).presence
    // The presence endpoint also says where the map puts the device; the node's
    // presence is the rule's answer alone.
    const { lastSeenAt, attachment, ...rest } = expected.body().data
    assert.deepEqual(attachment, { nodeId: nas.id, nodeName: 'NAS', uplink: null })
    // Same rule, same inputs; each request fixes "now" itself (ages are whole seconds).
    assert.deepEqual({ ...presence, lastSeenAt: undefined }, { ...rest, lastSeenAt: undefined })
    assert.isBelow(Math.abs(Date.parse(presence.lastSeenAt) - Date.parse(lastSeenAt)), 2000)
    assert.deepInclude(presence, { status: 'connected', via: 'lan' })
    assert.deepEqual(byId(state.nodes, other.id).presence, {
      status: 'disconnected',
      via: 'lan',
      lastSeenAt: null,
    })

    await saveDeviceLabel(mac, { connection: 'ethernet' })
    const marked = await stateOf(client, operatorToken)
    assert.deepInclude(byId(marked.nodes, nas.id).presence, {
      status: 'connected',
      via: 'ethernet',
    })
  })

  test('both reads are revalidated on every poll, never kept', async ({ client, assert }) => {
    const { operatorToken } = await seedSetupComplete()
    for (const path of ['/api/v1/infra/layout', STATE]) {
      const response = await client.get(path).bearerToken(operatorToken)
      response.assertStatus(200)
      assert.equal(response.header('cache-control'), 'private, no-cache', path)
      assert.exists(response.header('etag'), path)
    }
  })
})
