import Collector from '#models/collector'
import { handleCollectorPush } from '#services/collector_agent'
import { apiKeyFingerprint } from '#services/collector_announce'
import { pollOnce } from '#services/collector_poller'
import {
  assertMergeRegistryMatchesSchema,
  repointGatewayObservations,
} from '#services/collector_merge'
import { handleAgentObservation, recordGatewayObservationSerial } from '#services/gateway_observe'
import { pruneGatewayObservations } from '#services/gateway_observation_retention'
import { updatePresenceSettings } from '#services/presence_settings'
import { eventually, seedSetupComplete } from '#tests/helpers/ap_agent'
import {
  FakeCollector,
  TEST_API_KEY,
  TEST_INSTANCE_ID,
  device,
  reading,
} from '#tests/helpers/collector_agent'
import { closeAgentSessions, resetInfraTests } from '#tests/helpers/infra'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'

/**
 * The observation channel, server side (docs/gateway/observation.md;
 * plan-2-native-sync.md sections 3 and 7, the T-O tests that need no
 * router). Placeholders: 192.168.x.x LANs, 203.0.113.x WAN, 02:00:00 MACs.
 */

const C1 = '02:00:00:99:00:01' // lan client
const C2 = '02:00:00:99:00:02' // lan client, silent
const G1 = '02:00:00:99:00:11' // guest client (not captured)
const NAS = '02:00:00:99:00:30'
const UPSTREAM = '02:00:00:99:00:fe' // the ISP modem, on the WAN

const FUTURE = Math.floor(Date.now() / 1000) + 3600

function interfaces() {
  return [
    {
      network: 'lan',
      device: 'br-lan',
      ipv4: ['192.168.10.1/24'],
      ipv6: ['fd00:10::1/64'],
      up: true,
      proto: 'static',
    },
    { network: 'guest', device: 'br-guest', ipv4: ['192.168.20.1/24'], up: true },
    {
      network: 'wan',
      device: 'eth1',
      ipv4: ['203.0.113.2/24'],
      ipv6: [],
      up: true,
      proto: 'dhcp',
      defaultRoute: true,
      metric: 1,
      uptimeSeconds: 3600,
      gateway4: '203.0.113.1',
      dnsServers: ['203.0.113.53'],
    },
    {
      network: 'wanb',
      device: 'eth2',
      ipv4: ['203.0.113.130/25'],
      up: true,
      proto: 'dhcp',
      defaultRoute: true,
      metric: 2,
    },
  ]
}

function dhcp(overrides: { leases4?: unknown[]; hosts?: unknown[] } = {}) {
  return {
    leases4: overrides.leases4 ?? [
      { mac: C1, ip: '192.168.10.21', hostname: 'c1', expires: FUTURE, source: 'dnsmasq' },
      { mac: C2, ip: '192.168.10.22', hostname: 'c2', expires: FUTURE, source: 'dnsmasq' },
      {
        mac: G1,
        ip: '192.168.20.31',
        hostname: 'g1',
        expires: FUTURE,
        source: 'dnsmasq',
        network: 'guest',
      },
    ],
    leases6: [],
    pools: [
      { network: 'lan', ignore: false, leaseTime: 43200, start: 100, limit: 150 },
      { network: 'guest', ignore: false, leaseTime: 3600 },
    ],
    hosts: overrides.hosts ?? [{ name: 'nas', macs: [NAS], ip: '192.168.10.30' }],
  }
}

/** A neighbour entry as perch-collector sends it (`state` in lower case). */
function neighbor(ip: string, mac: string, ifname: string, reachable: boolean) {
  return {
    ip,
    mac,
    device: ifname,
    network: ifname === 'br-lan' ? 'lan' : undefined,
    reachable,
    state: reachable ? 'reachable' : 'stale',
  }
}

function neighbors(reachable: Record<string, boolean> = {}) {
  return [
    neighbor('192.168.10.21', C1, 'br-lan', reachable[C1] ?? true),
    neighbor('fd00:10::21', C1, 'br-lan', reachable[C1] ?? true),
    neighbor('192.168.10.22', C2, 'br-lan', reachable[C2] ?? true),
    neighbor('192.168.10.30', NAS, 'br-lan', reachable[NAS] ?? false),
    { ip: '203.0.113.1', mac: UPSTREAM, device: 'eth1', reachable: true, state: 'reachable' },
    // FAILED entries carry no MAC; broadcast is never a device.
    { ip: '192.168.10.99', mac: null, device: 'br-lan', reachable: false },
    { ip: '192.168.10.255', mac: 'ff:ff:ff:ff:ff:ff', device: 'br-lan', reachable: true },
  ]
}

function upnp(mappings?: unknown[]) {
  return {
    installed: true,
    enabled: true,
    running: true,
    mappings: mappings ?? [
      {
        proto: 'TCP',
        extPort: 51413,
        intIp: '192.168.10.21',
        intPort: 51413,
        expires: 0,
        description: 'torrent',
      },
      { proto: 'udp', extPort: 3074, intIp: '192.168.10.22', intPort: 3074, expires: FUTURE },
    ],
  }
}

/** The live gateway's shape: mwan3 configured, its service disabled. */
function mwan3() {
  return {
    serviceEnabled: false,
    running: false,
    configInterfaces: [
      { name: 'wan', enabled: true, family: 'ipv4', trackIps: ['203.0.113.1'] },
      { name: 'wanb', enabled: true, family: 'ipv4', trackIps: [] },
    ],
    interfaces: [],
    policies: {},
    configPolicies: { balanced: ['wan_m1', 'wanb_m1'] },
  }
}

