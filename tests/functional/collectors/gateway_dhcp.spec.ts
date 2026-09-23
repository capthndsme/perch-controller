import Collector from '#models/collector'
import { handleCollectorPush } from '#services/collector_agent'
import { apiKeyFingerprint } from '#services/collector_announce'
import { pollOnce } from '#services/collector_poller'
import { AGENT_FRESH_SECONDS } from '#services/gateway_dhcp'
import {
  resetHostnameEnrichmentCacheForTesting,
  setHostnameCommandRunnerForTesting,
} from '#services/hostname_enrichment'
import {
  HOSTNAME_ENRICHMENT_MODE,
  setHostnameEnrichmentSettings,
  type HostnameEnrichmentSettings,
} from '#services/hostname_enrichment_settings'
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
import type { ApiClient } from '@japa/api-client'
import { DateTime } from 'luxon'

const LAPTOP = '02:00:00:00:10:21'
const PHONE = '02:00:00:00:10:22'
const NAS = '02:00:00:00:10:30'
const T0 = DateTime.utc().minus({ minutes: 10 }).startOf('second')

/** An `observe.dhcp` section as perch-collector sends it (docs/collector-agent.md 4.3). */
function dhcp(
  overrides: {
    leases4?: unknown[]
    leases6?: unknown[]
    hosts?: unknown[]
  } = {}
) {
  return {
    leases4: overrides.leases4 ?? [
      {
        mac: LAPTOP,
        ip: '192.168.1.21',
        hostname: 'laptop',
        expires: 1790000000,
        source: 'dnsmasq',
      },
      { mac: PHONE, ip: '192.168.1.22', expires: 0, source: 'dnsmasq' },
      { mac: NAS, ip: '192.168.1.30', hostname: 'nas-lease', expires: 0, source: 'dnsmasq' },
    ],
    leases6: overrides.leases6 ?? [
      {
        duid: '000100012abcdef0020000001022',
        iaid: 1,
        addresses: ['fd00::22'],
        hostname: 'phone',
        validUntil: 1790003600,
        source: 'dnsmasq',
      },
    ],
    hosts: overrides.hosts ?? [
      { name: 'nas', macs: [NAS], ip: '192.168.1.30' },
      { name: 'printer', macs: [], ip: '192.168.1.40' },
    ],
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
    lastStatus: null,
    ...fields,
  } as Partial<Collector>)
}

/** A push at T0 + seconds, with `observe` when given. */
function push(collectorId: number, seconds: number, observe?: Record<string, unknown>) {
  return handleCollectorPush(
    collectorId,
    {
      ...reading([device(LAPTOP, { bytesIn: 1000 + seconds, bytesOut: 2000 })]),
      ...(observe ? { observe } : {}),
    },
    { receivedAt: T0.plus({ seconds }) }
  )
}

async function hostRows() {
  const rows = await db
    .from('gateway_hosts')
    .select('collector_id', 'mac', 'hostname', 'static_name', 'ipv4', 'ipv6', 'lease_infinite')
    .orderBy('mac')
  return Object.fromEntries(rows.map((r) => [r.mac, r]))
}

async function observation(collectorId: number) {
  return db.from('gateway_observations').where({ collector_id: collectorId, kind: 'dhcp' }).first()
}

async function seedIdentity(collectorId: number, mac: string, ip: string) {
  const now = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')
  const bucketStart = DateTime.utc().minus({ seconds: 2 }).toFormat('yyyy-MM-dd HH:mm:ss')
  await db.table('device_traffic_buckets').insert({
    collector_id: collectorId,
    mac,
    bucket_start: bucketStart,
    bytes_in: 5000,
    bytes_out: 2000,
    packets_in: 50,
    packets_out: 20,
    bytes_in_wan: 5000,
    bytes_out_wan: 2000,
    created_at: now,
    updated_at: now,
  })
  await db.table('device_identities').insert({
    collector_id: collectorId,
    mac,
    primary_ip: ip,
    ips: JSON.stringify([ip]),
    first_seen_at: now,
    last_seen_at: now,
    created_at: now,
    updated_at: now,
  })
}

