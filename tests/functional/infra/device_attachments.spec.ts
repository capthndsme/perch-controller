import Collector from '#models/collector'
import { getDeviceLabels, saveDeviceLabel } from '#services/device_labels'
import { recordAgentPorts } from '#services/infra_ports'
import { loadDeviceAttachments } from '#services/infra_topology'
import { getPresenceSettings } from '#services/presence_settings'
import { seedSetupComplete } from '#tests/helpers/ap_agent'
import {
  apPorts,
  closeAgentSessions,
  onlineAp,
  resetInfraTests,
  seedDevice,
  seedLink,
  seedManualNode,
  seedScrapeAp,
  setLastSeen,
} from '#tests/helpers/infra'
import db from '@adonisjs/lucid/services/db'
import type { ApiClient } from '@japa/api-client'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

/**
 * Amendment A4 items 5 and 6 (docs/infrastructure-view.md): where a device is
 * on the map (`attachment` on `/devices` and `/devices/:mac/presence`), and
 * what its cable adds to its presence on every surface that shows it.
 */

const NODES = '/api/v1/infra/nodes'

async function created(client: ApiClient, token: string, body: Record<string, unknown>) {
  const response = await client.post(NODES).bearerToken(token).json(body)
  response.assertStatus(201)
  return response.body().data
}

/** `/devices` rows keyed by MAC. */
async function deviceRows(client: ApiClient, token: string, query = '') {
  const response = await client.get(`/api/v1/devices${query}`).bearerToken(token)
  response.assertStatus(200)
  const rows = (response.body() as { data: Array<{ mac: string }> }).data
  return new Map<string, any>(rows.map((row) => [row.mac, row]))
}

async function presenceOf(client: ApiClient, token: string, mac: string) {
  const response = await client.get(`/api/v1/devices/${mac}/presence`).bearerToken(token)
  response.assertStatus(200)
  return response.body().data
}

async function attachmentOf(client: ApiClient, token: string, mac: string) {
  const presence = await presenceOf(client, token, mac)
  return presence.attachment
}

async function statePresence(client: ApiClient, token: string, nodeId: number) {
  const response = await client.get('/api/v1/infra/state').bearerToken(token)
  response.assertStatus(200)
  return response.body().data.nodes.find((node: { id: number }) => node.id === nodeId).presence
}

/** Every SQL statement the default connection runs while `fn` does. */
async function queriesDuring(fn: () => Promise<unknown>): Promise<string[]> {
  const knex = db.connection().getWriteClient()
  const seen: string[] = []
  const listener = (query: { sql: string }) => seen.push(query.sql)
  knex.on('query', listener)
  try {
    await fn()
  } finally {
    knex.removeListener('query', listener)
  }
  return seen
}

const SECOND = 1000