function fullObservation() {
  return {
    seq: 1,
    collectedAt: '2026-09-23T10:00:00Z',
    full: true,
    interfaces: interfaces(),
    dhcp: dhcp(),
    neighbors: neighbors(),
    upnp: upnp(),
    mwan3: mwan3(),
    resolver: {
      dnsmasqPort: 54,
      port53Process: 'AdGuardHome',
      port53Processes: ['AdGuardHome'],
      controllerHost: { name: 'perch.example.com', addresses: ['192.168.10.10'] },
    },
    system: {
      hostname: 'gateway',
      release: 'OpenWrt 24.10.2',
      version: '24.10.2',
      model: 'QEMU Standard PC',
      board: 'x86/64',
      uptimeSeconds: 123456,
      flowOffloadingHw: false,
      privateNotes: 'dropped by the normaliser',
    },
    wireguard: {
      interfaces: [
        {
          name: 'wg0',
          publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          privateKey: 'must-never-be-stored',
          listenPort: 51820,
          peers: [
            {
              publicKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=',
              presharedKey: 'must-never-be-stored',
              endpoint: '203.0.113.50:51820',
              allowedIps: ['10.0.0.2/32'],
              latestHandshake: 1790000000,
              rxBytes: 10,
              txBytes: 20,
            },
          ],
        },
      ],
    },
  }
}

async function seedSocketCollector(fields: Partial<Collector> = {}) {
  return Collector.create({
    name: 'gateway',
    baseUrl: null,
    transport: 'agent',
    instanceId: TEST_INSTANCE_ID,
    source: 'announced',
    lifecycle: 'adopted',
    enabled: true,
    pollIntervalSeconds: 5,
    version: '1.0.0',
    apiKey: TEST_API_KEY,
    apiKeyFingerprint: apiKeyFingerprint(TEST_API_KEY),
    lastStatus: {
      ok: true,
      checkedAt: '2026-09-23T10:00:00Z',
      gateway: {
        reportedAt: '2026-09-23T10:00:00Z',
        wanInterfaces: ['eth1', 'eth2'],
        wanSource: 'default-route',
      },
    },
    ...fields,
  } as Partial<Collector>)
}

/** POST responses are typed `unknown` by the route registry; read them loosely. */
function body(response: { body(): unknown }): Record<string, any> {
  return response.body() as Record<string, any>
}

async function hosts(collectorId: number) {
  const rows = await db.from('gateway_hosts').where('collector_id', collectorId).orderBy('mac')
  return Object.fromEntries(rows.map((r) => [r.mac, r]))
}

async function seenAgo(collectorId: number, mac: string, column: string): Promise<number | null> {
  const [rows] = await db.rawQuery(
    `SELECT TIMESTAMPDIFF(SECOND, ${column}, UTC_TIMESTAMP()) AS ago FROM gateway_hosts
      WHERE collector_id = ? AND mac = ?`,
    [collectorId, mac]
  )
  const ago = rows[0]?.ago
  return ago === null || ago === undefined ? null : Number(ago)
}

async function seedIdentity(collectorId: number, mac: string, ip: string, minutesAgo: number) {
  const at = DateTime.utc().minus({ minutes: minutesAgo }).toFormat('yyyy-MM-dd HH:mm:ss')
  await db.table('device_identities').insert({
    collector_id: collectorId,
    mac,
    primary_ip: ip,
    ips: JSON.stringify([ip]),
    first_seen_at: at,
    last_seen_at: at,
    created_at: at,
    updated_at: at,
  })
}

