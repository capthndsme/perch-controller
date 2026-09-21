import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import { writeDestinationBuckets, writeProtocolBuckets } from '#services/bucket_writer'
import { _resetPollerState, pollOnce } from '#services/collector_poller'
import { registeredDomain } from '#services/destination_history'
import { getProtocolCategoryMap, upsertProtocolCategories } from '#services/protocol_categories'
import { _resetQueryCache } from '#services/query_cache'
import { backfillRollups } from '#services/rollup_maintainer'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  _resetQueryCache()
  _resetPollerState()
  return teardown
}

async function bootstrap() {
  const admin = await User.create({
    fullName: 'Admin',
    email: 'admin@example.com',
    password: 'admin-pass-123',
    role: 'admin',
  })
  const token = await User.accessTokens.create(admin)
  await SystemSetting.set('site_name', 'Perch @ test')
  await SystemSetting.set('timezone', 'UTC')
  const collector = await Collector.create({
    name: 'localhost',
    baseUrl: 'http://127.0.0.1:9800',
    pollIntervalSeconds: 5,
    enabled: true,
    apiKey: null,
    lastStatus: { ok: true, checkedAt: DateTime.utc().toISO()! },
  })
  return { token: token.value!.release(), collector }
}

const LAPTOP = 'aa:aa:aa:aa:aa:01'
const TV = 'aa:aa:aa:aa:aa:02'

/**
 * Two hours of history: the laptop watches YouTube on two googlevideo hosts
 * and reads mail; the TV streams Netflix without ever showing an SNI plus
 * one named host; an ad domain over plain TLS carries its own category.
 */
async function seedHistory(collectorId: number) {
  const h0 = DateTime.utc().startOf('hour').minus({ hours: 3 })
  const h1 = h0.plus({ hours: 1 })
  const row = (
    mac: string,
    serverName: string,
    protocol: string,
    category: string,
    bytesIn: number,
    bytesOut: number
  ) => ({
    mac,
    serverName,
    protocol,
    category,
    bytesIn,
    bytesOut,
    packetsIn: bytesIn / 1000,
    packetsOut: bytesOut / 100,
  })
  await writeDestinationBuckets(collectorId, h0, [
    row(LAPTOP, 'rr1---sn-abc.googlevideo.com', 'youtube', 'media', 4_000_000, 40_000),
    row(LAPTOP, 'rr2---sn-def.googlevideo.com', 'youtube', 'media', 2_000_000, 20_000),
    row(LAPTOP, 'imap.example.co.uk', 'imaps', 'email', 100_000, 10_000),
    row(LAPTOP, 'ads.doubleclick.net', 'https', 'advertisement', 300_000, 3_000),
    row(TV, '', 'netflix', 'video', 3_000_000, 30_000),
    row(TV, 'ipv4-c001.nflxvideo.net', 'netflix', 'video', 500_000, 5_000),
  ])
  await writeDestinationBuckets(collectorId, h1, [
    row(LAPTOP, 'rr1---sn-abc.googlevideo.com', 'youtube', 'media', 1_000_000, 10_000),
  ])
}

test.group('destination_history | registeredDomain', () => {
  test('folds hostnames onto their registered domain', ({ assert }) => {
    assert.equal(registeredDomain('rr4---sn-4g5e6nzl.googlevideo.com'), 'googlevideo.com')
    assert.equal(registeredDomain('photos.example.co.uk'), 'example.co.uk')
    assert.equal(registeredDomain('www.example.com.'), 'example.com')
    assert.equal(registeredDomain('example.com'), 'example.com')
    assert.equal(registeredDomain('nas'), 'nas')
    assert.equal(registeredDomain('192.168.1.17'), '192.168.1.17')
    assert.isNull(registeredDomain(''))
    assert.isNull(registeredDomain(null))
  })
})

