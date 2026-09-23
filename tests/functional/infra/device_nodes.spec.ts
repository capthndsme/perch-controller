import { saveDeviceLabel } from '#services/device_labels'
import {
  resetHostnameEnrichmentCacheForTesting,
  setHostnameCommandRunnerForTesting,
} from '#services/hostname_enrichment'
import {
  HOSTNAME_ENRICHMENT_MODE,
  setHostnameEnrichmentSettings,
} from '#services/hostname_enrichment_settings'
import { _infraRowCounts } from '#services/infra_topology'
import { seedAgentAp, seedSetupComplete } from '#tests/helpers/ap_agent'
import {
  closeAgentSessions,
  nodeFor,
  resetInfraTests,
  seedDevice,
  seedGatewayCollector,
  seedLink,
  seedManualNode,
} from '#tests/helpers/infra'
import Collector from '#models/collector'
import db from '@adonisjs/lucid/services/db'
import type { ApiClient } from '@japa/api-client'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

/**
 * Amendment A4 items 1–4 (docs/infrastructure-view.md): which nodes carry a
 * device from Perch's device list, one node per device, names that follow the
 * device, and `linkTo` on create.
 */

const LAYOUT = '/api/v1/infra/layout'
const NODES = '/api/v1/infra/nodes'

function post(client: ApiClient, token: string, body: Record<string, unknown>) {
  return client.post(NODES).bearerToken(token).json(body)
}

function patch(client: ApiClient, token: string, id: number, body: Record<string, unknown>) {
  return client.patch(`${NODES}/${id}`).bearerToken(token).json(body)
}

async function created(client: ApiClient, token: string, body: Record<string, unknown>) {
  const response = await post(client, token, body)
  response.assertStatus(201)
  return response.body().data
}

async function layoutNode(client: ApiClient, token: string, id: number) {
  const response = await client.get(LAYOUT).bearerToken(token)
  response.assertStatus(200)
  return response.body().data.nodes.find((node: { id: number }) => node.id === id)
}