test.group('gateway observation | ingest', (group) => {
  group.each.setup(resetInfraTests)
  group.each.teardown(closeAgentSessions)

  test('gateway.observed (notification) is accepted like a push', async ({ assert }) => {
    const row = await seedSocketCollector()
    const collector = await FakeCollector.connect()
    await collector.hello({ capabilities: ['gateway_stats', 'observe.neighbors'] })
    await collector.waitFor('agent.configure')
    collector.notifyServer('gateway.observed', { neighbors: neighbors() })
    await eventually(
      () => db.from('gateway_hosts').where({ collector_id: row.id, mac: C1 }).first(),
      (host) => Boolean(host)
    )
    const mirrored = await hosts(row.id)
    assert.equal(mirrored[C1].neighbor_ipv4, '192.168.10.21')
    await collector.close()
  })

  test('collector.push observe over the socket fills every mirror (T-O1, server side)', async ({
    assert,
  }) => {
    const row = await seedSocketCollector()
    const collector = await FakeCollector.connect()
    await collector.hello({
      capabilities: [
        'gateway_stats',
        'gateway.observe',
        'observe.dhcp',
        'observe.neighbors',
        'observe.upnp',
      ],
    })
    await collector.waitFor('agent.configure')
    const observe: Record<string, unknown> = fullObservation()
    delete observe.seq
    delete observe.collectedAt
    collector.notifyServer('collector.push', {
      ...reading([device(C1, { bytesIn: 1, bytesOut: 1 })]),
      observe,
    })
    // The network refresh runs after every part: the WAN neighbour gets its network last.
    await eventually(
      () => db.from('gateway_hosts').where({ collector_id: row.id, mac: UPSTREAM }).first(),
      (host) => host?.network === 'wan'
    )

    const h = await hosts(row.id)
    assert.sameMembers(Object.keys(h), [C1, C2, G1, NAS, UPSTREAM])
    assert.equal(h[C1].hostname, 'c1')
    assert.equal(h[C1].network, 'lan')
    assert.equal(h[G1].network, 'guest', 'the guest lease is on the guest network')
    assert.equal(h[UPSTREAM].network, 'wan')
    assert.equal(h[C1].neighbor_ipv4, '192.168.10.21')
    assert.deepEqual(JSON.parse(h[C1].neighbor_ipv6), ['fd00:10::21'])
    assert.equal(Number(h[C1].neighbor_reachable), 1)
    assert.equal(Number(h[NAS].neighbor_reachable), 0)
    assert.isNull(h[NAS].neighbor_seen_at, 'a stale entry is no sighting')
    assert.isNotNull(h[C1].neighbor_seen_at)
    assert.equal(Number(h[G1].neighbor_present), 0)
    assert.equal(h[NAS].static_name, 'nas')

    const mappings = await db.from('gateway_upnp_mappings').orderBy('ext_port')
    assert.deepEqual(
      mappings.map((m) => [m.proto, m.ext_port, m.mac]),
      [
        ['UDP', 3074, C2],
        ['TCP', 51413, C1],
      ]
    )
    const events = await db.from('gateway_upnp_events').orderBy('ext_port')
    assert.deepEqual(
      events.map((e) => e.event),
      ['opened', 'opened']
    )

    const observationRows = await db.from('gateway_observations').where('collector_id', row.id)
    const kinds = observationRows.map((r) => r.kind)
    assert.includeMembers(kinds, [
      'interfaces',
      'dhcp',
      'neighbors',
      'upnp',
      'mwan3',
      'resolver',
      'system',
      'wireguard',
    ])
    const wg = await db
      .from('gateway_observations')
      .where({ collector_id: row.id, kind: 'wireguard' })
      .first()
    assert.notInclude(wg.payload, 'must-never-be-stored', 'private keys are never stored')
    const system = await db
      .from('gateway_observations')
      .where({ collector_id: row.id, kind: 'system' })
      .first()
    assert.notInclude(system.payload, 'privateNotes')
    await collector.close()
  })

  test('the push form: observe with any part rides collector.push (backward compatible)', async ({
    assert,
  }) => {
    const row = await seedSocketCollector()
    const outcome = await handleCollectorPush(
      row.id,
      {
        ...reading([device(C1, { bytesIn: 1, bytesOut: 1 })]),
        observe: { dhcp: dhcp(), neighbors: neighbors() },
      },
      { receivedAt: DateTime.utc() }
    )
    assert.equal(outcome.status, 'ingested')
    const h = await hosts(row.id)
    assert.equal(h[C1].hostname, 'c1')
    assert.equal(Number(h[C1].neighbor_present), 1)
    assert.equal(h[C1].network, 'lan', "the agent's own network, no interfaces reported yet")
  })

  test('absent parts erase nothing; [] clears; unchanged rewrites nothing', async ({ assert }) => {
    const row = await seedSocketCollector()
    await recordGatewayObservationSerial(row.id, fullObservation())
    const before = await db
      .from('gateway_observations')
      .where({ collector_id: row.id, kind: 'neighbors' })
      .first()

    // A report of the system only: every mirror stays.
    const onlySystem = await recordGatewayObservationSerial(row.id, {
      system: { hostname: 'gateway', release: 'OpenWrt 24.10.2' },
    })
    assert.deepEqual(onlySystem.parts, { system: 'written' })
    assert.lengthOf(Object.keys(await hosts(row.id)), 5)
    assert.lengthOf(await db.from('gateway_upnp_mappings'), 2)

    // Same neighbours again: no row rewritten.
    const same = await recordGatewayObservationSerial(row.id, { neighbors: neighbors() })
    assert.deepEqual(same.parts, { neighbors: 'unchanged' })
    const after = await db
      .from('gateway_observations')
      .where({ collector_id: row.id, kind: 'neighbors' })
      .first()
    assert.equal(String(after.changed_at), String(before.changed_at))

    // No mappings any more: the mirror empties, two `closed` events.
    await recordGatewayObservationSerial(row.id, { upnp: upnp([]) })
    assert.lengthOf(await db.from('gateway_upnp_mappings'), 0)
    const closed = await db.from('gateway_upnp_events').where('event', 'closed')
    assert.lengthOf(closed, 2)
    assert.sameMembers(
      closed.map((e) => e.mac),
      [C1, C2]
    )

    // Empty neighbour table: rows without a lease or a sighting go, the rest stay.
    await recordGatewayObservationSerial(row.id, { neighbors: [] })
    const h = await hosts(row.id)
    assert.equal(Number(h[C1].neighbor_present), 0)
    assert.isNotNull(h[C1].neighbor_seen_at, 'the sighting is kept')
    assert.exists(h[UPSTREAM], 'sighted before: kept for the retention period')
    assert.isNull(h[UPSTREAM].neighbor_ipv4)
  })

  test('a lease that goes: the row loses its DHCP facts, is kept only with a sighting', async ({
    assert,
  }) => {
    const row = await seedSocketCollector()
    // No pools: nothing dates a renewal, so G1 has no sighting.
    await recordGatewayObservationSerial(row.id, {
      dhcp: { ...dhcp(), pools: [] },
      neighbors: neighbors({ [C2]: false }),
    })
    await recordGatewayObservationSerial(row.id, {
      dhcp: dhcp({
        leases4: [
          { mac: C1, ip: '192.168.10.21', hostname: 'c1', expires: FUTURE, source: 'dnsmasq' },
        ],
      }),
    })
    const h = await hosts(row.id)
    assert.notExists(h[G1], 'no neighbour, no sighting: gone')
    assert.exists(h[C2], 'still in the neighbour table')
    assert.equal(Number(h[C2].dhcp_present), 0)
    assert.isNull(h[C2].hostname)
    assert.equal(h[C2].neighbor_ipv4, '192.168.10.22')
  })

  test('hosts left out of the dhcp part keep the previous static hosts', async ({ assert }) => {
    const row = await seedSocketCollector()
    await recordGatewayObservationSerial(row.id, { dhcp: dhcp() })
    const withoutHosts = dhcp()
    delete (withoutHosts as { hosts?: unknown }).hosts
    const outcome = await recordGatewayObservationSerial(row.id, { dhcp: withoutHosts })
    assert.equal(outcome.parts.dhcp, 'unchanged', 'same leases, same static hosts')
    const kept = await hosts(row.id)
    assert.equal(kept[NAS].static_name, 'nas')
  })

  test('DHCP renewals are sightings: a moved expiry, or a short known lease time', async ({
    assert,
  }) => {
    const row = await seedSocketCollector()
    const nowS = Math.floor(Date.now() / 1000)
    await recordGatewayObservationSerial(row.id, {
      dhcp: dhcp({
        leases4: [
          { mac: C1, ip: '192.168.10.21', expires: nowS + 60 },
          // 2-minute leases (T-O2): renewed 30 s ago.
          { mac: C2, ip: '192.168.10.22', expires: nowS + 90, leaseTime: 120 },
          // The live gateway: 1200-day leases, nothing to date.
          { mac: G1, ip: '192.168.20.31', expires: nowS + 1200 * 86400, leaseTime: 1200 * 86400 },
        ],
      }),
    })
    assert.isNull(await seenAgo(row.id, C1, 'dhcp_seen_at'), 'first sight is no renewal')
    const c2 = await seenAgo(row.id, C2, 'dhcp_seen_at')
    assert.isNotNull(c2)
    assert.closeTo(c2!, 30, 5)
    assert.isNull(await seenAgo(row.id, G1, 'dhcp_seen_at'))

    // C1 renews: its expiry moves forward.
    await recordGatewayObservationSerial(row.id, {
      dhcp: dhcp({
        leases4: [
          { mac: C1, ip: '192.168.10.21', expires: nowS + 120 },
          { mac: C2, ip: '192.168.10.22', expires: nowS + 90, leaseTime: 120 },
          { mac: G1, ip: '192.168.20.31', expires: nowS + 1200 * 86400, leaseTime: 1200 * 86400 },
        ],
      }),
    })
    const c1 = await seenAgo(row.id, C1, 'dhcp_seen_at')
    assert.isNotNull(c1)
    assert.isAtMost(c1!, 3)
  })

  test('a pool lease time of at most 24 h dates renewals (perch-collector `pools`)', async ({
    assert,
  }) => {
    const row = await seedSocketCollector()
    const nowS = Math.floor(Date.now() / 1000)
    await recordGatewayObservationSerial(row.id, {
      dhcp: {
        pools: [
          { network: 'lan', ignore: false, leaseTime: 120 },
          { network: 'guest', ignore: false, leaseTime: 0 },
        ],
        leases4: [
          { mac: C2, ip: '192.168.10.22', expires: nowS + 100, network: 'lan' },
          { mac: G1, ip: '192.168.20.31', expires: 0, network: 'guest' },
        ],
        leases6: [],
        hosts: [],
      },
    })
    const c2 = await seenAgo(row.id, C2, 'dhcp_seen_at')
    assert.closeTo(c2!, 20, 5)
    assert.isNull(await seenAgo(row.id, G1, 'dhcp_seen_at'), 'infinite pool: nothing to date')
    const h = await hosts(row.id)
    assert.equal(h[G1].network, 'guest', "the lease's own network without interfaces")
  })

  test('unchanged neighbour reports still refresh the reachable sightings', async ({ assert }) => {
    const row = await seedSocketCollector()
    const t0 = DateTime.utc().minus({ minutes: 20 })
    await recordGatewayObservationSerial(row.id, { neighbors: neighbors() }, t0)
    const first = await seenAgo(row.id, C1, 'neighbor_seen_at')
    assert.closeTo(first!, 1200, 5)
    await recordGatewayObservationSerial(row.id, { neighbors: neighbors() }, DateTime.utc())
    const second = await seenAgo(row.id, C1, 'neighbor_seen_at')
    assert.isAtMost(second!, 3)
    assert.isNull(await seenAgo(row.id, NAS, 'neighbor_seen_at'), 'not reachable: no sighting')
  })

  test('an interfaces report re-derives the network of every host', async ({ assert }) => {
    const row = await seedSocketCollector()
    await recordGatewayObservationSerial(row.id, { dhcp: dhcp(), neighbors: neighbors() })
    const before = await hosts(row.id)
    assert.isNull(before[UPSTREAM].network, 'the agent names no network on the WAN')
    await recordGatewayObservationSerial(row.id, { interfaces: interfaces() })
    const h = await hosts(row.id)
    assert.equal(h[C1].network, 'lan')
    assert.equal(h[G1].network, 'guest')
    assert.equal(h[UPSTREAM].network, 'wan')
  })

  test('a UPnP mapping that changes target is a close and an open', async ({ assert }) => {
    const row = await seedSocketCollector()
    await recordGatewayObservationSerial(row.id, { dhcp: dhcp(), upnp: upnp() })
    await recordGatewayObservationSerial(row.id, {
      upnp: upnp([
        { proto: 'TCP', extPort: 51413, intIp: '192.168.10.22', intPort: 51413, expires: 0 },
        { proto: 'UDP', extPort: 3074, intIp: '192.168.10.22', intPort: 3074, expires: FUTURE },
      ]),
    })
    const events = await db.from('gateway_upnp_events').orderBy('id')
    assert.deepEqual(
      events.map((e) => [e.event, e.ext_port, e.mac]),
      [
        ['opened', 51413, C1],
        ['opened', 3074, C2],
        ['closed', 51413, C1],
        ['opened', 51413, C2],
      ]
    )
    const mapping = await db.from('gateway_upnp_mappings').where('ext_port', 51413).first()
    assert.equal(mapping.mac, C2)
  })

  test('not adopted, disabled or polled rows keep nothing from the socket', async ({ assert }) => {
    const pending = await seedSocketCollector({ lifecycle: 'pending' })
    assert.isNull(await handleAgentObservation(pending.id, fullObservation()))
    await pending.merge({ lifecycle: 'adopted', enabled: false }).save()
    assert.isNull(await handleAgentObservation(pending.id, fullObservation()))
    await pending.merge({ enabled: true, transport: 'poll' }).save()
    assert.isNull(await handleAgentObservation(pending.id, fullObservation()))
    assert.lengthOf(await db.from('gateway_hosts'), 0)
    assert.lengthOf(await db.from('gateway_observations'), 0)
  })

  test('junk parts are dropped part by part, never the others', async ({ assert }) => {
    const row = await seedSocketCollector()
    const result = await recordGatewayObservationSerial(row.id, {
      neighbors: 'not a list',
      interfaces: { not: 'a list' },
      upnp: [],
      mwan3: 42,
      dhcp: dhcp(),
      system: { hostname: 'x'.repeat(400), uptimeSeconds: -5 },
    })
    assert.deepEqual(result.parts, {
      interfaces: 'invalid',
      neighbors: 'invalid',
      dhcp: 'written',
      upnp: 'invalid',
      mwan3: 'invalid',
      system: 'written',
    })
    const system = await db.from('gateway_observations').where('kind', 'system').first()
    assert.deepInclude(JSON.parse(system.payload), { hostname: null, uptimeSeconds: null })
  })

  test('the HTTP poll path reads every part from the summary', async ({ assert }) => {
    const collector = await Collector.create({
      name: 'gateway',
      baseUrl: 'http://192.168.10.1:9800',
      transport: 'poll',
      source: 'manual',
      lifecycle: 'adopted',
      enabled: true,
      pollIntervalSeconds: 5,
      apiKey: null,
      lastStatus: null,
    })
    const params = reading([device(C1, { bytesIn: 1000, bytesOut: 2000 })])
    const fetcher = (async (url: Parameters<typeof fetch>[0]) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '')
      const payload =
        path === '/api/v1/summary'
          ? {
              summary: params.summary,
              meta: params.meta,
              observe: { neighbors: neighbors(), interfaces: interfaces() },
            }
          : path === '/api/v1/devices'
            ? { devices: params.devices }
            : null
      if (payload === null) return new Response('{}', { status: 404 })
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    await pollOnce(collector, { now: () => DateTime.utc(), fetcher })
    const h = await hosts(collector.id)
    assert.equal(h[C1].network, 'lan')
  })
})

