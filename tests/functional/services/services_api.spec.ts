import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import { writeServiceBuckets } from '#services/bucket_writer'
import { _resetPollerState, pollOnce } from '#services/collector_poller'
import { _resetQueryCache } from '#services/query_cache'
import { _resetSeriesCoverage } from '#services/series_buckets'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  _resetQueryCache()
  _resetSeriesCoverage()
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
    const h0 = DateTime.utc().startOf('hour').minus({ hours: 3 })

    const hourly = await client
      .get('/api/v1/services/photos.example/traffic?range=24h&resolution=1h')
      .bearerToken(token)
    hourly.assertStatus(200)
    const body = hourly.body().data
    assert.equal(body.resolution, '1h')
    assert.equal(body.bucketSeconds, 3600)
    assert.equal(body.resolutionSeconds, 3600, 'kept for older clients')
    assert.equal(body.source, '1h')
    // Dense: every hour of the window, the quiet ones as zero.
    assert.includeMembers([24, 25], [body.buckets.length])
    const busy = body.buckets.filter((b: { bytesServed: number }) => b.bytesServed > 0)
    assert.deepEqual(
      busy.map((b: { bucketStart: string; bytesServed: number }) => [
        Date.parse(b.bucketStart),
        b.bytesServed,
      ]),
      [
        [h0.toMillis(), 5_000_000],
        [h0.plus({ hours: 1 }).toMillis(), 2_000_000],
      ]
    )

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

  test('deltas land in every grain; old windows fall back to the stored detail', async ({
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

    const native = await db.from('device_service_buckets').orderBy('bucket_start').select('*')
    assert.equal(native.length, 2, 'one per-poll row per poll')
    const fiveMin = await db.from('device_service_buckets_5m').orderBy('slot_start').select('*')
    assert.equal(fiveMin.length, 2)
    assert.equal(Number(fiveMin[0].bytes_served), 1_000)
    assert.equal(Number(fiveMin[1].bytes_served), 2_000)
    const hourly = await db.from('device_service_buckets_hourly').select('*')
    assert.equal(hourly.length, 1)
    assert.equal(Number(hourly[0].bytes_served), 3_000, 'hour still sums both')

    const asked5m = await client
      .get('/api/v1/services/photos.example/traffic?range=24h&resolution=5m')
      .bearerToken(token)
    asked5m.assertStatus(200)
    assert.equal(asked5m.body().data.resolution, '5m')
    assert.equal(asked5m.body().data.source, '5m', 'the coarsest tier that serves 5 min')
    const busy = asked5m
      .body()
      .data.buckets.filter((b: { bytesServed: number }) => b.bytesServed > 0)
      .map((b: { bytesServed: number }) => b.bytesServed)
    assert.deepEqual(busy, [1_000, 2_000])

    const wide = await client
      .get('/api/v1/services/photos.example/traffic?range=7d')
      .bearerToken(token)
    assert.equal(wide.body().data.resolution, '10m', '7d at the cap: 1008 ten-minute buckets')
    assert.isAtMost(wide.body().data.buckets.length, 1500)

    // A window from before any per-poll row existed: the 5-minute and hourly
    // tables hold older history (seeded directly), the per-poll one does not.
    const old = DateTime.utc().minus({ days: 20 }).startOf('hour')
    await db
      .insertQuery()
      .table('device_service_buckets_hourly')
      .insert({
        collector_id: collector.id,
        mac: PROXY,
        server_name: 'photos.example',
        protocol: 'https',
        hour_start: old.toFormat('yyyy-MM-dd HH:mm:ss'),
        bytes_served: 9_000,
        bytes_received: 0,
        packets_served: 1,
        packets_received: 0,
        updated_at: old.toFormat('yyyy-MM-dd HH:mm:ss'),
      })
    _resetSeriesCoverage()
    const stale = await client
      .get(
        `/api/v1/services/photos.example/traffic?from=${old.toISO()}&to=${old.plus({ hours: 6 }).toISO()}`
      )
      .bearerToken(token)
    stale.assertStatus(200)
    assert.equal(stale.body().data.source, '1h', 'no finer rows that far back')
    assert.equal(stale.body().data.resolution, '1h')
    assert.lengthOf(stale.body().data.buckets, 6)
    assert.equal(stale.body().data.buckets[0].bytesServed, 9_000)
  })
})

