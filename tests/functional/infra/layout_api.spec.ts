import Collector from '#models/collector'
import { saveDeviceLabel } from '#services/device_labels'
import { recordAgentPorts } from '#services/infra_ports'
import { seedAgentAp, seedSetupComplete } from '#tests/helpers/ap_agent'
import {
  apPorts,
  closeAgentSessions,
  nodeFor,
  portReport,
  resetInfraTests,
  seedGatewayCollector,
  seedLink,
  seedManualNode,
  seedScrapeAp,
} from '#tests/helpers/infra'
import db from '@adonisjs/lucid/services/db'
import type { ApiClient } from '@japa/api-client'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

const LAYOUT = '/api/v1/infra/layout'
const NODES = '/api/v1/infra/nodes'
const PORTS_CAPABLE = ['metrics', 'clients', 'kick', 'locate', 'reboot', 'ports']

async function layoutOf(client: ApiClient, token: string) {
  const response = await client.get(LAYOUT).bearerToken(token)
  response.assertStatus(200)
  return response.body().data
}

async function nodeView(client: ApiClient, token: string, id: number) {
  const layout = await layoutOf(client, token)
  return layout.nodes.find((node: { id: number }) => node.id === id)
}

async function create(client: ApiClient, token: string, body: Record<string, unknown>) {
  return client.post(NODES).bearerToken(token).json(body)
}

async function createOk(client: ApiClient, token: string, body: Record<string, unknown>) {
  const response = await create(client, token, body)
  response.assertStatus(201)
  return response.body().data.node
}

function keys(node: { ports: Array<{ key: string }> }) {
  return node.ports.map((port) => port.key)
}