test.group('gateway observation | presence (gatewaySightings)', (group) => {
  group.each.setup(resetInfraTests)
  group.each.teardown(closeAgentSessions)

  test('a silent device the gateway still sees is connected via lan (T-O2, server side)', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const row = await seedSocketCollector()
    // Its last traffic was 45 min ago: past the 30 min quiet limit.
    await seedIdentity(row.id, C2, '192.168.10.22', 45)

    const presence = async () => {
      const response = await client.get(`/api/v1/devices/${C2}/presence`).bearerToken(adminToken)
      response.assertStatus(200)
      return response.body().data
    }
    assert.include(await presence(), { status: 'disconnected', via: 'lan' })

    await recordGatewayObservationSerial(row.id, { neighbors: neighbors() })
    const seen = await presence()
    assert.include(seen, { status: 'connected', via: 'lan' })
    assert.isAtMost(Date.now() - Date.parse(seen.lastSeenAt), 5000)

    // The setting off: traffic only again.
    await updatePresenceSettings({ gatewaySightings: 0 })
    assert.include(await presence(), { status: 'disconnected', via: 'lan' })
    await updatePresenceSettings({ gatewaySightings: 1 })

    // The device stops answering: after lanQuietMinutes it is gone.
    await db
      .from('gateway_hosts')
      .where('mac', C2)
      .update({
        neighbor_seen_at: DateTime.utc().minus({ minutes: 31 }).toFormat('yyyy-MM-dd HH:mm:ss'),
      })
    assert.include(await presence(), { status: 'disconnected', via: 'lan' })
  })

  test('the device list reads the same sightings', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const row = await seedSocketCollector()
    const bucket = DateTime.utc().minus({ minutes: 50 }).toFormat('yyyy-MM-dd HH:mm:ss')
    await db.table('device_traffic_buckets').insert({
      collector_id: row.id,
      mac: C2,
      bucket_start: bucket,
      bytes_in: 5000,
      bytes_out: 2000,
      packets_in: 50,
      packets_out: 20,
      bytes_in_wan: 5000,
      bytes_out_wan: 2000,
      created_at: bucket,
      updated_at: bucket,
    })
    await seedIdentity(row.id, C2, '192.168.10.22', 50)
    await recordGatewayObservationSerial(row.id, { neighbors: neighbors() })
    const response = await client.get('/api/v1/devices?range=24h').bearerToken(adminToken)
    response.assertStatus(200)
    const c2 = response.body().data.find((d: { mac: string }) => d.mac === C2)
    assert.include(c2.presence, { status: 'connected', via: 'lan' })
  })
})