test.group('destinations read API', (group) => {
  group.each.setup(resetDb)

  test('GET /api/v1/destinations sums names, groups domains and splits categories', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    await seedHistory(collector.id)

    const r = await client.get('/api/v1/destinations?range=24h').bearerToken(token)
    r.assertStatus(200)
    const body = r.body().data
    assert.equal(body.totalBytesIn, 10_900_000)
    assert.equal(body.totalBytesOut, 118_000)
    assert.equal(body.totalBytes, 11_018_000)

    // Names: biggest first, unnamed pool surfaces as null.
    assert.equal(body.destinations[0].serverName, 'rr1---sn-abc.googlevideo.com')
    assert.equal(body.destinations[0].bytesIn, 5_000_000, 'two hours summed')
    assert.equal(body.destinations[0].domain, 'googlevideo.com')
    assert.equal(body.destinations[0].category, 'media')
    assert.equal(body.destinations[0].deviceCount, 1)
    const pool = body.destinations.find((d: { serverName: string | null }) => d.serverName === null)
    assert.equal(pool.protocol, 'netflix')
    assert.equal(pool.bytesIn, 3_000_000)
    assert.isNull(pool.domain)

    // Domains: googlevideo.com beats the netflix pool; the pool is keyed by protocol.
    assert.equal(body.domains[0].key, 'd:googlevideo.com')
    assert.equal(body.domains[0].totalBytes, 7_070_000)
    assert.equal(body.domains[0].nameCount, 2)
    assert.equal(body.domains[0].names.length, 2)
    assert.equal(body.domains[0].names[0].serverName, 'rr1---sn-abc.googlevideo.com')
    assert.equal(body.domains[0].percentage, 64.2)
    assert.equal(body.domains[1].key, 'p:netflix')
    assert.isNull(body.domains[1].domain)
    assert.equal(body.domains[1].protocol, 'netflix')
    assert.equal(body.domains[1].category, 'video')
    const uk = body.domains.find((d: { domain: string | null }) => d.domain === 'example.co.uk')
    assert.isOk(uk, 'co.uk keeps three labels')

    // Categories cover every row, sorted desc.
    assert.deepEqual(
      body.categories.map((c: { category: string }) => c.category),
      ['media', 'video', 'advertisement', 'email']
    )
    assert.equal(body.categories[0].totalBytes, 7_070_000)
    assert.equal(body.categories[2].category, 'advertisement')
  })

  test('unnamed TLS rows keyed by address group as networks', async ({ client, assert }) => {
    const { token, collector } = await bootstrap()
    const h0 = DateTime.utc().startOf('hour').minus({ hours: 2 })
    // Private addresses resolve to "Private / LAN" without any DNS lookup,
    // which keeps the test hermetic; real peers get their ASN org.
    await writeDestinationBuckets(collector.id, h0, [
      {
        mac: LAPTOP,
        serverName: '',
        peerIp: '10.9.0.1',
        protocol: 'https',
        category: 'web',
        bytesIn: 7_000_000,
        bytesOut: 70_000,
        packetsIn: 7,
        packetsOut: 1,
      },
      {
        mac: LAPTOP,
        serverName: '',
        peerIp: '10.9.0.2',
        protocol: 'https',
        category: 'web',
        bytesIn: 2_000_000,
        bytesOut: 20_000,
        packetsIn: 2,
        packetsOut: 1,
      },
      {
        mac: TV,
        serverName: '',
        peerIp: '10.9.0.1',
        protocol: 'quic',
        category: 'web',
        bytesIn: 1_000_000,
        bytesOut: 10_000,
        packetsIn: 1,
        packetsOut: 1,
      },
      {
        mac: TV,
        serverName: '',
        protocol: 'bittorrent',
        category: 'download',
        bytesIn: 500_000,
        bytesOut: 5_000,
        packetsIn: 1,
        packetsOut: 1,
      },
      {
        mac: TV,
        serverName: 'cdn.example',
        peerIp: '',
        protocol: 'https',
        category: 'web',
        bytesIn: 300_000,
        bytesOut: 3_000,
        packetsIn: 1,
        packetsOut: 1,
      },
    ])

    const r = await client.get('/api/v1/destinations?range=24h').bearerToken(token)
    r.assertStatus(200)
    const body = r.body().data
    const top = body.destinations[0]
    assert.isNull(top.serverName)
    assert.equal(top.peerIp, '10.9.0.1')
    assert.equal(top.org, 'Private / LAN')
    assert.equal(top.bytesIn, 7_000_000, 'same address under two protocols stays two rows')
    assert.equal(top.deviceCount, 1)

    const net = body.domains.find((g: { key: string }) => g.key.startsWith('a:'))
    assert.isOk(net, 'address rows form a network group')
    assert.isNull(net.domain)
    assert.equal(net.org, 'Private / LAN')
    assert.equal(net.totalBytes, 10_100_000, 'both addresses and both protocols in one network')
    assert.equal(net.nameCount, 3)
    assert.equal(net.names[0].peerIp, '10.9.0.1')
    const pool = body.domains.find((g: { key: string }) => g.key === 'p:bittorrent')
    assert.isOk(pool, 'families without names still pool')
    assert.isOk(body.domains.find((g: { key: string }) => g.key === 'd:cdn.example'))
  })

  test('addresses whose ASN lookup failed stand alone instead of pooling as Unknown', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    const h0 = DateTime.utc().startOf('hour').minus({ hours: 2 })
    const nowSql = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')
    // Pre-seeded cache rows keep the test off the network: two failures
    // (fresh, so they are not retried) and one resolved network.
    await db
      .insertQuery()
      .table('asn_cache')
      .multiInsert([
        {
          ip_address: '203.0.113.10',
          asn: null,
          org: 'Unknown',
          prefix: null,
          error: 'timeout after 1500ms',
          checked_at: nowSql,
          created_at: nowSql,
          updated_at: nowSql,
        },
        {
          ip_address: '198.51.100.20',
          asn: null,
          org: 'Unknown',
          prefix: null,
          error: 'queryTxt ENOTFOUND',
          checked_at: nowSql,
          created_at: nowSql,
          updated_at: nowSql,
        },
        {
          ip_address: '203.0.113.99',
          asn: 64500,
          org: 'Example Net',
          prefix: '203.0.113.0/24',
          error: null,
          checked_at: nowSql,
          created_at: nowSql,
          updated_at: nowSql,
        },
      ])
    const addressed = (peerIp: string, protocol: string, bytesIn: number) => ({
      mac: LAPTOP,
      serverName: '',
      peerIp,
      protocol,
      category: 'web',
      bytesIn,
      bytesOut: 1_000,
      packetsIn: 1,
      packetsOut: 1,
    })
    await writeDestinationBuckets(collector.id, h0, [
      addressed('203.0.113.10', 'https', 5_000_000),
      addressed('198.51.100.20', 'https', 3_000_000),
      addressed('198.51.100.20', 'quic', 500_000),
      addressed('203.0.113.99', 'https', 2_000_000),
    ])

    const r = await client.get('/api/v1/destinations?range=24h').bearerToken(token)
    r.assertStatus(200)
    const groups = r.body().data.domains as Array<{
      key: string
      org: string | null
      asn: number | null
      nameCount: number
      names: Array<{ peerIp: string | null }>
    }>
    assert.isUndefined(
      groups.find((g) => g.key === 'a:Unknown'),
      'no shared Unknown bucket'
    )
    const lone = groups.find((g) => g.key === 'a:203.0.113.10')
    assert.isOk(lone, 'a failed address keys its own group')
    assert.isNull(lone!.org)
    assert.isNull(lone!.asn)
    assert.equal(lone!.names[0].peerIp, '203.0.113.10')
    const other = groups.find((g) => g.key === 'a:198.51.100.20')
    assert.isOk(other)
    assert.equal(other!.nameCount, 2, 'both protocols of one address share its group')
    const known = groups.find((g) => g.key === 'a:64500')
    assert.isOk(known, 'a resolved address groups by ASN')
    assert.equal(known!.org, 'Example Net')
    assert.equal(known!.asn, 64500)
  })

  test('an IP-literal server name joins its network group instead of posing as a domain', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    const h0 = DateTime.utc().startOf('hour').minus({ hours: 2 })
    const nowSql = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')
    await db.insertQuery().table('asn_cache').insert({
      ip_address: '203.0.113.99',
      asn: 64500,
      org: 'Example Net',
      prefix: '203.0.113.0/24',
      error: null,
      checked_at: nowSql,
      created_at: nowSql,
      updated_at: nowSql,
    })
    await writeDestinationBuckets(collector.id, h0, [
      {
        mac: TV,
        serverName: '203.0.113.99',
        peerIp: '',
        protocol: 'http',
        category: 'web',
        bytesIn: 900_000,
        bytesOut: 9_000,
        packetsIn: 1,
        packetsOut: 1,
      },
      {
        mac: TV,
        serverName: '',
        peerIp: '203.0.113.99',
        protocol: 'https',
        category: 'web',
        bytesIn: 100_000,
        bytesOut: 1_000,
        packetsIn: 1,
        packetsOut: 1,
      },
    ])

    const r = await client.get('/api/v1/destinations?range=24h').bearerToken(token)
    r.assertStatus(200)
    const body = r.body().data
    const literal = body.destinations.find(
      (d: { serverName: string | null }) => d.serverName === '203.0.113.99'
    )
    assert.isOk(literal)
    assert.isNull(literal.domain)
    assert.equal(literal.peerIp, '203.0.113.99')
    assert.equal(literal.org, 'Example Net')
    assert.isUndefined(
      body.domains.find((g: { key: string }) => g.key === 'd:203.0.113.99'),
      'an address is not a domain'
    )
    const net = body.domains.find((g: { key: string }) => g.key === 'a:64500')
    assert.isOk(net)
    assert.equal(
      net.totalBytes,
      1_010_000,
      'the literal-named and the unnamed rows share the network'
    )
    assert.equal(net.nameCount, 2)
  })

  test('limit caps names and domains but never categories or totals', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    await seedHistory(collector.id)
    const r = await client.get('/api/v1/destinations?range=24h&limit=1').bearerToken(token)
    r.assertStatus(200)
    assert.equal(r.body().data.destinations.length, 1)
    assert.equal(r.body().data.domains.length, 1)
    assert.equal(r.body().data.categories.length, 4)
    assert.equal(r.body().data.totalBytes, 11_018_000)
  })

  test('GET /api/v1/devices/:mac/destinations scopes to one device, 404 for none', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    await seedHistory(collector.id)

    const r = await client.get(`/api/v1/devices/${TV}/destinations?range=24h`).bearerToken(token)
    r.assertStatus(200)
    assert.equal(r.body().data.mac, TV)
    assert.equal(r.body().data.destinations.length, 2)
    assert.equal(r.body().data.totalBytesIn, 3_500_000)
    assert.equal(r.body().data.categories.length, 1)
    assert.equal(r.body().data.categories[0].percentage, 100)

    const missing = await client
      .get('/api/v1/devices/ff:ff:ff:ff:ff:fe/destinations?range=24h')
      .bearerToken(token)
    missing.assertStatus(404)
    assert.equal(missing.body().error, 'mac_not_found')
  })

  test('GET /api/v1/destinations/:serverName/traffic returns hourly buckets, daily on request', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    await seedHistory(collector.id)
    const name = encodeURIComponent('rr1---sn-abc.googlevideo.com')

    const hourly = await client
      .get(`/api/v1/destinations/${name}/traffic?range=24h`)
      .bearerToken(token)
    hourly.assertStatus(200)
    assert.equal(hourly.body().data.resolution, '1h')
    assert.equal(hourly.body().data.buckets.length, 2)
    assert.equal(hourly.body().data.buckets[0].bytesIn, 4_000_000)
    assert.equal(hourly.body().data.buckets[1].bytesIn, 1_000_000)

    const daily = await client
      .get(`/api/v1/destinations/${name}/traffic?range=7d&resolution=1d`)
      .bearerToken(token)
    daily.assertStatus(200)
    assert.equal(daily.body().data.resolution, '1d')
    const total = daily
      .body()
      .data.buckets.reduce((sum: number, b: { bytesIn: number }) => sum + b.bytesIn, 0)
    assert.equal(total, 5_000_000)
  })
})