async function namesFromDevices(client: ApiClient, token: string) {
  const response = await client.get('/api/v1/devices').bearerToken(token)
  response.assertStatus(200)
  return Object.fromEntries(
    (
      response.body().data as { mac: string; hostname: string | null; hostnameSource: string }[]
    ).map((d) => [d.mac, [d.hostname, d.hostnameSource]])
  )
}

const lxcSettings: HostnameEnrichmentSettings = {
  enabled: true,
  mode: HOSTNAME_ENRICHMENT_MODE,
  transport: 'lxc',
  leaseFilePath: '/tmp/dhcp.leases',
  refreshSeconds: 60,
  timeoutMs: 1500,
  lxc: { containerName: 'openwrt' },
}

test.group('gateway agent | observe.dhcp ingest', (group) => {
  group.each.setup(resetInfraTests)
  group.each.teardown(closeAgentSessions)
  group.each.teardown(() => setHostnameCommandRunnerForTesting(null))

  test('a push with observe.dhcp fills gateway_hosts, one row per MAC', async ({ assert }) => {
    const row = await seedSocketCollector()
    const outcome = await push(row.id, 0, { dhcp: dhcp() })
    assert.equal(outcome.status, 'ingested')

    const hosts = await hostRows()
    assert.deepEqual(Object.keys(hosts), [LAPTOP, PHONE, NAS])
    assert.equal(hosts[LAPTOP].hostname, 'laptop')
    assert.equal(hosts[LAPTOP].ipv4, '192.168.1.21')
    // The phone's IPv4 lease has no name; its DHCPv6 lease (DUID-LLT with its MAC) does.
    assert.equal(hosts[PHONE].hostname, 'phone')
    assert.deepEqual(JSON.parse(hosts[PHONE].ipv6), ['fd00::22'])
    assert.equal(Number(hosts[PHONE].lease_infinite), 1)
    assert.equal(hosts[NAS].static_name, 'nas')
    assert.equal(hosts[NAS].hostname, 'nas-lease')

    const obs = await observation(row.id)
    assert.exists(obs)
    const payload = JSON.parse(obs.payload)
    assert.include(payload, { leases4: 3, leases6: 1, hosts: 2, rows: 3, named: 3 })
    assert.deepEqual(payload.ipOnlyHosts, [{ name: 'printer', ip: '192.168.1.40' }])
  })

  test('absent = nothing new; unchanged = no rewrite; a removed lease goes; [] clears', async ({
    assert,
  }) => {
    const row = await seedSocketCollector()
    await push(row.id, 0, { dhcp: dhcp() })
    const first = await observation(row.id)

    // A push without observe changes nothing.
    await push(row.id, 5)
    assert.lengthOf(Object.keys(await hostRows()), 3)

    // The same section again: the fingerprint matches, no row is rewritten.
    await push(row.id, 10, { dhcp: dhcp() })
    const again = await observation(row.id)
    assert.equal(String(again.changed_at), String(first.changed_at))
    assert.equal(again.fingerprint, first.fingerprint)

    // The phone's lease is gone (and its DHCPv6 lease with it).
    await push(row.id, 15, {
      dhcp: dhcp({
        leases4: [
          { mac: LAPTOP, ip: '192.168.1.21', hostname: 'laptop', expires: 0, source: 'dnsmasq' },
        ],
        leases6: [],
      }),
    })
    assert.deepEqual(Object.keys(await hostRows()), [LAPTOP, NAS])

    // Everything empty: no rows, but the agent still reports (it just has none).
    await push(row.id, 20, { dhcp: { leases4: [], leases6: [], hosts: [] } })
    assert.deepEqual(Object.keys(await hostRows()), [])
    assert.exists(await observation(row.id))
  })

  test('weird input: "*", control characters, bad MACs and addresses, duplicates', async ({
    assert,
  }) => {
    const row = await seedSocketCollector()
    await push(row.id, 0, {
      dhcp: {
        leases4: [
          { mac: LAPTOP, ip: '192.168.1.21', hostname: '*', expires: 1790000000 },
          { mac: LAPTOP, ip: '192.168.1.21', hostname: 'late\u0007name', expires: 1790009999 },
          { mac: 'not-a-mac', ip: '192.168.1.23', hostname: 'x', expires: 0 },
          { mac: PHONE, ip: 'fd00::1', hostname: 'v6-in-v4', expires: 0 },
          { mac: NAS, ip: '192.168.1.30', hostname: 'a'.repeat(300), expires: 0 },
          'garbage',
        ],
        leases6: [{ duid: 'zz', addresses: ['fd00::9'], validUntil: 0 }],
        hosts: [
          { name: '', macs: [PHONE] },
          { name: 'ok', macs: ['020000001022'] },
        ],
      },
    })
    const hosts = await hostRows()
    assert.deepEqual(Object.keys(hosts), [LAPTOP, PHONE, NAS])
    assert.equal(hosts[LAPTOP].hostname, 'latename')
    assert.isNull(hosts[NAS].hostname, 'over 253 characters is dropped')
    assert.equal(hosts[PHONE].static_name, 'ok', 'a bare 12-hex MAC is accepted')
  })

  test('the observation is recorded even when the traffic push is dropped as too early', async ({
    assert,
  }) => {
    const row = await seedSocketCollector()
    await push(row.id, 0)
    const early = await push(row.id, 1, { dhcp: dhcp() })
    assert.deepEqual(early, { status: 'dropped', reason: 'too_early' })
    assert.lengthOf(Object.keys(await hostRows()), 3)
  })

  test('a collector that is not adopted, or disabled, writes nothing', async ({ assert }) => {
    const pending = await seedSocketCollector({ lifecycle: 'pending' })
    await push(pending.id, 0, { dhcp: dhcp() })
    await pending.merge({ lifecycle: 'adopted', enabled: false }).save()
    await push(pending.id, 10, { dhcp: dhcp() })
    assert.deepEqual(Object.keys(await hostRows()), [])
  })

  test('over the socket: FakeCollector push lands in gateway_hosts', async ({ assert }) => {
    const row = await seedSocketCollector()
    const collector = await FakeCollector.connect()
    await collector.hello()
    await collector.waitFor('agent.configure')
    collector.notifyServer('collector.push', {
      ...reading([device(LAPTOP, { bytesIn: 1, bytesOut: 1 })]),
      observe: { dhcp: dhcp() },
    })
    await eventually(
      () => observation(row.id),
      (obs) => Boolean(obs)
    )
    assert.lengthOf(Object.keys(await hostRows()), 3)
    await collector.close()
  })

  test('the HTTP poll path reads observe from the summary', async ({ assert }) => {
    const collector = await Collector.create({
      name: 'gateway',
      baseUrl: 'http://192.168.1.1:9800',
      transport: 'poll',
      source: 'manual',
      lifecycle: 'adopted',
      enabled: true,
      pollIntervalSeconds: 5,
      apiKey: null,
      lastStatus: null,
    })
    const params = reading([device(LAPTOP, { bytesIn: 1000, bytesOut: 2000 })])
    const fetcher = (async (url: Parameters<typeof fetch>[0]) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '')
      const body =
        path === '/api/v1/summary'
          ? { summary: params.summary, meta: params.meta, observe: { dhcp: dhcp() } }
          : path === '/api/v1/devices'
            ? { devices: params.devices }
            : null
      if (body === null) return new Response('{}', { status: 404 })
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    await pollOnce(collector, { now: () => T0, fetcher })
    assert.lengthOf(Object.keys(await hostRows()), 3)
  })
})