test.group('gateway observation | REST', (group) => {
  group.each.setup(resetInfraTests)
  group.each.teardown(closeAgentSessions)

  test('leases: lease facts per network, known devices named, guest ones without traffic', async ({
    client,
    assert,
  }) => {
    const { operatorToken } = await seedSetupComplete()
    const row = await seedSocketCollector()
    await seedIdentity(row.id, C1, '192.168.10.21', 1)
    await recordGatewayObservationSerial(row.id, fullObservation())

    const all = await client
      .get(`/api/v1/gateways/${row.id}/dhcp/leases`)
      .bearerToken(operatorToken)
    all.assertStatus(200)
    const data = all.body().data
    assert.isFalse(data.stale)
    assert.isString(data.observedAt)
    assert.deepEqual(
      data.leases.map((l: { mac: string }) => l.mac),
      [C1, C2, G1],
      'static hosts without a lease are not leases'
    )
    const c1 = data.leases[0]
    assert.deepInclude(c1, {
      family: 4,
      ip: '192.168.10.21',
      hostname: 'c1',
      network: 'lan',
      infinite: false,
      reservationId: null,
      device: { mac: C1, name: 'c1' },
    })
    assert.isString(c1.expiresAt)
    assert.isString(c1.seenAt)
    assert.isNull(data.leases[2].device, 'the guest client has no traffic data')

    const guest = await client
      .get(`/api/v1/gateways/${row.id}/dhcp/leases?network=guest`)
      .bearerToken(operatorToken)
    assert.deepEqual(
      guest.body().data.leases.map((l: { mac: string }) => l.mac),
      [G1]
    )
  })

  test('neighbours, interfaces, UPnP, WAN status for any user', async ({ client, assert }) => {
    const { operatorToken } = await seedSetupComplete()
    const row = await seedSocketCollector()
    await recordGatewayObservationSerial(row.id, fullObservation())

    const neighborsRes = await client
      .get(`/api/v1/gateways/${row.id}/neighbors`)
      .bearerToken(operatorToken)
    neighborsRes.assertStatus(200)
    const c1 = neighborsRes.body().data.neighbors.find((n: { mac: string }) => n.mac === C1)
    assert.deepInclude(c1, {
      ipv4: '192.168.10.21',
      ipv6: ['fd00:10::21'],
      ifname: 'br-lan',
      network: 'lan',
      reachable: true,
      hostname: 'c1',
    })

    const ifaces = await client
      .get(`/api/v1/gateways/${row.id}/interfaces`)
      .bearerToken(operatorToken)
    assert.deepEqual(
      ifaces.body().data.interfaces.map((i: { network: string }) => i.network),
      ['guest', 'lan', 'wan', 'wanb']
    )

    const upnpRes = await client.get(`/api/v1/gateways/${row.id}/upnp`).bearerToken(operatorToken)
    upnpRes.assertStatus(200)
    assert.include(upnpRes.body().data, { enabled: true, installed: true, running: true })
    assert.deepInclude(upnpRes.body().data.mappings[0], {
      proto: 'TCP',
      externalPort: 51413,
      internalIp: '192.168.10.21',
      internalPort: 51413,
      description: 'torrent',
      expiresAt: null,
      device: { mac: C1, name: null },
    })
    assert.lengthOf(upnpRes.body().data.events, 2)

    const wan = await client.get(`/api/v1/gateways/${row.id}/wan-status`).bearerToken(operatorToken)
    wan.assertStatus(200)
    const w = wan.body().data
    assert.deepEqual(w.defaultRoutes, ['eth1', 'eth2'], 'lowest metric first')
    assert.deepEqual(
      w.wans.map((x: { network: string; metric: number }) => [x.network, x.metric]),
      [
        ['wan', 1],
        ['wanb', 2],
      ]
    )
    // mwan3 configured but its service disabled: config and service apart.
    assert.deepEqual(w.mwan3.service, { installed: true, enabled: false, running: false })
    assert.deepEqual(w.mwan3.interfaces, [])
    assert.deepEqual(
      w.mwan3.configInterfaces.map((i: { name: string }) => i.name),
      ['wan', 'wanb']
    )
    assert.deepEqual(w.mwan3.configPolicies, { balanced: ['wan_m1', 'wanb_m1'] })
    assert.include(w.wans[0], { gateway4: '203.0.113.1' })
    assert.deepEqual(w.wans[0].dnsServers, ['203.0.113.53'])
  })

  test('system and WireGuard are admin-only; features and resolver from the parts', async ({
    client,
    assert,
  }) => {
    const { adminToken, operatorToken } = await seedSetupComplete()
    const row = await seedSocketCollector()
    await recordGatewayObservationSerial(row.id, fullObservation())

    const denied = await client.get(`/api/v1/gateways/${row.id}/system`).bearerToken(operatorToken)
    denied.assertStatus(403)
    const wgDenied = await client
      .get(`/api/v1/gateways/${row.id}/wireguard`)
      .bearerToken(operatorToken)
    wgDenied.assertStatus(403)

    const system = await client.get(`/api/v1/gateways/${row.id}/system`).bearerToken(adminToken)
    system.assertStatus(200)
    const s = system.body().data
    assert.include(s, {
      hostname: 'gateway',
      release: 'OpenWrt 24.10.2',
      board: 'x86/64',
      uptimeSeconds: 123456,
      flowOffloadingHw: false,
      timezone: null,
    })
    assert.include(s, { version: '24.10.2', model: 'QEMU Standard PC' })
    assert.deepEqual(s.resolver, {
      dnsmasqPort: 54,
      port53Process: 'AdGuardHome',
      port53Processes: ['AdGuardHome'],
      controllerHost: { name: 'perch.example.com', addresses: ['192.168.10.10'], error: null },
    })
    const feature = (name: string) => s.features.find((f: { name: string }) => f.name === name)
    assert.deepEqual(feature('upnp'), { name: 'upnp', installed: true, decision: 'observe' })
    assert.deepEqual(feature('adguardhome'), {
      name: 'adguardhome',
      installed: true,
      decision: 'never',
    })
    assert.equal(feature('mwan3').installed, true)
    assert.isNull(feature('sqm').installed, 'no package list: unknown')

    const wg = await client.get(`/api/v1/gateways/${row.id}/wireguard`).bearerToken(adminToken)
    wg.assertStatus(200)
    assert.equal(wg.body().data.interfaces[0].peers[0].endpoint, '203.0.113.50:51820')
    assert.notProperty(wg.body().data.interfaces[0], 'privateKey')
  })

  test('overview: parts, capabilities while online; 404 and 401', async ({ client, assert }) => {
    const { operatorToken } = await seedSetupComplete()
    const row = await seedSocketCollector()
    const collector = await FakeCollector.connect()
    await collector.hello({ capabilities: ['gateway_stats', 'observe.dhcp'] })
    await collector.waitFor('agent.configure')
    await recordGatewayObservationSerial(row.id, { dhcp: dhcp() })

    const overview = await client
      .get(`/api/v1/gateways/${row.id}/observation`)
      .bearerToken(operatorToken)
    overview.assertStatus(200)
    const o = overview.body().data
    assert.include(o, { gatewayId: row.id, name: 'gateway', online: true, transport: 'agent' })
    assert.deepEqual(o.capabilities, ['gateway_stats', 'observe.dhcp'])
    assert.deepInclude(o.parts.dhcp.counts, { leases4: 3, rows: 4 })
    await collector.close()

    const offline = await client
      .get(`/api/v1/gateways/${row.id}/observation`)
      .bearerToken(operatorToken)
    assert.isNull(offline.body().data.capabilities)

    const missing = await client.get('/api/v1/gateways/9999/upnp').bearerToken(operatorToken)
    missing.assertStatus(404)
    assert.equal(missing.body().error, 'gateway_not_found')

    // The seeded poll collector reports nothing: not a gateway.
    const plain = await Collector.findByOrFail('name', 'localhost')
    const notGateway = await client
      .get(`/api/v1/gateways/${plain.id}/upnp`)
      .bearerToken(operatorToken)
    notGateway.assertStatus(404)

    const anonymous = await client.get(`/api/v1/gateways/${row.id}/dhcp/leases`)
    anonymous.assertStatus(401)
  })

  test('device network card: lease, neighbour, UPnP; 400 for a bad MAC', async ({
    client,
    assert,
  }) => {
    const { operatorToken } = await seedSetupComplete()
    const row = await seedSocketCollector()
    await recordGatewayObservationSerial(row.id, fullObservation())

    const response = await client.get(`/api/v1/devices/${C1}/network`).bearerToken(operatorToken)
    response.assertStatus(200)
    const d = response.body().data
    assert.equal(d.gatewayId, row.id)
    assert.include(d.lease, { ip: '192.168.10.21', network: 'lan', hostname: 'c1' })
    assert.isNull(d.reservation)
    assert.isNull(d.dnsName)
    assert.isNull(d.wanBlocked)
    assert.deepInclude(d.neighbor, { ipv4: '192.168.10.21', reachable: true })
    assert.lengthOf(d.upnp, 1)
    assert.equal(d.upnp[0].externalPort, 51413)

    const unknown = await client
      .get('/api/v1/devices/02:00:00:99:00:77/network')
      .bearerToken(operatorToken)
    assert.include(unknown.body().data, { gatewayId: null, lease: null })

    const bad = await client.get('/api/v1/devices/not-a-mac/network').bearerToken(operatorToken)
    bad.assertStatus(400)
    assert.equal(bad.body().error, 'invalid_mac')
  })

  test('POST observe: offline 409, capability missing 409, else the agent answers', async ({
    client,
    assert,
  }) => {
    const { adminToken, operatorToken } = await seedSetupComplete()
    const row = await seedSocketCollector()
    await recordGatewayObservationSerial(row.id, { dhcp: dhcp() })
    const url = `/api/v1/gateways/${row.id}/observe`

    const offline = await client.post(url).bearerToken(adminToken).json({})
    offline.assertStatus(409)
    assert.equal(body(offline).error, 'gateway_offline')

    const viewer = await client.post(url).bearerToken(operatorToken).json({})
    viewer.assertStatus(403)

    // An older collector: parts, but no `gateway.observe`.
    const older = await FakeCollector.connect()
    await older.hello({ capabilities: ['gateway_stats', 'observe.dhcp'] })
    await older.waitFor('agent.configure')
    const noRequest = await client.post(url).bearerToken(adminToken).json({})
    noRequest.assertStatus(409)
    assert.equal(body(noRequest).error, 'gateway_capability_missing')
    assert.equal(body(noRequest).capability, 'gateway.observe')
    await older.close()

    const requested: unknown[] = []
    const collector = await FakeCollector.connect({
      handlers: {
        'gateway.observe': (params) => {
          requested.push(params)
          return { seq: 9, full: true, neighbors: neighbors(), interfaces: interfaces() }
        },
      },
    })
    await collector.hello({
      capabilities: [
        'gateway_stats',
        'gateway.observe',
        'observe.dhcp',
        'observe.neighbors',
        'observe.interfaces',
      ],
    })
    await collector.waitFor('agent.configure')

    const missing = await client
      .post(url)
      .bearerToken(adminToken)
      .json({ parts: ['upnp'] })
    missing.assertStatus(409)
    assert.equal(body(missing).error, 'gateway_capability_missing')
    assert.equal(body(missing).capability, 'observe.upnp')

    const bad = await client
      .post(url)
      .bearerToken(adminToken)
      .json({ parts: ['nonsense'] })
    bad.assertStatus(422)

    const ok = await client
      .post(url)
      .bearerToken(adminToken)
      .json({ parts: ['neighbors'] })
    ok.assertStatus(200)
    assert.isString(body(ok).data.observedAt)
    assert.deepEqual(body(ok).data.parts, { interfaces: 'written', neighbors: 'written' })
    assert.deepEqual(requested, [{ parts: ['neighbors'] }])
    const refreshed = await hosts(row.id)
    assert.equal(refreshed[C1].network, 'lan')
    await collector.close()
  })

  test('backups: pull, list, download (admin), prune to backupsKept', async ({
    client,
    assert,
  }) => {
    const { adminToken, operatorToken } = await seedSetupComplete()
    const row = await seedSocketCollector()
    const archive = gzipSync(Buffer.from('etc/config/network contents'))
    const sha = createHash('sha256').update(archive).digest('hex')
    // perch-collector's answer (its CONFIG.md, "Backups").
    let answer: Record<string, unknown> = {
      filename: 'backup-gateway-2026-09-23.tar.gz',
      createdAt: '2026-09-23T10:00:00Z',
      release: 'OpenWrt 24.10.2',
      size: archive.length,
      sha256: sha,
      redacted: true,
      redactions: [
        { file: '/etc/config/wireless', option: 'key' },
        { file: '/etc/uhttpd.key', removed: true },
      ],
      contentBase64: archive.toString('base64'),
    }
    const backupParams: unknown[] = []
    const collector = await FakeCollector.connect({
      handlers: {
        'gateway.backup': (params) => {
          backupParams.push(params)
          return answer
        },
      },
    })
    await collector.hello({ capabilities: ['gateway_stats', 'gateway.backup'] })
    await collector.waitFor('agent.configure')
    const url = `/api/v1/gateways/${row.id}/backups`

    const denied = await client.post(url).bearerToken(operatorToken).json({})
    denied.assertStatus(403)

    const created = await client.post(url).bearerToken(adminToken).json({ note: 'before VLANs' })
    created.assertStatus(201)
    const b = body(created).data
    assert.include(b, {
      size: archive.length,
      sha256: sha,
      release: 'OpenWrt 24.10.2',
      filename: 'backup-gateway-2026-09-23.tar.gz',
      redacted: true,
    })
    assert.deepEqual(b.redactions, [
      { file: '/etc/config/wireless', option: 'key', removed: false },
      { file: '/etc/uhttpd.key', option: null, removed: true },
    ])
    assert.equal(b.note, 'before VLANs')
    assert.deepEqual(backupParams, [{ redact: true }], 'redacted unless asked otherwise')

    const stored = await db.from('gateway_backups').where('id', b.id).first()
    assert.notInclude(
      Buffer.from(stored.content).toString('utf8'),
      archive.toString('base64'),
      'encrypted at rest'
    )

    const list = await client.get(url).bearerToken(adminToken)
    list.assertStatus(200)
    assert.lengthOf(body(list).data, 1)
    assert.notProperty(body(list).data[0], 'content')

    const download = await client.get(`${url}/${b.id}/download`).bearerToken(adminToken)
    download.assertStatus(200)
    assert.equal(download.header('content-type'), 'application/gzip')
    const viewerDownload = await client.get(`${url}/${b.id}/download`).bearerToken(operatorToken)
    viewerDownload.assertStatus(403)
    const missing = await client.get(`${url}/999999/download`).bearerToken(adminToken)
    missing.assertStatus(404)

    answer = { ...answer, sha256: '0'.repeat(64) }
    const mismatch = await client.post(url).bearerToken(adminToken).json({})
    mismatch.assertStatus(502)
    assert.equal(body(mismatch).error, 'backup_failed')

    answer = { contentBase64: Buffer.alloc(9 * 1024 * 1024, 1).toString('base64') }
    const tooLarge = await client.post(url).bearerToken(adminToken).json({})
    tooLarge.assertStatus(413)

    // Keep 2: the third push drops the oldest.
    await client
      .patch('/api/v1/settings/gateway-observations')
      .bearerToken(adminToken)
      .json({ backupsKept: 2 })
    answer = { contentBase64: archive.toString('base64') }
    for (let i = 0; i < 2; i++) {
      const next = await client.post(url).bearerToken(adminToken).json({})
      next.assertStatus(201)
    }
    const kept = await db.from('gateway_backups').orderBy('id')
    const ids = kept.map((r) => r.id)
    assert.lengthOf(ids, 2)
    assert.notInclude(ids, b.id)
    await collector.close()

    const offline = await client.post(url).bearerToken(adminToken).json({})
    offline.assertStatus(409)
    assert.equal(body(offline).error, 'gateway_offline')
  })
})

