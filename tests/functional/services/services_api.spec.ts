import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import { writeServiceBuckets } from '#services/bucket_writer'
import { _resetPollerState, pollOnce } from '#services/collector_poller'
import { _resetQueryCache } from '#services/query_cache'
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

const PROXY = 'aa:aa:aa:aa:aa:01'
const NAS = 'aa:aa:aa:aa:aa:02'

/** Two hours of served history: the proxy serves two vhosts, the NAS one. */
async function seedHistory(collectorId: number) {
  const h0 = DateTime.utc().startOf('hour').minus({ hours: 3 })
  const h1 = h0.plus({ hours: 1 })
  await writeServiceBuckets(collectorId, h0, [
    {
      mac: PROXY,
      serverName: 'photos.example',
      protocol: 'https',
      bytesServed: 5_000_000,
      bytesReceived: 50_000,
      packetsServed: 5000,
      packetsReceived: 500,
    },
    {
      mac: PROXY,
      serverName: 'maps.example',
      protocol: 'https',
      bytesServed: 1_000_000,
      bytesReceived: 10_000,
      packetsServed: 1000,
      packetsReceived: 100,
    },
    {
      mac: NAS,
      serverName: 'cloud.home',
      protocol: 'https',
      bytesServed: 3_000_000,
      bytesReceived: 30_000,
      packetsServed: 3000,
      packetsReceived: 300,
    },
  ])
  await writeServiceBuckets(collectorId, h1, [
    {
      mac: PROXY,
      serverName: 'photos.example',
      protocol: 'https',
      bytesServed: 2_000_000,
      bytesReceived: 20_000,
      packetsServed: 2000,
      packetsReceived: 200,
    },
  ])
  await db
    .insertQuery()
    .table('device_identities')
    .insert({
      collector_id: collectorId,
      mac: PROXY,
      primary_ip: '192.168.2.100',
      ips: JSON.stringify(['192.168.2.100']),
      first_seen_at: h0.toFormat('yyyy-MM-dd HH:mm:ss'),
      last_seen_at: h1.toFormat('yyyy-MM-dd HH:mm:ss'),
      created_at: h0.toFormat('yyyy-MM-dd HH:mm:ss'),
      updated_at: h1.toFormat('yyyy-MM-dd HH:mm:ss'),
    })
}

test.group('services read API', (group) => {
  group.each.setup(resetDb)

  test('GET /api/v1/services sums per name with the servers behind each', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    await seedHistory(collector.id)

    const r = await client.get('/api/v1/services?range=24h').bearerToken(token)
    r.assertStatus(200)
    const body = r.body().data
    assert.equal(body.totalBytesServed, 11_000_000)
    assert.equal(body.totalBytesReceived, 110_000)
    assert.equal(body.services.length, 3)
    assert.equal(body.services[0].serverName, 'photos.example', 'biggest name first')
    assert.equal(body.services[0].bytesServed, 7_000_000, 'two hours summed')
    assert.equal(body.services[0].percentage, 63.6)
    assert.equal(body.services[0].servers[0].mac, PROXY)
    assert.equal(body.services[0].servers[0].primaryIp, '192.168.2.100')
    assert.equal(body.servers.length, 2)
    assert.equal(body.servers[0].mac, PROXY)
    assert.equal(body.servers[0].serviceCount, 2)
    assert.equal(body.servers[0].bytesServed, 8_000_000)
  })

  test('limit caps the names but never the servers', async ({ client, assert }) => {
    const { token, collector } = await bootstrap()
    await seedHistory(collector.id)
    const r = await client.get('/api/v1/services?range=24h&limit=1').bearerToken(token)
    r.assertStatus(200)
    assert.equal(r.body().data.services.length, 1)
    assert.equal(r.body().data.servers.length, 2)
    assert.equal(r.body().data.totalBytesServed, 11_000_000, 'totals cover every name')
  })

  test('GET /api/v1/devices/:mac/services lists one server, 404 for a non-server', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    await seedHistory(collector.id)

    const r = await client.get(`/api/v1/devices/${NAS}/services?range=24h`).bearerToken(token)
    r.assertStatus(200)
    assert.equal(r.body().data.services.length, 1)
    assert.equal(r.body().data.services[0].serverName, 'cloud.home')
    assert.equal(r.body().data.services[0].percentage, 100)

    const missing = await client
      .get('/api/v1/devices/ff:ff:ff:ff:ff:fe/services?range=24h')
      .bearerToken(token)
    missing.assertStatus(404)
  })

  test('GET /api/v1/services/:serverName/traffic returns hourly buckets, daily on request', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    await seedHistory(collector.id)

    const hourly = await client
      .get('/api/v1/services/photos.example/traffic?range=24h&resolution=1h')
      .bearerToken(token)
    hourly.assertStatus(200)
    assert.equal(hourly.body().data.resolution, '1h')
    assert.equal(hourly.body().data.buckets.length, 2)
    assert.equal(hourly.body().data.buckets[0].bytesServed, 5_000_000)
    assert.equal(hourly.body().data.buckets[1].bytesServed, 2_000_000)

    const daily = await client
      .get('/api/v1/services/photos.example/traffic?range=7d&resolution=1d')
      .bearerToken(token)
    daily.assertStatus(200)
    assert.equal(daily.body().data.resolution, '1d')
    const total = daily
      .body()
      .data.buckets.reduce((sum: number, b: { bytesServed: number }) => sum + b.bytesServed, 0)
    assert.equal(total, 7_000_000, 'daily buckets sum to the hourly total')
  })
})