test.group('gateway agent | hostnames from the agent', (group) => {
  group.each.setup(resetInfraTests)
  group.each.teardown(closeAgentSessions)
  group.each.teardown(() => setHostnameCommandRunnerForTesting(null))

  test('zero configuration: device names come from the agent, static names win', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const row = await seedSocketCollector()
    await seedIdentity(row.id, LAPTOP, '192.168.1.21')
    await seedIdentity(row.id, NAS, '192.168.1.30')
    await seedIdentity(row.id, '02:00:00:00:10:40', '192.168.1.40')
    let commands = 0
    setHostnameCommandRunnerForTesting(async () => {
      commands++
      return ''
    })

    await push(row.id, 0, { dhcp: dhcp() })
    const names = await namesFromDevices(client, adminToken)
    assert.deepEqual(names[LAPTOP], ['laptop', 'dhcp_lease'])
    assert.deepEqual(names[NAS], ['nas', 'openwrt_static'])
    assert.deepEqual(
      names['02:00:00:00:10:40'],
      ['printer', 'openwrt_static'],
      'a static host without a MAC matches by address'
    )
    assert.equal(commands, 0, 'hostname enrichment is off by default: no command runs')

    // A static host added on the router shows up with the next report.
    const withTv = dhcp()
    ;(withTv.hosts as unknown[]).push({ name: 'laptop-static', macs: [LAPTOP] })
    await push(row.id, 5, { dhcp: withTv })
    const after = await namesFromDevices(client, adminToken)
    assert.deepEqual(after[LAPTOP], ['laptop-static', 'openwrt_static'])
  })

  test('the lxc/ssh path stands by while an agent reports, and takes over when it goes', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const row = await seedSocketCollector()
    await seedIdentity(row.id, LAPTOP, '192.168.1.21')
    await setHostnameEnrichmentSettings(lxcSettings)
    let commands = 0
    setHostnameCommandRunnerForTesting(async (_settings, command) => {
      commands++
      return command[0] === 'cat' ? `0 ${LAPTOP} 192.168.1.21 from-lxc *\n` : ''
    })

    await push(row.id, 0, { dhcp: dhcp() })
    const agentNames = await namesFromDevices(client, adminToken)
    assert.deepEqual(agentNames[LAPTOP], ['laptop', 'dhcp_lease'])
    assert.equal(commands, 0, 'no lxc exec while the agent provides the data')

    const sources = await client
      .get('/api/v1/settings/hostname-enrichment/sources')
      .bearerToken(adminToken)
    sources.assertStatus(200)
    assert.isTrue(sources.body().data.agentActive)
    assert.equal(sources.body().data.commandPath, 'standby')
    assert.lengthOf(sources.body().data.agents, 1)
    assert.include(sources.body().data.agents[0], {
      collectorId: row.id,
      name: 'gateway',
      active: true,
      leases4: 3,
      leases6: 1,
      staticHosts: 2,
      namedDevices: 3,
    })

    // The agent went quiet for longer than any refresh interval: fallback.
    await db
      .from('gateway_observations')
      .where('collector_id', row.id)
      .update({
        observed_at: DateTime.utc()
          .minus({ seconds: AGENT_FRESH_SECONDS + 60 })
          .toFormat('yyyy-MM-dd HH:mm:ss'),
      })
    resetHostnameEnrichmentCacheForTesting()
    const fallbackNames = await namesFromDevices(client, adminToken)
    assert.deepEqual(fallbackNames[LAPTOP], ['from-lxc', 'dhcp_lease'])
    assert.isAbove(commands, 0)
    const stale = await client
      .get('/api/v1/settings/hostname-enrichment/sources')
      .bearerToken(adminToken)
    assert.isFalse(stale.body().data.agentActive)
    assert.equal(stale.body().data.commandPath, 'active')
    assert.isFalse(stale.body().data.agents[0].active)
  })

  test('the sources endpoint is admin-only and empty without agents', async ({
    client,
    assert,
  }) => {
    const { adminToken, operatorToken } = await seedSetupComplete()
    const empty = await client
      .get('/api/v1/settings/hostname-enrichment/sources')
      .bearerToken(adminToken)
    empty.assertStatus(200)
    assert.deepEqual(empty.body().data, { agentActive: false, commandPath: 'off', agents: [] })

    const denied = await client
      .get('/api/v1/settings/hostname-enrichment/sources')
      .bearerToken(operatorToken)
    denied.assertStatus(403)
  })
})