test.group('protocol categories', (group) => {
  group.each.setup(resetDb)

  test('protocol breakdowns carry the category from the lookup, other when unknown', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    await upsertProtocolCategories([
      { protocol: 'youtube', category: 'media' },
      { protocol: 'HTTPS', category: 'Web' },
      { protocol: '', category: 'nope' },
      { protocol: 'blank', category: '' },
    ])
    const map = await getProtocolCategoryMap()
    assert.equal(map.get('youtube'), 'media')
    assert.equal(map.get('https'), 'web', 'normalised to lowercase')
    assert.isFalse(map.has(''), 'empty labels are dropped')
    assert.isFalse(map.has('blank'), 'empty categories are dropped')
    assert.equal(map.get('dns'), 'network', 'fallback covers port-mode labels')

    const t = DateTime.utc().minus({ minutes: 10 }).startOf('minute')
    await writeProtocolBuckets(collector.id, 60, t, [
      {
        mac: LAPTOP,
        protocol: 'youtube',
        bytesIn: 6000,
        bytesOut: 600,
        packetsIn: 6,
        packetsOut: 1,
      },
      {
        mac: LAPTOP,
        protocol: 'mystery',
        bytesIn: 1000,
        bytesOut: 100,
        packetsIn: 1,
        packetsOut: 1,
      },
    ])
    await backfillRollups(t.minus({ hours: 1 }), DateTime.utc())

    const r = await client.get('/api/v1/protocols?range=1h').bearerToken(token)
    r.assertStatus(200)
    const protocols = r.body().data.protocols as Array<{ protocol: string; category: string }>
    assert.equal(protocols.find((p) => p.protocol === 'youtube')?.category, 'media')
    assert.equal(protocols.find((p) => p.protocol === 'mystery')?.category, 'other')
  })
})