test.group('services 5-minute tier', (group) => {
  group.each.setup(resetDb)

  test('deltas land in both grains; recent short windows auto-pick 5m, old ones fall back', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    const t0 = DateTime.utc().minus({ hours: 2 }).startOf('hour')
    const row = (bytesServed: number) => ({
      mac: PROXY,
      serverName: 'photos.example',
      protocol: 'https',
      bytesServed,
      bytesReceived: 100,
      packetsServed: 1,
      packetsReceived: 1,
    })
    // Two polls in the same hour but different 5-minute slots.
    await writeServiceBuckets(collector.id, t0.plus({ minutes: 2 }), [row(1_000)])
    await writeServiceBuckets(collector.id, t0.plus({ minutes: 7 }), [row(2_000)])

    const fiveMin = await db.from('device_service_buckets_5m').orderBy('slot_start').select('*')
    assert.equal(fiveMin.length, 2)
    assert.equal(Number(fiveMin[0].bytes_served), 1_000)
    assert.equal(Number(fiveMin[1].bytes_served), 2_000)
    const hourly = await db.from('device_service_buckets_hourly').select('*')
    assert.equal(hourly.length, 1)
    assert.equal(Number(hourly[0].bytes_served), 3_000, 'hour still sums both')

    const auto = await client
      .get('/api/v1/services/photos.example/traffic?range=24h')
      .bearerToken(token)
    auto.assertStatus(200)
    assert.equal(auto.body().data.resolution, '5m', '24h auto-picks the 5m tier')
    assert.equal(auto.body().data.resolutionSeconds, 300)
    assert.equal(auto.body().data.buckets.length, 2)

    const wide = await client
      .get('/api/v1/services/photos.example/traffic?range=7d')
      .bearerToken(token)
    assert.equal(wide.body().data.resolution, '1h', '7d stays hourly')

    const tooLong = await client
      .get('/api/v1/services/photos.example/traffic?range=5d&resolution=5m')
      .bearerToken(token)
    assert.equal(tooLong.body().data.resolution, '1h', '5m capped at 3 days')

    const old = DateTime.utc().minus({ days: 30 })
    const stale = await client
      .get(
        `/api/v1/services/photos.example/traffic?from=${old.toISO()}&to=${old.plus({ hours: 6 }).toISO()}&resolution=5m`
      )
      .bearerToken(token)
    assert.equal(stale.body().data.resolution, '1h', '5m not offered beyond its retention')
  })
})

test.group('collector_poller | services', (group) => {
  group.each.setup(resetDb)

  function fetcherFor(services: Array<Record<string, unknown>>, bytesOut: number) {
    const map: Record<string, unknown> = {
      '/api/v1/summary': { summary: { started_at: '2026-05-25T12:00:00.000Z', total_devices: 1 } },
      '/api/v1/devices': {
        devices: [
          {
            mac: PROXY,
            ips: ['192.168.2.100'],
            bytes_in: 1000,
            bytes_out: bytesOut,
            packets_in: 10,
            packets_out: 10,
            top_peers: [],
            top_lan_peers: [],
            services,
          },
        ],
      },
    }
    return (async (url: Parameters<typeof fetch>[0]) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '')
      return new Response(JSON.stringify(map[path]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
  }

  test('second tick writes served/received deltas per (name, protocol)', async ({ assert }) => {
    const collector = await Collector.create({
      name: 'test',
      baseUrl: 'http://127.0.0.1:9800',
      pollIntervalSeconds: 5,
      enabled: true,
      apiKey: null,
      lastStatus: null,
    })
    const t0 = DateTime.fromISO('2026-05-25T12:00:00.000Z', { zone: 'utc' })
    const row = (served: number, received: number, name = 'photos.example') => ({
      server_name: name,
      protocol: 'https',
      bytes_served: served,
      bytes_received: received,
      packets_served: served / 1000,
      packets_received: received / 100,
    })

    await pollOnce(collector, { now: () => t0, fetcher: fetcherFor([row(10_000, 1_000)], 10_000) })
    const outcome = await pollOnce(collector, {
      now: () => t0.plus({ seconds: 5 }),
      fetcher: fetcherFor(
        [row(16_000, 1_500), row(500, 50, 'new.example') /* first sight → baseline */],
        16_500
      ),
    })

    assert.equal(outcome.status, 'wrote')
    if (outcome.status === 'wrote') assert.equal(outcome.serviceBucketsWritten, 1)

    const rows = await db.from('device_service_buckets_hourly').select('*')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].server_name, 'photos.example')
    assert.equal(Number(rows[0].bytes_served), 6_000)
    assert.equal(Number(rows[0].bytes_received), 500)
    assert.equal(Number(rows[0].packets_served), 6)
    assert.equal(
      DateTime.fromJSDate(rows[0].hour_start, { zone: 'utc' }).toISO(),
      '2026-05-25T12:00:00.000Z'
    )
  })
})