test.group('services dense series', (group) => {
  group.each.setup(resetDb)

  const row = (bytesServed: number, bytesReceived = 0) => ({
    mac: PROXY,
    serverName: 'photos.example',
    protocol: 'https',
    bytesServed,
    bytesReceived,
    packetsServed: 1,
    packetsReceived: 1,
  })

  type Bucket = {
    bucketStart: string
    bucketEnd: string
    seconds: number
    bytesServed: number
    bytesReceived: number
    mbpsServed: number
    mbpsReceived: number
  }

  test('a window with gaps returns every 15 s bucket, the quiet ones as zero', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    // Two bursts ten minutes apart, well inside the last hour.
    const t0 = DateTime.fromSeconds(Math.floor(DateTime.utc().toSeconds() / 15) * 15 - 1800, {
      zone: 'utc',
    })
    await writeServiceBuckets(collector.id, t0, [row(1_500_000)])
    await writeServiceBuckets(collector.id, t0.plus({ seconds: 5 }), [row(1_500_000)])
    await writeServiceBuckets(collector.id, t0.plus({ minutes: 10 }), [row(300_000)])

    const r = await client
      .get('/api/v1/services/photos.example/traffic?range=1h')
      .bearerToken(token)
    r.assertStatus(200)
    const body = r.body().data
    assert.equal(body.bucketSeconds, 15, 'the default floor')
    assert.equal(body.resolution, '15s')
    assert.equal(body.source, 'native')
    assert.equal(body.floorSeconds, 15)
    assert.equal(body.maxPoints, 1500)
    const buckets = body.buckets as Bucket[]
    assert.includeMembers([240, 241], [buckets.length])
    for (let i = 1; i < buckets.length; i += 1) {
      assert.equal(
        Date.parse(buckets[i].bucketStart) - Date.parse(buckets[i - 1].bucketStart),
        15_000,
        'no bucket skipped'
      )
    }
    const busy = buckets.filter((b) => b.bytesServed > 0)
    assert.deepEqual(
      busy.map((b) => [Date.parse(b.bucketStart), b.bytesServed]),
      [
        [t0.toMillis(), 3_000_000],
        [t0.plus({ minutes: 10 }).toMillis(), 300_000],
      ]
    )
    assert.isAbove(buckets.filter((b) => b.bytesServed === 0).length, 200)
    // Rate = bytes × 8 / seconds of a full bucket: 3 MB in 15 s = 1.6 Mbps.
    assert.closeTo(busy[0].mbpsServed, 1.6, 1e-9)
    assert.equal(busy[0].seconds, 15)
  })

  test('partial first and last buckets carry their real seconds and rate', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    const t0 = DateTime.fromSeconds(Math.floor(DateTime.utc().toSeconds() / 15) * 15 - 3600, {
      zone: 'utc',
    })
    // Polls at +10 s (inside the window) and +65 s (the last covered poll).
    await writeServiceBuckets(collector.id, t0.plus({ seconds: 5 }), [row(999_999)])
    await writeServiceBuckets(collector.id, t0.plus({ seconds: 10 }), [row(1_000)])
    await writeServiceBuckets(collector.id, t0.plus({ seconds: 65 }), [row(2_000)])
    await writeServiceBuckets(collector.id, t0.plus({ seconds: 70 }), [row(888_888)])

    const from = t0.plus({ seconds: 7 }).toISO()
    const to = t0.plus({ seconds: 67 }).toISO()
    const r = await client
      .get(`/api/v1/services/photos.example/traffic?from=${from}&to=${to}`)
      .bearerToken(token)
    r.assertStatus(200)
    const buckets = r.body().data.buckets as Bucket[]
    assert.deepEqual(
      buckets.map((b) => [Date.parse(b.bucketStart) - t0.toMillis(), b.seconds, b.bytesServed]),
      [
        // Rows from +10 s: the +5 s poll is outside the window.
        [0, 5, 1_000],
        [15_000, 15, 0],
        [30_000, 15, 0],
        [45_000, 15, 0],
        // Up to +70 s: the +65 s poll is in, the +70 s one is not.
        [60_000, 10, 2_000],
      ]
    )
    assert.closeTo(buckets[0].mbpsServed, (1_000 * 8) / 5 / 1e6, 1e-12)
    assert.closeTo(buckets[4].mbpsServed, (2_000 * 8) / 10 / 1e6, 1e-12)
  })

  test('the live bucket counts only the seconds up to now', async ({ client, assert }) => {
    const { token, collector } = await bootstrap()
    await writeServiceBuckets(collector.id, DateTime.utc(), [row(10_000)])
    const r = await client
      .get('/api/v1/services/photos.example/traffic?range=1h&resolution=1h')
      .bearerToken(token)
    r.assertStatus(200)
    const buckets = r.body().data.buckets as Bucket[]
    const last = buckets[buckets.length - 1]
    assert.isAtMost(last.seconds, 3600)
    const elapsed = DateTime.utc().toSeconds() - Date.parse(last.bucketStart) / 1000
    assert.isAtMost(last.seconds, Math.ceil(elapsed) + 1, 'never counts the future')
    assert.isAbove(last.mbpsServed, 0)
  })

  test('the admin floor and point cap from Settings → Charts are honoured', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    await writeServiceBuckets(collector.id, DateTime.utc().minus({ minutes: 20 }), [row(5_000)])

    const patch = await client
      .patch('/api/v1/settings/charts')
      .bearerToken(token)
      .json({ minBucketSeconds: 60 })
    patch.assertStatus(200)
    assert.equal(patch.body().data.settings.minBucketSeconds, 60)

    const floored = await client
      .get('/api/v1/services/photos.example/traffic?range=1h')
      .bearerToken(token)
    assert.equal(floored.body().data.bucketSeconds, 60)
    assert.equal(floored.body().data.floorSeconds, 60)
    assert.includeMembers([60, 61], [floored.body().data.buckets.length])

    await client.patch('/api/v1/settings/charts').bearerToken(token).json({ minBucketSeconds: 5 })
    const fine = await client
      .get('/api/v1/services/photos.example/traffic?range=1h')
      .bearerToken(token)
    assert.equal(fine.body().data.bucketSeconds, 5, 'as fine as the per-poll rows')

    // The cap: 1 h in at most 100 points → 60 s buckets, not 36 s.
    await client
      .patch('/api/v1/settings/charts')
      .bearerToken(token)
      .json({ minBucketSeconds: 15, maxPoints: 100 })
    const capped = await client
      .get('/api/v1/services/photos.example/traffic?range=1h')
      .bearerToken(token)
    assert.equal(capped.body().data.bucketSeconds, 60)
    assert.isAtMost(capped.body().data.buckets.length, 100)
    assert.equal(capped.body().data.maxPoints, 100)
  })

  test('after an upgrade the per-poll table serves only windows after its first row', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    // Older 5-minute and hourly history, as an installation that predates
    // the per-poll table has.
    const old = DateTime.utc().minus({ days: 3 }).startOf('hour')
    const base = {
      collector_id: collector.id,
      mac: PROXY,
      server_name: 'photos.example',
      protocol: 'https',
      bytes_served: 1_000,
      bytes_received: 0,
      packets_served: 1,
      packets_received: 0,
      updated_at: old.toFormat('yyyy-MM-dd HH:mm:ss'),
    }
    await db
      .insertQuery()
      .table('device_service_buckets_hourly')
      .insert({ ...base, hour_start: old.toFormat('yyyy-MM-dd HH:mm:ss') })
    await db
      .insertQuery()
      .table('device_service_buckets_5m')
      .insert({ ...base, slot_start: old.toFormat('yyyy-MM-dd HH:mm:ss') })
    const firstPoll = DateTime.utc().minus({ minutes: 10 })
    await writeServiceBuckets(collector.id, firstPoll, [row(5_000)])

    const spanning = await client
      .get('/api/v1/services/photos.example/traffic?range=1h')
      .bearerToken(token)
    assert.equal(spanning.body().data.source, '5m', 'no per-poll rows for the first 50 minutes')
    assert.equal(spanning.body().data.bucketSeconds, 300)

    const from = firstPoll.plus({ seconds: 30 }).toISO()
    const to = DateTime.utc().toISO()
    const after = await client
      .get(`/api/v1/services/photos.example/traffic?from=${from}&to=${to}`)
      .bearerToken(token)
    assert.equal(after.body().data.source, 'native')
    assert.equal(after.body().data.bucketSeconds, 15)
  })

  test('the default cap holds on wide windows', async ({ client, assert }) => {
    const { token, collector } = await bootstrap()
    await writeServiceBuckets(collector.id, DateTime.utc().minus({ minutes: 20 }), [row(5_000)])
    for (const range of ['6h', '2d', '30d', '365d']) {
      const r = await client
        .get(`/api/v1/services/photos.example/traffic?range=${range}`)
        .bearerToken(token)
      r.assertStatus(200)
      assert.isAtMost(r.body().data.buckets.length, 1500, range)
      assert.isAtLeast(r.body().data.buckets.length, 100, range)
    }
    const sixHours = await client
      .get('/api/v1/services/photos.example/traffic?range=6h')
      .bearerToken(token)
    assert.equal(sixHours.body().data.bucketSeconds, 15, '6 h fits 1440 fifteen-second buckets')
    const twoDays = await client
      .get('/api/v1/services/photos.example/traffic?range=2d')
      .bearerToken(token)
    assert.equal(twoDays.body().data.bucketSeconds, 120)
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