test.group('collector_poller | destinations', (group) => {
  group.each.setup(resetDb)

  function fetcherFor(
    destinations: Array<Record<string, unknown>>,
    bytesIn: number,
    protocols?: Array<{ protocol: string; category: string }>
  ) {
    const map: Record<string, unknown> = {
      '/api/v1/summary': { summary: { started_at: '2026-05-25T12:00:00.000Z', total_devices: 1 } },
      '/api/v1/devices': {
        devices: [
          {
            mac: LAPTOP,
            ips: ['192.168.2.50'],
            bytes_in: bytesIn,
            bytes_out: 1000,
            packets_in: 10,
            packets_out: 10,
            top_peers: [],
            top_lan_peers: [],
            services: [],
            destinations,
          },
        ],
      },
    }
    if (protocols) map['/api/v1/protocols'] = { protocols }
    return (async (url: Parameters<typeof fetch>[0]) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '')
      if (!(path in map)) return new Response('not found', { status: 404 })
      return new Response(JSON.stringify(map[path]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
  }

  test('second tick writes in/out deltas per (name, protocol) and syncs categories', async ({
    assert,
  }) => {
    const collector = await Collector.create({
      name: 'test',
      baseUrl: 'http://127.0.0.1:9800',
      pollIntervalSeconds: 5,
      enabled: true,
      apiKey: null,
      lastStatus: null,
    })
    const t0 = DateTime.fromISO('2026-05-25T12:00:00.000Z', { zone: 'utc' })
    const row = (bytesIn: number, bytesOut: number, name = 'youtube.com', category = 'media') => ({
      server_name: name,
      peer_ip: name ? '' : '203.0.113.7',
      protocol: 'youtube',
      category,
      bytes_in: bytesIn,
      bytes_out: bytesOut,
      packets_in: bytesIn / 1000,
      packets_out: bytesOut / 100,
    })

    const first = await pollOnce(collector, {
      now: () => t0,
      fetcher: fetcherFor([row(10_000, 1_000)], 10_000, [
        { protocol: 'youtube', category: 'media' },
      ]),
    })
    assert.equal(first.status, 'baseline')
    const categories = await db.from('protocol_categories').select('*')
    assert.equal(categories.length, 1, 'first tick pulled the category table')

    const outcome = await pollOnce(collector, {
      now: () => t0.plus({ seconds: 5 }),
      fetcher: fetcherFor(
        [row(16_000, 1_500), row(500, 50, '') /* unnamed pool, first sight → baseline */],
        16_500
      ),
    })
    assert.equal(outcome.status, 'wrote')
    if (outcome.status === 'wrote') assert.equal(outcome.destinationBucketsWritten, 1)

    const rows = await db.from('device_destination_buckets_hourly').select('*')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].server_name, 'youtube.com')
    assert.equal(rows[0].peer_ip, '')
    assert.equal(rows[0].protocol, 'youtube')
    assert.equal(rows[0].category, 'media')
    assert.equal(Number(rows[0].bytes_in), 6_000)
    assert.equal(Number(rows[0].bytes_out), 500)
    assert.equal(Number(rows[0].packets_in), 6)
    assert.equal(
      DateTime.fromJSDate(rows[0].hour_start, { zone: 'utc' }).toISO(),
      '2026-05-25T12:00:00.000Z'
    )
  })

  test('a collector without /api/v1/protocols still polls fine', async ({ assert }) => {
    const collector = await Collector.create({
      name: 'old',
      baseUrl: 'http://127.0.0.1:9800',
      pollIntervalSeconds: 5,
      enabled: true,
      apiKey: null,
      lastStatus: null,
    })
    const t0 = DateTime.fromISO('2026-05-25T12:00:00.000Z', { zone: 'utc' })
    const outcome = await pollOnce(collector, { now: () => t0, fetcher: fetcherFor([], 0) })
    assert.equal(outcome.status, 'baseline')
    const categories = await db.from('protocol_categories').select('*')
    assert.equal(categories.length, 0)
  })
})