test.group('gateway observation | settings, retention, merge', (group) => {
  group.each.setup(resetInfraTests)
  group.each.teardown(closeAgentSessions)

  test('settings: defaults, patch, 422, admin-only', async ({ client, assert }) => {
    const { adminToken, operatorToken } = await seedSetupComplete()
    const url = '/api/v1/settings/gateway-observations'
    const read = await client.get(url).bearerToken(adminToken)
    read.assertStatus(200)
    assert.deepEqual(read.body().data.settings, {
      hostRetentionDays: 14,
      upnpEventRetentionDays: 90,
      backupsKept: 10,
    })
    const patched = await client.patch(url).bearerToken(adminToken).json({ hostRetentionDays: 7 })
    patched.assertStatus(200)
    assert.equal(patched.body().data.settings.hostRetentionDays, 7)
    assert.equal(patched.body().data.settings.backupsKept, 10)
    const invalid = await client.patch(url).bearerToken(adminToken).json({ backupsKept: 0 })
    invalid.assertStatus(422)
    const denied = await client.get(url).bearerToken(operatorToken)
    denied.assertStatus(403)
  })

  test('retention: absent hosts after hostRetentionDays, old UPnP events', async ({ assert }) => {
    const row = await seedSocketCollector()
    await recordGatewayObservationSerial(row.id, fullObservation())
    await recordGatewayObservationSerial(row.id, { neighbors: [] })
    const old = DateTime.utc().minus({ days: 15 }).toFormat('yyyy-MM-dd HH:mm:ss')
    await db.from('gateway_hosts').where('mac', UPSTREAM).update({ last_reported_at: old })
    await db.from('gateway_upnp_events').where('ext_port', 3074).update({ at: old })
    await db
      .from('gateway_upnp_events')
      .where('ext_port', 51413)
      .update({ at: DateTime.utc().minus({ days: 91 }).toFormat('yyyy-MM-dd HH:mm:ss') })

    const result = await pruneGatewayObservations()
    assert.deepEqual(result, { hosts: 1, upnpMappings: 0, upnpEvents: 1, backups: 0 })
    const h = await hosts(row.id)
    assert.notExists(h[UPSTREAM])
    assert.exists(h[C1], 'a leased host stays however old its report')
  })

  test('merge: mirrors follow --into, events and backups of both sides stay', async ({
    assert,
  }) => {
    await assertMergeRegistryMatchesSchema()
    const oldRow = await seedSocketCollector({ instanceId: null, name: 'old' })
    const newRow = await seedSocketCollector({
      instanceId: 'aa11bb22cc33dd44ee55ff6677889900',
      name: 'new',
    })
    await recordGatewayObservationSerial(oldRow.id, fullObservation())
    await recordGatewayObservationSerial(newRow.id, {
      upnp: upnp([
        { proto: 'TCP', extPort: 8080, intIp: '192.168.10.40', intPort: 80, expires: 0 },
      ]),
    })
    await db.transaction(async (trx) => {
      await repointGatewayObservations(trx, {
        survivorId: oldRow.id,
        removedId: newRow.id,
        intoId: newRow.id,
      })
    })
    const mappings = await db.from('gateway_upnp_mappings')
    assert.deepEqual(
      mappings.map((m) => [m.collector_id, m.ext_port]),
      [[oldRow.id, 8080]],
      "the survivor now holds into's mirror only"
    )
    const events = await db.from('gateway_upnp_events')
    assert.lengthOf(events, 3)
    assert.isTrue(events.every((e) => e.collector_id === oldRow.id))
  })
})