test.group('infra | devices on the map', (group) => {
  group.each.setup(resetInfraTests)
  group.each.teardown(closeAgentSessions)

  test('/devices rows and /devices/:mac/presence say where the device is on the map', async ({
    client,
    assert,
  }) => {
    const { adminToken, operatorToken } = await seedSetupComplete()
    const [collector] = await Collector.all()
    const ap = await onlineAp(
      'ap-garage',
      '02:00:00:00:00:10',
      apPorts({ lan2: { speedMbps: 100 } })
    )
    const macs = {
      camera: '02:00:00:00:00:31',
      pc: '02:00:00:00:00:32',
      phone: '02:00:00:00:00:33',
      nas: '02:00:00:00:00:34',
    }
    for (const mac of Object.values(macs)) await seedDevice(collector.id, mac, { secondsAgo: 60 })
    await saveDeviceLabel(macs.camera, { name: 'Garage camera', deviceType: 'camera' })

    // The camera on the AP's lan2 (a live agent port), the PC on an unmanaged
    // switch hanging off lan1, the NAS placed but not cabled, the phone nowhere.
    const camera = await created(client, adminToken, {
      kind: 'device',
      deviceMac: macs.camera,
      linkTo: { portId: ap.ports.lan2 },
    })
    const sw = await created(client, adminToken, {
      kind: 'switch',
      name: 'Desk switch',
      portCount: 4,
      linkTo: { portId: ap.ports.lan1, ownPortKey: '1' },
    })
    const swPort3 = sw.node.ports.find((port: { key: string }) => port.key === '3').id
    const pc = await created(client, adminToken, {
      kind: 'device',
      deviceMac: macs.pc,
      linkTo: { portId: swPort3 },
    })
    const nas = await created(client, adminToken, { kind: 'device', deviceMac: macs.nas })

    const rows = await deviceRows(client, operatorToken)
    const cameraAttachment = {
      nodeId: camera.node.id,
      nodeName: 'Garage camera',
      uplink: {
        linkId: camera.link.id,
        medium: 'ethernet',
        nodeId: ap.nodeId,
        nodeName: 'ap-garage',
        nodeKind: 'access_point',
        portId: ap.ports.lan2,
        portKey: 'lan2',
        portLabel: 'lan2',
        live: true,
        up: true,
        speedMbps: 100,
        duplex: 'full',
      },
    }
    assert.deepEqual(rows.get(macs.camera).attachment, cameraAttachment)
    assert.deepEqual(rows.get(macs.pc).attachment, {
      nodeId: pc.node.id,
      nodeName: macs.pc,
      uplink: {
        linkId: pc.link.id,
        medium: 'ethernet',
        nodeId: sw.node.id,
        nodeName: 'Desk switch',
        nodeKind: 'switch',
        portId: swPort3,
        portKey: '3',
        portLabel: '3',
        // An unmanaged switch has no link state of its own to give.
        live: false,
        up: null,
        speedMbps: null,
        duplex: null,
      },
    })
    assert.deepEqual(rows.get(macs.nas).attachment, {
      nodeId: nas.node.id,
      nodeName: macs.nas,
      uplink: null,
    })
    assert.isNull(rows.get(macs.phone).attachment)

    const presence = await presenceOf(client, operatorToken, macs.camera)
    assert.deepEqual(Object.keys(presence).sort(), ['attachment', 'lastSeenAt', 'status', 'via'])
    assert.deepEqual(presence.attachment, cameraAttachment)
    assert.isNull(await attachmentOf(client, operatorToken, macs.phone))

    // The AP goes silent: its port can no longer be believed.
    await setLastSeen('wifi_access_points', ap.apId, 600)
    const silent = await presenceOf(client, operatorToken, macs.camera)
    assert.deepInclude(silent.attachment.uplink, {
      live: false,
      up: null,
      speedMbps: null,
      duplex: null,
    })
  })

  test('the uplink is the cabled port with the lowest position; names follow the device', async ({
    client,
    assert,
  }) => {
    const { adminToken, operatorToken } = await seedSetupComplete()
    const [collector] = await Collector.all()
    const mac = '02:00:00:00:00:41'
    const switchMac = '02:00:00:00:00:42'
    await seedDevice(collector.id, mac)
    await saveDeviceLabel(mac, { name: 'Media box' })
    await saveDeviceLabel(switchMac, { name: 'Office switch' })

    // The far end is a switch that carries a device of its own, with no name.
    const sw = await created(client, adminToken, { kind: 'switch', deviceMac: switchMac })
    const port = (key: string) => sw.node.ports.find((row: { key: string }) => row.key === key).id
    const box = await created(client, adminToken, {
      kind: 'device',
      deviceMac: mac,
      portCount: 2,
      linkTo: { portId: port('2'), ownPortKey: 'eth1' },
    })
    let { attachment } = await presenceOf(client, operatorToken, mac)
    assert.deepInclude(attachment, { nodeId: box.node.id, nodeName: 'Media box' })
    assert.deepInclude(attachment.uplink, {
      linkId: box.link.id,
      nodeName: 'Office switch',
      nodeKind: 'switch',
      portKey: '2',
    })

    // A cable on eth0 (position 0) makes that the uplink.
    const first = await seedLink(box.node.ports[0].id, port('1'))
    attachment = await attachmentOf(client, operatorToken, mac)
    assert.deepInclude(attachment.uplink, { linkId: first, portKey: '1' })

    // The operator's names win, on both ends.
    await client.patch(`${NODES}/${sw.node.id}`).bearerToken(adminToken).json({ name: 'Rack' })
    await client.patch(`${NODES}/${box.node.id}`).bearerToken(adminToken).json({ name: 'TV box' })
    attachment = await attachmentOf(client, operatorToken, mac)
    assert.equal(attachment.nodeName, 'TV box')
    assert.equal(attachment.uplink.nodeName, 'Rack')
    const rows = await deviceRows(client, operatorToken)
    assert.deepEqual(rows.get(mac).attachment, attachment)
  })

  test('a wired device goes by its traffic or the link of the port it is cabled to', async ({
    client,
    assert,
  }) => {
    const { adminToken, operatorToken } = await seedSetupComplete()
    const [collector] = await Collector.all()
    const ap = await onlineAp(
      'ap-garage',
      '02:00:00:00:00:10',
      apPorts({ lan3: { carrier: false } })
    )
    const quiet = '02:00:00:00:00:51'
    const talking = '02:00:00:00:00:52'
    const radio = '02:00:00:00:00:53'
    await seedDevice(collector.id, quiet, { secondsAgo: 45 * 60 })
    await seedDevice(collector.id, talking, { secondsAgo: 60 })
    await seedDevice(collector.id, radio, { secondsAgo: 45 * 60 })
    // lan3 lost its link 20 minutes ago.
    await db.rawQuery(
      `UPDATE infra_ports SET state_changed_at = UTC_TIMESTAMP() - INTERVAL 1200 SECOND WHERE id = ?`,
      [ap.ports.lan3]
    )
    const place = async (deviceMac: string, linkTo: Record<string, unknown>) => {
      const { node } = await created(client, adminToken, { kind: 'device', deviceMac, linkTo })
      return Number(node.id)
    }
    const nodes = {
      quiet: await place(quiet, { portId: ap.ports.lan1 }),
      talking: await place(talking, { portId: ap.ports.lan3 }),
      radio: await place(radio, { portId: ap.ports.lan2, medium: 'wireless' }),
    }

    /** The presence of each device on all three surfaces, which must agree. */
    const presences = async () => {
      const rows = await deviceRows(client, operatorToken)
      const out: Record<string, any> = {}
      for (const [name, mac] of Object.entries({ quiet, talking, radio })) {
        const fromRow = rows.get(mac).presence
        const fromEndpoint = await presenceOf(client, operatorToken, mac)
        const fromState = await statePresence(client, operatorToken, nodes[name as 'quiet'])
        for (const other of [fromEndpoint, fromState]) {
          assert.equal(other.status, fromRow.status, name)
          assert.equal(other.via, fromRow.via, name)
          assert.isBelow(
            Math.abs(Date.parse(other.lastSeenAt) - Date.parse(fromRow.lastSeenAt)),
            3 * SECOND,
            name
          )
        }
        out[name] = fromRow
      }
      return out
    }
    const near = (iso: string, secondsAgo: number) =>
      Math.abs(Date.parse(iso) - (Date.now() - secondsAgo * SECOND)) < 5 * SECOND

    // Quiet for 45 minutes, but the AP's lan1 has link: connected, seen at the
    // AP's last report (5 s ago). The talking one on the dead lan3: its traffic
    // wins. A wireless cable says nothing about a wire.
    let now = await presences()
    assert.deepInclude(now.quiet, { status: 'connected', via: 'ethernet' })
    assert.isTrue(near(now.quiet.lastSeenAt, 5), now.quiet.lastSeenAt)
    assert.deepInclude(now.talking, { status: 'connected', via: 'ethernet' })
    assert.isTrue(near(now.talking.lastSeenAt, 60), now.talking.lastSeenAt)
    assert.deepInclude(now.radio, { status: 'disconnected', via: 'lan' })

    // lan1 loses its link (10 minutes ago): gone since then.
    await recordAgentPorts(
      { type: 'ap', id: ap.apId },
      apPorts({ lan1: { carrier: false }, lan3: { carrier: false } }),
      DateTime.utc()
    )
    await db.rawQuery(
      `UPDATE infra_ports SET state_changed_at = UTC_TIMESTAMP() - INTERVAL 600 SECOND WHERE id = ?`,
      [ap.ports.lan1]
    )
    now = await presences()
    assert.deepInclude(now.quiet, { status: 'disconnected', via: 'ethernet' })
    assert.isTrue(near(now.quiet.lastSeenAt, 600), now.quiet.lastSeenAt)
    assert.deepInclude(now.talking, { status: 'connected', via: 'ethernet' })

    // The AP goes silent: its ports say nothing; traffic alone decides.
    await setLastSeen('wifi_access_points', ap.apId, 600)
    now = await presences()
    assert.deepInclude(now.quiet, { status: 'disconnected', via: 'ethernet' })
    assert.isTrue(near(now.quiet.lastSeenAt, 45 * 60), now.quiet.lastSeenAt)
    assert.deepInclude(now.talking, { status: 'connected', via: 'ethernet' })
  })

  test('attachments are read per request, never from the cached device rows', async ({
    client,
    assert,
  }) => {
    const { adminToken, operatorToken } = await seedSetupComplete()
    const [collector] = await Collector.all()
    const mac = '02:00:00:00:00:61'
    await seedDevice(collector.id, mac, { secondsAgo: 30 * 60 })
    // A window that ended ten minutes ago: its rows are kept for hours.
    const from = DateTime.utc().minus({ hours: 1 }).toISO()
    const to = DateTime.utc().minus({ minutes: 10 }).toISO()
    const window = `?from=${encodeURIComponent(from!)}&to=${encodeURIComponent(to!)}`
    const fresh = await deviceRows(client, operatorToken, window)
    assert.isNull(fresh.get(mac).attachment)

    const { node } = await created(client, adminToken, { kind: 'device', deviceMac: mac })
    await db.from('device_traffic_buckets').where('mac', mac).delete()
    const again = await deviceRows(client, operatorToken, window)
    const cached = again.get(mac)
    assert.exists(cached, 'the rows came from the cache')
    assert.deepEqual(cached.attachment, { nodeId: node.id, nodeName: mac, uplink: null })
  })

  test('attachments cost a fixed number of queries, whatever the number of devices', async ({
    assert,
  }) => {
    await seedSetupComplete()
    const thresholds = await getPresenceSettings()
    const macs = Array.from(
      { length: 30 },
      (_, i) => `02:00:00:00:02:${String(i).padStart(2, '0')}`
    )
    await getDeviceLabels(macs)

    // None on the map: one query.
    const none = await queriesDuring(() => loadDeviceAttachments(macs, thresholds))
    assert.lengthOf(none, 1)

    // One device on a bound node's port (the agent rows are read), unnamed
    // (its hostname is looked up).
    const scrape = await seedScrapeAp('ap-attic')
    const apNode = await seedManualNode('access_point', 'unused', ['wan', 'lan1'], {
      ap_id: scrape.id,
      origin: 'agent',
      name: null,
    })
    const sw = await seedManualNode(
      'switch',
      'Rack',
      Array.from({ length: 24 }, (_, i) => String(i + 1))
    )
    const place = async (mac: string, farPortId: number) => {
      const node = await seedManualNode('device', 'x', ['eth0'], { device_mac: mac, name: null })
      await seedLink(node.ports.eth0, farPortId)
    }
    await place(macs[0], apNode.ports.lan1)
    // Warm the hostname lookup's gateway-agent cache (one query a minute at
    // most), so both measured calls see the same per-request statements.
    await loadDeviceAttachments(macs, thresholds)
    const one = await queriesDuring(() => loadDeviceAttachments(macs, thresholds))
    const placedOne = await loadDeviceAttachments(macs, thresholds)
    assert.equal(placedOne.get(macs[0])?.attachment.uplink?.nodeName, 'ap-attic')

    // Twenty-one devices on the map: the same queries.
    for (let i = 1; i <= 20; i++) await place(macs[i], sw.ports[String(i)])
    const many = await queriesDuring(() => loadDeviceAttachments(macs, thresholds))
    const placedMany = await loadDeviceAttachments(macs, thresholds)
    assert.equal(placedMany.size, 21)
    // The same statements; only the length of an IN list differs.
    const shape = (sql: string) => sql.replace(/\?(, \?)*/g, '?')
    assert.deepEqual(many.map(shape), one.map(shape))
    assert.isAtMost(one.length, 5, one.join('\n'))
  })
})