test.group('infra | layout API', (group) => {
  group.each.setup(resetInfraTests)
  group.each.teardown(closeAgentSessions)

  test('an instance without agents returns empty arrays, the kinds and the limits', async ({
    client,
    assert,
  }) => {
    const { operatorToken } = await seedSetupComplete()
    const layout = await layoutOf(client, operatorToken)
    assert.deepEqual(layout.nodes, [])
    assert.deepEqual(layout.links, [])
    assert.isNull(layout.rootNodeId)
    assert.match(layout.generatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    assert.deepEqual(layout.limits, { nodes: 200, portsPerNode: 64, links: 400 })
    assert.deepEqual(
      layout.kinds.map((kind: { kind: string }) => kind.kind),
      ['gateway', 'access_point', 'switch', 'router', 'modem', 'isp', 'host', 'device']
    )
    const byKind = Object.fromEntries(
      layout.kinds.map((kind: { kind: string }) => [kind.kind, kind])
    )
    assert.deepEqual(byKind.switch, {
      kind: 'switch',
      label: 'Switch',
      manual: true,
      container: false,
      ports: { default: 8, min: 1, max: 64 },
      supportsSfp: true,
    })
    assert.deepEqual(byKind.host, {
      kind: 'host',
      label: 'Host / hypervisor',
      manual: true,
      container: true,
      ports: { default: 0, min: 0, max: 64 },
      supportsSfp: true,
    })
    assert.isFalse(byKind.gateway.manual)
  })

  test('agent nodes are created by the layout, once, with their bindings', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const { ap: garage } = await seedAgentAp({ capabilities: PORTS_CAPABLE })
    await db.from('wifi_access_points').where('id', garage.id).update({ friendly_name: 'Garage' })
    const { ap: porch } = await seedAgentAp({
      name: 'ap-porch',
      macs: ['02:00:00:00:00:30'],
      capabilities: ['metrics', 'clients'],
    })
    const attic = await seedScrapeAp('ap-attic')
    const gateway = await seedGatewayCollector({ version: '0.2.0' })
    // Pending, or no gateway stats: no node.
    await Collector.create({
      name: 'pending-router',
      baseUrl: 'http://192.168.1.2:9800',
      source: 'announced',
      lifecycle: 'pending',
      enabled: false,
      pollIntervalSeconds: 5,
      lastStatus: {
        ok: true,
        checkedAt: DateTime.utc().toISO()!,
        gateway: {
          reportedAt: DateTime.utc().toISO()!,
          wanInterfaces: [],
          wanSource: 'configured',
        },
      },
    })

    const layout = await layoutOf(client, adminToken)
    assert.lengthOf(layout.nodes, 4)
    const bound = (type: string, id: number) =>
      layout.nodes.find((node: any) => node.binding?.type === type && node.binding.id === id)

    const garageNode = bound('ap', garage.id)
    assert.deepInclude(garageNode, {
      kind: 'access_point',
      name: 'Garage',
      nameOverride: null,
      source: 'agent',
      detached: false,
      virtual: false,
      model: null,
      notes: null,
      device: null,
      parentId: null,
      position: null,
      size: null,
      hidden: false,
      isRoot: false,
      ports: [],
      updatedAt: garageNode.updatedAt,
    })
    assert.deepEqual(garageNode.binding, {
      type: 'ap',
      id: garage.id,
      name: 'Garage',
      transport: 'agent',
      version: '0.1.0',
      portsSupported: true,
    })
    assert.isFalse(bound('ap', porch.id).binding.portsSupported, 'an agent without the capability')
    assert.deepEqual(bound('ap', attic.id).binding, {
      type: 'ap',
      id: attic.id,
      name: 'ap-attic',
      transport: 'scrape',
      version: null,
      portsSupported: false,
    })
    const gatewayNode = bound('collector', gateway.id)
    assert.equal(gatewayNode.kind, 'gateway')
    assert.isTrue(gatewayNode.isRoot)
    assert.equal(layout.rootNodeId, gatewayNode.id)
    assert.deepEqual(gatewayNode.binding, {
      type: 'collector',
      id: gateway.id,
      name: 'gateway',
      transport: 'poll',
      version: '0.2.0',
      portsSupported: null,
    })

    const again = await layoutOf(client, adminToken)
    assert.deepEqual(
      again.nodes.map((node: { id: number }) => node.id),
      layout.nodes.map((node: { id: number }) => node.id)
    )
    assert.lengthOf(await db.from('infra_nodes').select('id'), 4)
  })

  test('POST /nodes fills the ports from the kind template', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const sw = await createOk(client, adminToken, {
      kind: 'switch',
      name: 'Garage switch',
      model: '8-port desktop switch',
      notes: 'under the stairs',
      position: { x: 120, y: 200 },
      portCount: 8,
      sfpPorts: 2,
    })
    assert.deepInclude(sw, {
      kind: 'switch',
      name: 'Garage switch',
      nameOverride: 'Garage switch',
      source: 'manual',
      binding: null,
      detached: false,
      model: '8-port desktop switch',
      notes: 'under the stairs',
      position: { x: 120, y: 200 },
      hidden: false,
      isRoot: false,
    })
    assert.deepEqual(keys(sw), ['1', '2', '3', '4', '5', '6', '7', '8', 'sfp1', 'sfp2'])
    assert.deepEqual(sw.ports[0], {
      id: sw.ports[0].id,
      nodeId: sw.id,
      key: '1',
      origin: 'manual',
      label: '1',
      labelOverride: null,
      role: null,
      roleOverride: null,
      medium: 'copper',
      mac: null,
      position: 0,
      hidden: false,
      present: true,
      missingSince: null,
      linkId: null,
    })
    assert.equal(sw.ports[9].medium, 'sfp')
    assert.equal(sw.ports[9].position, 9)

    const router = await createOk(client, adminToken, { kind: 'router', name: 'Second router' })
    assert.deepEqual(
      router.ports.map((port: any) => [port.key, port.role]),
      [
        ['wan', 'wan'],
        ['lan1', 'lan'],
        ['lan2', 'lan'],
        ['lan3', 'lan'],
        ['lan4', 'lan'],
      ]
    )
    const modem = await createOk(client, adminToken, { kind: 'modem', name: 'ONT' })
    assert.deepEqual(keys(modem), ['wan', 'lan1'])
    const isp = await createOk(client, adminToken, { kind: 'isp', name: 'ISP A' })
    assert.deepEqual(
      isp.ports.map((port: any) => [port.key, port.role, port.medium]),
      [['uplink', 'wan', null]]
    )
    const ap = await createOk(client, adminToken, { kind: 'access_point', name: 'Old AP' })
    assert.deepEqual(keys(ap), ['wan', 'lan1'])
    const host = await createOk(client, adminToken, {
      kind: 'host',
      name: 'Server',
      virtual: false,
      size: { width: 420, height: 260 },
    })
    assert.deepEqual(host.ports, [])
    assert.deepEqual(host.size, { width: 420, height: 260 })
    const nics = await createOk(client, adminToken, {
      kind: 'host',
      name: 'Hypervisor',
      portCount: 2,
      sfpPorts: 1,
    })
    assert.deepEqual(keys(nics), ['nic0', 'nic1', 'sfp1'])

    await saveDeviceLabel('02:00:00:00:00:21', {
      name: 'NAS',
      deviceType: 'nas',
      connection: 'ethernet',
    })
    const nas = await createOk(client, adminToken, {
      kind: 'device',
      name: 'NAS',
      deviceMac: '02-00-00-00-00-21',
    })
    assert.deepEqual(keys(nas), ['eth0'])
    assert.deepEqual(nas.device, {
      mac: '02:00:00:00:00:21',
      name: 'NAS',
      deviceType: 'nas',
      connection: 'ethernet',
      hostname: null,
      primaryIp: null,
    })
  })

  test('POST /nodes: explicit ports win over portCount; duplicate keys are refused', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const rack = await createOk(client, adminToken, {
      kind: 'switch',
      name: 'Rack',
      portCount: 16,
      ports: [
        { key: '1', label: '1', role: null, medium: 'copper' },
        { key: 'uplink', role: 'wan', medium: 'sfp', position: 9 },
      ],
    })
    assert.deepEqual(
      rack.ports.map((port: any) => [
        port.key,
        port.labelOverride,
        port.role,
        port.medium,
        port.position,
      ]),
      [
        ['1', '1', null, 'copper', 0],
        ['uplink', null, 'wan', 'sfp', 9],
      ]
    )

    const duplicate = await create(client, adminToken, {
      kind: 'switch',
      name: 'Twice',
      ports: [{ key: 'lan1' }, { key: 'LAN1' }],
    })
    duplicate.assertStatus(422)
    assert.equal(duplicate.body().error, 'infra_port_key_duplicate')
  })

  test('POST /nodes refusals', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const sw = await createOk(client, adminToken, { kind: 'switch', name: 'Switch' })
    const host = await createOk(client, adminToken, { kind: 'host', name: 'Server' })

    const expectError = async (body: Record<string, unknown>, status: number, error: string) => {
      const response = await create(client, adminToken, body)
      response.assertStatus(status)
      assert.equal(response.body().error, error, JSON.stringify(body))
    }
    await expectError({ kind: 'gateway', name: 'Root' }, 422, 'infra_kind_not_manual')
    await expectError({ kind: 'device', name: 'X', parentId: sw.id }, 422, 'infra_parent_invalid')
    await expectError({ kind: 'device', name: 'X', parentId: 9999 }, 422, 'infra_parent_invalid')
    await expectError({ kind: 'host', name: 'X', parentId: host.id }, 422, 'infra_parent_invalid')
    await expectError(
      { kind: 'switch', name: 'X', size: { width: 200, height: 200 } },
      422,
      'infra_field_not_applicable'
    )
    await expectError(
      { kind: 'router', name: 'X', virtual: true },
      422,
      'infra_field_not_applicable'
    )
    await expectError(
      { kind: 'isp', name: 'X', deviceMac: '02:00:00:00:00:21' },
      422,
      'infra_field_not_applicable'
    )
    await expectError({ kind: 'router', name: 'X', sfpPorts: 2 }, 422, 'infra_field_not_applicable')
    await expectError(
      { kind: 'switch', name: 'X', portCount: 64, sfpPorts: 8 },
      422,
      'infra_limit_reached'
    )

    const range = await create(client, adminToken, { kind: 'isp', name: 'X', portCount: 3 })
    range.assertStatus(422)
    assert.equal(range.body().errors[0].field, 'portCount')
    const noName = await create(client, adminToken, { kind: 'switch' })
    noName.assertStatus(422)
    assert.equal(noName.body().errors[0].field, 'name')
    const badKind = await create(client, adminToken, { kind: 'toaster', name: 'X' })
    badKind.assertStatus(422)
    assert.equal(badKind.body().errors[0].field, 'kind')

    // The node cap: 200 on the map.
    const now = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')
    await db.table('infra_nodes').multiInsert(
      Array.from({ length: 198 }, (_, i) => ({
        kind: 'device',
        origin: 'manual',
        name: `device ${i}`,
        created_at: now,
        updated_at: now,
      }))
    )
    await expectError({ kind: 'switch', name: 'One too many' }, 422, 'infra_limit_reached')
  })

  test('PATCH /nodes merges: omitted keys keep, null clears', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const sw = await createOk(client, adminToken, {
      kind: 'switch',
      name: 'Garage switch',
      model: 'GS108',
      notes: 'under the stairs',
      position: { x: 10, y: 20 },
    })
    const patch = (id: number, body: Record<string, unknown>) =>
      client.patch(`${NODES}/${id}`).bearerToken(adminToken).json(body)

    const notes = await patch(sw.id, { notes: 'moved to the rack' })
    notes.assertStatus(200)
    assert.deepInclude(notes.body().data.node, {
      model: 'GS108',
      notes: 'moved to the rack',
      position: { x: 10, y: 20 },
    })
    const cleared = await patch(sw.id, { model: null, position: null, virtual: true, hidden: true })
    assert.deepInclude(cleared.body().data.node, {
      model: null,
      notes: 'moved to the rack',
      position: null,
      virtual: true,
      hidden: true,
    })
    const unnamed = await patch(sw.id, { name: '   ' })
    assert.equal(unnamed.body().data.node.name, 'Switch', 'falls back to the kind')
    assert.isNull(unnamed.body().data.node.nameOverride)
    const listed = await nodeView(client, adminToken, sw.id)
    assert.isTrue(listed.hidden, 'hidden nodes stay listed')

    const refusal = async (
      id: number,
      body: Record<string, unknown>,
      status: number,
      error: string
    ) => {
      const response = await patch(id, body)
      response.assertStatus(status)
      assert.equal(response.body().error, error, JSON.stringify(body))
    }
    await refusal(sw.id, { size: { width: 300, height: 300 } }, 422, 'infra_field_not_applicable')
    await refusal(sw.id, { kind: 'router' }, 422, 'infra_field_not_applicable')
    const isp = await createOk(client, adminToken, { kind: 'isp', name: 'ISP' })
    await refusal(isp.id, { deviceMac: '02:00:00:00:00:21' }, 422, 'infra_field_not_applicable')
    await refusal(9999, { notes: 'x' }, 404, 'infra_node_not_found')
    const router = await createOk(client, adminToken, { kind: 'router', name: 'Router' })
    await refusal(router.id, { portCount: 4 }, 422, 'infra_field_not_applicable')
    await refusal(router.id, { virtual: true }, 422, 'infra_field_not_applicable')

    const device = await createOk(client, adminToken, { kind: 'device', name: 'Printer' })
    const marked = await patch(device.id, { deviceMac: '02:00:00:00:00:22' })
    assert.equal(marked.body().data.node.device.mac, '02:00:00:00:00:22')
    const unmarked = await patch(device.id, { deviceMac: null })
    assert.isNull(unmarked.body().data.node.device)
  })

  test('PATCH portCount grows and shrinks a switch; a cabled port blocks the shrink', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const sw = await createOk(client, adminToken, {
      kind: 'switch',
      name: 'Switch',
      portCount: 4,
      sfpPorts: 1,
    })
    const patch = (body: Record<string, unknown>) =>
      client.patch(`${NODES}/${sw.id}`).bearerToken(adminToken).json(body)

    const grown = await patch({ portCount: 6 })
    grown.assertStatus(200)
    const ports = grown.body().data.node.ports
    assert.deepEqual(keys(grown.body().data.node), ['1', '2', '3', '4', '5', '6', 'sfp1'])
    assert.deepEqual(
      ports.map((port: any) => port.position),
      [0, 1, 2, 3, 4, 5, 6]
    )

    const other = await seedManualNode('device', 'PC', ['eth0'])
    const port6 = ports.find((port: any) => port.key === '6')
    const linkId = await seedLink(port6.id, other.ports.eth0)
    const blocked = await patch({ portCount: 3 })
    blocked.assertStatus(409)
    assert.equal(blocked.body().error, 'infra_port_has_link')
    assert.deepEqual(blocked.body().ports, [{ id: port6.id, key: '6', linkId }])
    const unchanged = await nodeView(client, adminToken, sw.id)
    assert.lengthOf(unchanged.ports, 7, 'nothing dropped')

    await db.from('infra_links').where('id', linkId).delete()
    const shrunk = await patch({ portCount: 3 })
    shrunk.assertStatus(200)
    assert.deepEqual(keys(shrunk.body().data.node), ['1', '2', '3', 'sfp1'])

    const zero = await patch({ portCount: 0 })
    zero.assertStatus(422)
    assert.equal(zero.body().errors[0].field, 'portCount')
  })

  test('only a host is a parent, one level deep', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const gateway = await seedGatewayCollector()
    await layoutOf(client, adminToken)
    const gatewayNode = await nodeFor({ collectorId: gateway.id })
    const host = await createOk(client, adminToken, { kind: 'host', name: 'Server' })
    const bridge = await createOk(client, adminToken, {
      kind: 'switch',
      name: 'br-lan',
      virtual: true,
      parentId: host.id,
      ports: [{ key: 'nic-side' }, { key: 'gw', medium: 'virtual' }],
    })
    assert.equal(bridge.parentId, host.id)
    const patch = (id: number, body: Record<string, unknown>) =>
      client.patch(`${NODES}/${id}`).bearerToken(adminToken).json(body)

    const inside = await patch(Number(gatewayNode.id), { parentId: host.id })
    inside.assertStatus(200)
    assert.equal(inside.body().data.node.parentId, host.id, 'the Gateway agent inside its host')

    for (const [id, parentId] of [
      [host.id, host.id],
      [bridge.id, bridge.id],
      [Number(gatewayNode.id), bridge.id],
    ]) {
      const response = await patch(id, { parentId })
      response.assertStatus(422)
      assert.equal(response.body().error, 'infra_parent_invalid')
    }
    const second = await createOk(client, adminToken, { kind: 'host', name: 'NAS host' })
    const nested = await patch(second.id, { parentId: host.id })
    nested.assertStatus(422)
    assert.equal(nested.body().error, 'infra_parent_invalid')

    // Deleting the frame leaves its children where they are, without a parent.
    const deleted = await client.delete(`${NODES}/${host.id}`).bearerToken(adminToken)
    deleted.assertStatus(204)
    const freedBridge = await nodeView(client, adminToken, bridge.id)
    const freedGateway = await nodeView(client, adminToken, Number(gatewayNode.id))
    assert.isNull(freedBridge.parentId)
    assert.isNull(freedGateway.parentId)
  })

  test('DELETE /nodes: a manual node goes with its ports and cables; a bound one refuses', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const { ap } = await seedAgentAp()
    await db.from('wifi_access_points').where('id', ap.id).update({ friendly_name: 'Garage' })
    await recordAgentPorts({ type: 'ap', id: ap.id }, apPorts(), DateTime.utc())
    const apNode = await nodeFor({ apId: ap.id })
    const gateway = await seedGatewayCollector({ name: 'router' })
    await layoutOf(client, adminToken)
    const gatewayNode = await nodeFor({ collectorId: gateway.id })

    const sw = await createOk(client, adminToken, { kind: 'switch', name: 'Switch' })
    const wan = await db
      .from('infra_ports')
      .where('node_id', apNode.id)
      .where('port_key', 'wan')
      .first()
    await seedLink(wan.id, sw.ports[0].id)

    const removed = await client.delete(`${NODES}/${sw.id}`).bearerToken(adminToken)
    removed.assertStatus(204)
    assert.lengthOf(await db.from('infra_ports').where('node_id', sw.id), 0)
    assert.lengthOf(await db.from('infra_links').select('id'), 0)
    assert.exists(await db.from('infra_ports').where('id', wan.id).first(), 'the AP port stays')

    const apRefusal = await client.delete(`${NODES}/${apNode.id}`).bearerToken(adminToken)
    apRefusal.assertStatus(409)
    assert.equal(apRefusal.body().error, 'infra_node_bound')
    assert.deepEqual(apRefusal.body().binding, { type: 'ap', id: ap.id })
    assert.include(apRefusal.body().message, '"Garage"')
    assert.include(apRefusal.body().message, 'Settings → Wi-Fi sources')
    const gatewayRefusal = await client.delete(`${NODES}/${gatewayNode.id}`).bearerToken(adminToken)
    gatewayRefusal.assertStatus(409)
    assert.include(gatewayRefusal.body().message, 'Gateway agent')

    const missing = await client.delete(`${NODES}/9999`).bearerToken(adminToken)
    missing.assertStatus(404)
    assert.equal(missing.body().error, 'infra_node_not_found')
  })

  test('deleting an AP in Settings detaches its node; bind puts it on the new AP', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const { ap: old } = await seedAgentAp({ capabilities: PORTS_CAPABLE })
    await recordAgentPorts({ type: 'ap', id: old.id }, apPorts(), DateTime.utc())
    const node = await nodeFor({ apId: old.id })
    const sw = await seedManualNode('switch', 'Switch', ['1'])
    const lan1 = await db
      .from('infra_ports')
      .where('node_id', node.id)
      .where('port_key', 'lan1')
      .first()
    const linkId = await seedLink(lan1.id, sw.ports['1'])

    const deleted = await client
      .delete(`/api/v1/settings/wifi-sources/${old.id}`)
      .bearerToken(adminToken)
    deleted.assertStatus(204)
    const detached = await nodeView(client, adminToken, Number(node.id))
    assert.deepInclude(detached, { source: 'agent', binding: null, detached: true })
    assert.lengthOf(detached.ports, 4, 'ports as last reported')
    assert.equal(detached.ports.find((port: any) => port.key === 'lan1').linkId, linkId)

    // The AP joins again (a new row): the layout gives it a node of its own…
    const { ap: rejoined } = await seedAgentAp({
      name: 'ap-garage-2',
      macs: ['02:00:00:00:00:50'],
      capabilities: PORTS_CAPABLE,
    })
    await layoutOf(client, adminToken)
    const fresh = await nodeFor({ apId: rejoined.id })
    assert.exists(fresh)

    // …which gives way when the detached node is bound to it.
    const bound = await client
      .post(`${NODES}/${node.id}/bind`)
      .bearerToken(adminToken)
      .json({ apId: rejoined.id })
    bound.assertStatus(200)
    assert.equal(bound.body().data.replacedNodeId, Number(fresh.id))
    assert.deepInclude(bound.body().data.node, { id: Number(node.id), detached: false })
    assert.equal(bound.body().data.node.binding.id, rejoined.id)
    assert.isNull(await db.from('infra_nodes').where('id', fresh.id).first())

    // The next report matches the ports by key: same rows, same cable.
    await recordAgentPorts({ type: 'ap', id: rejoined.id }, apPorts(), DateTime.utc())
    const after = await db
      .from('infra_ports')
      .where('node_id', node.id)
      .where('port_key', 'lan1')
      .first()
    assert.equal(after.id, lan1.id)
    assert.exists(await db.from('infra_links').where('id', linkId).first())
  })

  test('bind refusals', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const { ap } = await seedAgentAp()
    const gateway = await seedGatewayCollector()
    await layoutOf(client, adminToken)
    const apNode = await nodeFor({ apId: ap.id })
    const detached = await seedManualNode('access_point', 'Old AP', ['wan'], { origin: 'agent' })
    const sw = await seedManualNode('switch', 'Switch', ['1'])
    const bind = (id: number, body: Record<string, unknown>) =>
      client.post(`${NODES}/${id}/bind`).bearerToken(adminToken).json(body)
    const expectError = async (
      id: number,
      body: Record<string, unknown>,
      status: number,
      error: string
    ) => {
      const response = await bind(id, body)
      response.assertStatus(status)
      assert.equal(response.body().error, error, JSON.stringify(body))
    }

    await expectError(Number(apNode.id), { apId: ap.id }, 409, 'infra_node_already_bound')
    await expectError(detached.id, { apId: 9999 }, 404, 'infra_binding_not_found')
    await expectError(detached.id, { collectorId: gateway.id }, 422, 'infra_binding_kind_mismatch')
    await expectError(sw.id, { apId: ap.id }, 422, 'infra_binding_kind_mismatch')
    await expectError(9999, { apId: ap.id }, 404, 'infra_node_not_found')

    // The AP's own node carries a cable: it does not give way.
    const apWan = await db.table('infra_ports').insert({
      node_id: apNode.id,
      port_key: 'wan',
      origin: 'manual',
      position: 0,
      hidden: false,
      present: true,
      created_at: DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss'),
    })
    await seedLink(Number(apWan[0]), sw.ports['1'])
    await expectError(detached.id, { apId: ap.id }, 409, 'infra_agent_node_has_links')

    const both = await bind(detached.id, { apId: ap.id, collectorId: gateway.id })
    both.assertStatus(422)
    assert.isArray(both.body().errors)
    const neither = await bind(detached.id, {})
    neither.assertStatus(422)
    assert.isArray(neither.body().errors)
  })

  test('ports pinned by hand, edited and deleted', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const { ap } = await seedAgentAp()
    await layoutOf(client, adminToken)
    const node = await nodeFor({ apId: ap.id })
    const addPorts = (id: number, ports: unknown[]) =>
      client.post(`${NODES}/${id}/ports`).bearerToken(adminToken).json({ ports })

    // An old agent reports no ports: the operator pins them.
    const pinned = await addPorts(Number(node.id), [
      { key: 'wan', role: 'wan' },
      { key: 'lan1', label: 'LAN 1', role: 'lan', medium: 'copper' },
    ])
    pinned.assertStatus(201)
    assert.deepEqual(
      pinned
        .body()
        .data.ports.map((port: any) => [
          port.key,
          port.origin,
          port.label,
          port.labelOverride,
          port.role,
          port.position,
        ]),
      [
        ['wan', 'manual', 'wan', null, 'wan', 0],
        ['lan1', 'manual', 'LAN 1', 'LAN 1', 'lan', 1],
      ]
    )
    const taken = await addPorts(Number(node.id), [{ key: 'WAN' }])
    taken.assertStatus(409)
    assert.equal(taken.body().error, 'infra_port_key_taken')
    const twice = await addPorts(Number(node.id), [{ key: 'lan2' }, { key: 'lan2' }])
    twice.assertStatus(422)
    assert.equal(twice.body().error, 'infra_port_key_duplicate')
    const tooMany = await addPorts(
      Number(node.id),
      Array.from({ length: 63 }, (_, i) => ({ key: `p${i}` }))
    )
    tooMany.assertStatus(422)
    assert.equal(tooMany.body().error, 'infra_limit_reached')
    const noNode = await addPorts(9999, [{ key: 'x' }])
    noNode.assertStatus(404)
    assert.equal(noNode.body().error, 'infra_node_not_found')

    const lan1Id = pinned.body().data.ports[1].id
    const patch = (id: number, body: Record<string, unknown>) =>
      client.patch(`/api/v1/infra/ports/${id}`).bearerToken(adminToken).json(body)
    const renamed = await patch(lan1Id, { key: 'aux1', label: null, position: 5 })
    renamed.assertStatus(200)
    assert.deepInclude(renamed.body().data.port, {
      key: 'aux1',
      label: 'aux1',
      labelOverride: null,
      position: 5,
    })
    const clash = await patch(lan1Id, { key: 'wan' })
    clash.assertStatus(409)
    assert.equal(clash.body().error, 'infra_port_key_taken')

    // The agent is upgraded and reports its ports: the pins are adopted.
    await recordAgentPorts({ type: 'ap', id: ap.id }, apPorts(), DateTime.utc())
    const wan = await db
      .from('infra_ports')
      .where('node_id', node.id)
      .where('port_key', 'wan')
      .first()
    assert.equal(wan.origin, 'agent')
    const aux = await db.from('infra_ports').where('id', lan1Id).first()
    assert.equal(aux.origin, 'manual', 'a key the agent does not report stays a pin')
    const immutable = await patch(wan.id, { key: 'uplink' })
    immutable.assertStatus(422)
    assert.equal(immutable.body().error, 'infra_port_key_immutable')

    const overridden = await patch(wan.id, { label: 'Uplink', role: 'lan', medium: 'sfp' })
    assert.deepInclude(overridden.body().data.port, {
      label: 'Uplink',
      labelOverride: 'Uplink',
      role: 'lan',
      roleOverride: 'lan',
      medium: 'sfp',
    })
    const restored = await patch(wan.id, { label: null, role: null, medium: null })
    assert.deepInclude(restored.body().data.port, {
      label: 'wan',
      labelOverride: null,
      role: 'wan',
      roleOverride: null,
      medium: 'copper',
    })

    const refusedDelete = await client
      .delete(`/api/v1/infra/ports/${wan.id}`)
      .bearerToken(adminToken)
    refusedDelete.assertStatus(409)
    assert.equal(refusedDelete.body().error, 'infra_port_present')

    // lan3 disappears from the reports while it is hidden: kept, then deletable.
    const lan3 = await db
      .from('infra_ports')
      .where('node_id', node.id)
      .where('port_key', 'lan3')
      .first()
    const hidden = await patch(lan3.id, { hidden: true })
    hidden.assertStatus(200)
    await recordAgentPorts(
      { type: 'ap', id: ap.id },
      apPorts().filter((port) => port.name !== 'lan3'),
      DateTime.utc()
    )
    const missing = await db.from('infra_ports').where('id', lan3.id).first()
    assert.equal(Number(missing.present), 0)
    const missingGone = await client
      .delete(`/api/v1/infra/ports/${lan3.id}`)
      .bearerToken(adminToken)
    missingGone.assertStatus(204)
    const pinGone = await client.delete(`/api/v1/infra/ports/${lan1Id}`).bearerToken(adminToken)
    pinGone.assertStatus(204)
    const gone = await client.delete(`/api/v1/infra/ports/${lan1Id}`).bearerToken(adminToken)
    gone.assertStatus(404)
    assert.equal(gone.body().error, 'infra_port_not_found')
  })

  test('hiding a cabled port is refused', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const a = await seedManualNode('switch', 'A', ['1'])
    const b = await seedManualNode('switch', 'B', ['1'])
    const linkId = await seedLink(a.ports['1'], b.ports['1'])
    const response = await client
      .patch(`/api/v1/infra/ports/${a.ports['1']}`)
      .bearerToken(adminToken)
      .json({ hidden: true })
    response.assertStatus(409)
    assert.equal(response.body().error, 'infra_port_has_link')
    assert.equal(response.body().linkId, linkId)
  })

  test('PUT /positions writes many nodes in one transaction', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const host = await createOk(client, adminToken, { kind: 'host', name: 'Server' })
    const a = await createOk(client, adminToken, { kind: 'switch', name: 'A' })
    const b = await createOk(client, adminToken, { kind: 'device', name: 'B' })
    const put = (positions: unknown[]) =>
      client.put('/api/v1/infra/positions').bearerToken(adminToken).json({ positions })

    const saved = await put([
      { nodeId: a.id, x: 240, y: 40, parentId: null },
      { nodeId: b.id, x: -5, y: 10, parentId: host.id },
    ])
    saved.assertStatus(200)
    assert.deepEqual(saved.body().data, { updated: 2 })
    const placed = await nodeView(client, adminToken, a.id)
    assert.deepEqual(placed.position, { x: 240, y: 40 })
    const moved = await nodeView(client, adminToken, b.id)
    assert.deepEqual(moved.position, { x: -5, y: 10 })
    assert.equal(moved.parentId, host.id)

    const unknown = await put([
      { nodeId: a.id, x: 1, y: 1 },
      { nodeId: 9998, x: 1, y: 1 },
      { nodeId: 9999, x: 1, y: 1 },
    ])
    unknown.assertStatus(404)
    assert.equal(unknown.body().error, 'infra_node_not_found')
    assert.equal(unknown.body().nodeId, 9998)
    const untouched = await nodeView(client, adminToken, a.id)
    assert.deepEqual(untouched.position, { x: 240, y: 40 })

    const badParent = await put([{ nodeId: a.id, x: 1, y: 1, parentId: b.id }])
    badParent.assertStatus(422)
    assert.equal(badParent.body().error, 'infra_parent_invalid')
    const outOfRange = await put([{ nodeId: a.id, x: 100001, y: 1 }])
    outOfRange.assertStatus(422)
    assert.isArray(outOfRange.body().errors)
    const empty = await put([])
    empty.assertStatus(422)
  })

  test("a bound node follows the agent's name until the operator names it", async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const { ap } = await seedAgentAp()
    await layoutOf(client, adminToken)
    const node = await nodeFor({ apId: ap.id })
    const initial = await nodeView(client, adminToken, Number(node.id))
    assert.equal(initial.name, 'ap-garage')

    const renamed = await client
      .put(`/api/v1/settings/wifi-sources/${ap.id}?probe=false`)
      .bearerToken(adminToken)
      .json({ friendlyName: 'Garage' })
    renamed.assertStatus(200)
    const followsRename = await nodeView(client, adminToken, Number(node.id))
    assert.equal(followsRename.name, 'Garage')

    const named = await client
      .patch(`${NODES}/${node.id}`)
      .bearerToken(adminToken)
      .json({ name: 'Hallway AP' })
    assert.deepInclude(named.body().data.node, { name: 'Hallway AP', nameOverride: 'Hallway AP' })
    const followed = await client
      .patch(`${NODES}/${node.id}`)
      .bearerToken(adminToken)
      .json({ name: null })
    assert.deepInclude(followed.body().data.node, { name: 'Garage', nameOverride: null })
  })

  test('agent ports report in the layout with their overrides and missing state', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const { ap } = await seedAgentAp({ capabilities: PORTS_CAPABLE })
    await recordAgentPorts(
      { type: 'ap', id: ap.id },
      [portReport('wan', { role: 'wan', label: 'WAN' }), portReport('lan1', { role: 'lan' })],
      DateTime.utc()
    )
    const node = await nodeFor({ apId: ap.id })
    await db
      .from('infra_ports')
      .where('node_id', node.id)
      .where('port_key', 'lan1')
      .update({ label: 'Desk' })
    await recordAgentPorts(
      { type: 'ap', id: ap.id },
      [portReport('wan', { role: 'wan', label: 'WAN' })],
      DateTime.utc()
    )

    const view = await nodeView(client, adminToken, Number(node.id))
    const [wan, lan1] = view.ports
    assert.deepInclude(wan, {
      key: 'wan',
      origin: 'agent',
      label: 'WAN',
      labelOverride: null,
      role: 'wan',
      medium: 'copper',
      mac: '02:00:00:00:00:10',
      present: true,
      missingSince: null,
    })
    assert.deepInclude(lan1, { key: 'lan1', label: 'Desk', labelOverride: 'Desk', present: false })
    assert.match(lan1.missingSince, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/)
  })
})