test.group('infra | devices on nodes', (group) => {
  group.each.setup(resetInfraTests)
  group.each.teardown(closeAgentSessions)
  group.each.teardown(() => {
    resetHostnameEnrichmentCacheForTesting()
    setHostnameCommandRunnerForTesting(null)
  })

  test('a device on every manual kind but the ISP line, never on an agent-bound node', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const kinds = ['device', 'switch', 'router', 'modem', 'host', 'access_point']
    for (const [i, kind] of kinds.entries()) {
      const mac = `02:00:00:00:01:${String(i).padStart(2, '0')}`
      const { node } = await created(client, adminToken, { kind, name: kind, deviceMac: mac })
      assert.equal(node.device.mac, mac, kind)
    }
    const isp = await post(client, adminToken, {
      kind: 'isp',
      name: 'ISP',
      deviceMac: '02:00:00:00:01:99',
    })
    isp.assertStatus(422)
    assert.deepInclude(isp.body(), { error: 'infra_field_not_applicable', field: 'deviceMac' })

    // PATCH: a switch drawn first, bound to its device later.
    const { node: sw } = await created(client, adminToken, { kind: 'switch', name: 'Desk' })
    const bound = await patch(client, adminToken, sw.id, { deviceMac: '02-00-00-00-01-AA' })
    bound.assertStatus(200)
    assert.equal(bound.body().data.node.device.mac, '02:00:00:00:01:aa')

    // Nodes bound to an agent stand for that agent.
    const { ap } = await seedAgentAp()
    const gateway = await seedGatewayCollector()
    await client.get(LAYOUT).bearerToken(adminToken)
    for (const row of [
      await nodeFor({ apId: ap.id }),
      await nodeFor({ collectorId: gateway.id }),
    ]) {
      const refused = await patch(client, adminToken, Number(row.id), {
        deviceMac: '02:00:00:00:01:bb',
      })
      refused.assertStatus(422)
      assert.deepInclude(refused.body(), {
        error: 'infra_field_not_applicable',
        field: 'deviceMac',
      })
      // Clearing is not setting: nothing to refuse.
      const cleared = await patch(client, adminToken, Number(row.id), { deviceMac: null })
      cleared.assertStatus(200)
    }
    // A detached AP node no longer stands for an agent: it may carry one.
    const detached = await seedManualNode('access_point', 'Old AP', ['wan'], { origin: 'agent' })
    const kept = await patch(client, adminToken, detached.id, { deviceMac: '02:00:00:00:01:cc' })
    kept.assertStatus(200)
    assert.deepInclude(kept.body().data.node, { detached: true })
    assert.equal(kept.body().data.node.device.mac, '02:00:00:00:01:cc')
  })

  test('one node per device: a MAC another node carries is 409 with that node', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const mac = '02:00:00:00:00:21'
    const { node: nas } = await created(client, adminToken, {
      kind: 'device',
      name: 'NAS',
      deviceMac: mac,
    })

    // Any spelling of the same MAC, on create or on PATCH.
    const again = await post(client, adminToken, {
      kind: 'switch',
      name: 'X',
      deviceMac: '02-00-00-00-00-21',
    })
    again.assertStatus(409)
    assert.deepEqual(again.body(), {
      error: 'infra_device_already_placed',
      message: again.body().message,
      nodeId: nas.id,
    })
    assert.isString(again.body().message)
    const { node: other } = await created(client, adminToken, { kind: 'device', name: 'Other' })
    const moved = await patch(client, adminToken, other.id, { deviceMac: '02:00:00:00:00:21' })
    moved.assertStatus(409)
    assert.deepInclude(moved.body(), { error: 'infra_device_already_placed', nodeId: nas.id })

    // Its own MAC again is no conflict; once released, another node may take it.
    const same = await patch(client, adminToken, nas.id, { deviceMac: mac })
    same.assertStatus(200)
    const released = await patch(client, adminToken, nas.id, { deviceMac: null })
    released.assertStatus(200)
    const taken = await patch(client, adminToken, other.id, { deviceMac: mac })
    taken.assertStatus(200)
    assert.equal(taken.body().data.node.device.mac, mac)

    // The unique index is the backstop, whatever writes the row; NULLs are many.
    const now = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')
    const row = { kind: 'device', origin: 'manual', created_at: now, updated_at: now }
    await db.table('infra_nodes').insert({ ...row, name: 'a' })
    await db.table('infra_nodes').insert({ ...row, name: 'b' })
    let refused: { code?: string } | null = null
    try {
      await db.table('infra_nodes').insert({ ...row, name: 'c', device_mac: '02:00:00:00:00:21' })
    } catch (error) {
      refused = error as { code?: string }
    }
    assert.equal(refused?.code, 'ER_DUP_ENTRY')
  })

  test('names follow the device: override, agent, label, hostname, MAC, kind', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const [collector] = await Collector.all()
    const mac = '02:00:00:00:00:41'

    // No name at all (a blank one is none): only with a device.
    for (const body of [{ kind: 'device' }, { kind: 'device', name: '   ' }]) {
      const nameless = await post(client, adminToken, body)
      nameless.assertStatus(422)
      assert.equal(nameless.body().errors[0].field, 'name')
    }

    const { node } = await created(client, adminToken, {
      kind: 'device',
      name: '   ',
      deviceMac: mac,
    })
    assert.deepInclude(node, { name: mac, nameOverride: null })
    assert.deepEqual(node.device, {
      mac,
      name: null,
      deviceType: null,
      connection: null,
      hostname: null,
      primaryIp: null,
    })

    // Its DHCP name (by MAC alone, as /wifi/clients looks it up) and its IP:
    // the most recently seen identity that has one, across collectors.
    setHostnameCommandRunnerForTesting(async (_settings, command) =>
      command[0] === 'cat' ? `1716649000 ${mac} 192.168.1.41 office-pc *\n` : ''
    )
    await setHostnameEnrichmentSettings({
      enabled: true,
      mode: HOSTNAME_ENRICHMENT_MODE,
      transport: 'lxc',
      leaseFilePath: '/tmp/dhcp.leases',
      refreshSeconds: 60,
      timeoutMs: 1500,
      lxc: { containerName: 'openwrt' },
    })
    // The layout above cached "no hostnames" while enrichment was off.
    resetHostnameEnrichmentCacheForTesting()
    const second = await Collector.create({
      name: 'second',
      baseUrl: 'http://192.168.1.2:9800',
      pollIntervalSeconds: 15,
      enabled: true,
      apiKey: null,
      lastStatus: null,
    })
    await seedDevice(collector.id, mac, { ip: '192.168.1.40', secondsAgo: 3600 })
    await seedDevice(second.id, mac, { ip: '192.168.1.41', secondsAgo: 60 })
    const third = await Collector.create({
      name: 'third',
      baseUrl: 'http://192.168.1.3:9800',
      pollIntervalSeconds: 15,
      enabled: true,
      apiKey: null,
      lastStatus: null,
    })
    await seedDevice(third.id, mac, { ip: null, secondsAgo: 5 })
    const withHostname = await layoutNode(client, adminToken, node.id)
    assert.equal(withHostname.name, 'office-pc')
    assert.deepInclude(withHostname.device, { hostname: 'office-pc', primaryIp: '192.168.1.41' })

    await saveDeviceLabel(mac, { name: 'Office PC', deviceType: 'desktop' })
    const labelled = await layoutNode(client, adminToken, node.id)
    assert.equal(labelled.name, 'Office PC')
    assert.deepInclude(labelled.device, { name: 'Office PC', deviceType: 'desktop' })

    const named = await patch(client, adminToken, node.id, { name: 'Desk PC' })
    assert.deepInclude(named.body().data.node, { name: 'Desk PC', nameOverride: 'Desk PC' })
    const unnamed = await patch(client, adminToken, node.id, { name: null })
    assert.equal(unnamed.body().data.node.name, 'Office PC')
    const unbound = await patch(client, adminToken, node.id, { deviceMac: null })
    assert.equal(unbound.body().data.node.name, 'Device', 'no device: the kind')

    // The agent's name comes before the device's: a manual AP node that
    // carries the AP's MAC, bound to the AP's agent afterwards.
    const apMac = '02:00:00:00:00:42'
    await saveDeviceLabel(apMac, { name: 'AP by label' })
    const { node: apNode } = await created(client, adminToken, {
      kind: 'access_point',
      deviceMac: apMac,
    })
    assert.equal(apNode.name, 'AP by label')
    const { ap } = await seedAgentAp({ name: 'ap-porch', macs: ['02:00:00:00:00:30'] })
    const bind = await client
      .post(`${NODES}/${apNode.id}/bind`)
      .bearerToken(adminToken)
      .json({ apId: ap.id })
    bind.assertStatus(200)
    assert.deepInclude(bind.body().data.node, { name: 'ap-porch', nameOverride: null })
    assert.equal(bind.body().data.node.device.mac, apMac, 'bind keeps the device')
  })

  test('linkTo cables the new node in the same transaction', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const { node: sw } = await created(client, adminToken, {
      kind: 'switch',
      name: 'Desk switch',
      portCount: 4,
      sfpPorts: 1,
    })
    const swPort = (key: string) => sw.ports.find((port: { key: string }) => port.key === key).id

    // The dashboard's call: a device, its MAC, a port, a position, no name.
    const pc = await created(client, adminToken, {
      kind: 'device',
      deviceMac: '02:00:00:00:00:51',
      linkTo: { portId: swPort('3') },
      position: { x: 40, y: 300 },
    })
    const eth0 = pc.node.ports[0]
    assert.deepEqual(pc.link, {
      id: pc.link.id,
      medium: 'ethernet',
      label: null,
      notes: null,
      a: { nodeId: sw.id, portId: swPort('3') },
      b: { nodeId: pc.node.id, portId: eth0.id },
    })
    assert.equal(eth0.linkId, pc.link.id)
    assert.deepInclude(pc.node, { name: '02:00:00:00:00:51', position: { x: 40, y: 300 } })

    // `ownPortKey` (any case) picks the port; the medium defaults by section 6.4.
    const nas = await created(client, adminToken, {
      kind: 'host',
      name: 'NAS',
      ports: [{ key: 'nic0' }, { key: 'sfp1', medium: 'sfp' }],
      linkTo: { portId: swPort('sfp1'), ownPortKey: 'SFP1' },
    })
    assert.equal(nas.link.medium, 'fiber')
    assert.equal(nas.link.b.portId, nas.node.ports[1].id)
    // Without it: the first port by position. An explicit medium wins.
    const tv = await created(client, adminToken, {
      kind: 'device',
      name: 'TV',
      ports: [
        { key: 'eth1', position: 5 },
        { key: 'eth0', position: 1 },
      ],
      linkTo: { portId: swPort('1'), medium: 'wireless' },
    })
    const tvEth0 = tv.node.ports.find((port: { key: string }) => port.key === 'eth0')
    assert.deepInclude(tv.link, { medium: 'wireless' })
    assert.equal(tvEth0.linkId, tv.link.id)

    // No `linkTo`: no cable.
    const plain = await created(client, adminToken, { kind: 'device', name: 'Printer' })
    assert.isNull(plain.link)
  })

  test('linkTo refusals leave nothing behind; a busy port creates nothing', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const sw = await seedManualNode('switch', 'Switch', ['1', '2', '3'])
    const pc = await seedManualNode('device', 'PC', ['eth0'])
    const cable = await seedLink(sw.ports['1'], pc.ports.eth0)
    await db.from('infra_ports').where('id', sw.ports['2']).update({ hidden: true })
    const before = await _infraRowCounts()
    const mac = '02:00:00:00:00:61'

    const refusal = async (
      body: Record<string, unknown>,
      status: number,
      check: (body: any) => void
    ) => {
      const response = await post(client, adminToken, body)
      response.assertStatus(status)
      check(response.body())
      assert.deepEqual(await _infraRowCounts(), before, JSON.stringify(body))
    }
    await refusal(
      { kind: 'device', deviceMac: mac, linkTo: { portId: sw.ports['1'] } },
      409,
      (body) =>
        assert.deepEqual(body, {
          error: 'infra_port_busy',
          message: body.message,
          portId: sw.ports['1'],
          linkId: cable,
        })
    )
    await refusal({ kind: 'device', deviceMac: mac, linkTo: { portId: sw.ports['2'] } }, 409, (b) =>
      assert.deepInclude(b, { error: 'infra_port_hidden', portId: sw.ports['2'] })
    )
    await refusal({ kind: 'device', deviceMac: mac, linkTo: { portId: 99999 } }, 404, (b) =>
      assert.deepInclude(b, { error: 'infra_port_not_found', portId: 99999 })
    )
    await refusal(
      { kind: 'host', name: 'Frame', deviceMac: mac, linkTo: { portId: sw.ports['3'] } },
      422,
      (b) => assert.deepInclude(b, { error: 'infra_field_not_applicable', field: 'linkTo' })
    )
    await refusal(
      { kind: 'device', deviceMac: mac, ports: [], linkTo: { portId: sw.ports['3'] } },
      422,
      (b) => assert.deepInclude(b, { error: 'infra_field_not_applicable', field: 'linkTo' })
    )
    await refusal(
      { kind: 'device', deviceMac: mac, linkTo: { portId: sw.ports['3'], ownPortKey: 'eth9' } },
      422,
      (b) => assert.equal(b.errors[0].field, 'linkTo.ownPortKey')
    )

    // The cable cap: 400 on the map.
    const now = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')
    const [bulk] = await db.table('infra_nodes').insert({
      kind: 'switch',
      origin: 'manual',
      name: 'bulk',
      created_at: now,
      updated_at: now,
    })
    await db.table('infra_ports').multiInsert(
      Array.from({ length: 798 }, (_, i) => ({
        node_id: bulk,
        port_key: `p${i}`,
        origin: 'manual',
        position: i,
        created_at: now,
        updated_at: now,
      }))
    )
    const bulkRows = await db.from('infra_ports').where('node_id', bulk).orderBy('id')
    const bulkPorts = bulkRows.map((row) => Number(row.id))
    await db.table('infra_links').multiInsert(
      Array.from({ length: 399 }, (_, i) => ({
        a_port_id: bulkPorts[2 * i],
        b_port_id: bulkPorts[2 * i + 1],
        medium: 'ethernet',
        created_at: now,
        updated_at: now,
      }))
    )
    const full = await _infraRowCounts()
    assert.equal(full.links, 400)
    const capped = await post(client, adminToken, {
      kind: 'device',
      deviceMac: mac,
      linkTo: { portId: sw.ports['3'] },
    })
    capped.assertStatus(422)
    assert.deepInclude(capped.body(), { error: 'infra_limit_reached', limit: 'links', max: 400 })
    assert.deepEqual(await _infraRowCounts(), full)

    // The device was never placed by any of these.
    const placed = await post(client, adminToken, { kind: 'device', deviceMac: mac })
    placed.assertStatus(201)
  })
})
