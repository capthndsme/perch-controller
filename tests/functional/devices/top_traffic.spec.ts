import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import { _resetQueryCache } from '#services/query_cache'
import { _resetRollupPass } from '#services/series_buckets'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  _resetQueryCache()
  _resetRollupPass()
  return teardown
}

const fmt = (t: DateTime) => t.toFormat('yyyy-MM-dd HH:mm:ss')

const A = 'aa:aa:aa:aa:aa:aa'
const B = 'bb:bb:bb:bb:bb:bb'
const C = 'cc:cc:cc:cc:cc:cc'

async function insertBucket(
  collectorId: number,
  mac: string,
  at: DateTime,
  bytes: { in: number; out: number; wanIn?: number; wanOut?: number }
) {
  const now = fmt(DateTime.utc())
  const wanIn = bytes.wanIn ?? 0
  const wanOut = bytes.wanOut ?? 0
  await db
    .insertQuery()
    .table('device_traffic_buckets')
    .insert({
      collector_id: collectorId,
      mac,
      bucket_start: fmt(at),
      bytes_in: bytes.in,
      bytes_out: bytes.out,
      packets_in: 1,
      packets_out: 1,
      bytes_in_wan: wanIn,
      bytes_out_wan: wanOut,
      packets_in_wan: 0,
      packets_out_wan: 0,
      bytes_in_lan: bytes.in - wanIn,
      bytes_out_lan: bytes.out - wanOut,
      packets_in_lan: 1,
      packets_out_lan: 1,
      created_at: now,
      updated_at: now,
    })
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
    lastStatus: null,
  })

  const t1 = DateTime.utc().minus({ minutes: 20 }).startOf('minute')
  const t2 = t1.plus({ minutes: 1 })

  // A: biggest total, mostly download. B: biggest uploader. C: tiny.
  await insertBucket(collector.id, A, t1, { in: 1000, out: 100, wanIn: 700, wanOut: 50 })
  await insertBucket(collector.id, A, t2, { in: 1000, out: 100, wanIn: 700, wanOut: 50 })
  await insertBucket(collector.id, B, t1, { in: 300, out: 900, wanIn: 0, wanOut: 900 })
  await insertBucket(collector.id, C, t1, { in: 50, out: 10 })

  const now = fmt(DateTime.utc())
  await db
    .insertQuery()
    .table('device_identities')
    .insert({
      collector_id: collector.id,
      mac: A,
      primary_ip: '10.0.0.5',
      ips: JSON.stringify(['10.0.0.5']),
      first_seen_at: now,
      last_seen_at: now,
      created_at: now,
      updated_at: now,
    })

  return { token: token.value!.release(), t1, t2, collectorId: collector.id }
}

test.group('devices | traffic/top', (group) => {
  group.each.setup(resetDb)

  test('ranks the top N by total bytes and folds the rest into one series', async ({
    client,
    assert,
  }) => {
    const ctx = await bootstrap()
    const r = await client
      .get('/api/v1/traffic/top?range=1h&resolution=1m&limit=2')
      .bearerToken(ctx.token)
    r.assertStatus(200)
    const body = r.body().data

    assert.equal(body.resolution, '1m')
    assert.equal(body.limit, 2)
    assert.equal(body.by, 'total')
    assert.equal(body.scope, 'all')

    assert.deepEqual(
      body.devices.map((d: { mac: string }) => d.mac),
      [A, B]
    )
    assert.equal(body.devices[0].bytesIn, 2000)
    assert.equal(body.devices[0].bytesOut, 200)
    assert.equal(body.devices[0].primaryIp, '10.0.0.5')
    assert.isNull(body.devices[1].primaryIp)
    assert.deepEqual(body.rest, { deviceCount: 1, bytesIn: 50, bytesOut: 10 })

    // Dense: every minute of the hour (plus the partial one at the start),
    // each carrying both top devices.
    assert.equal(body.bucketSeconds, 60)
    assert.equal(body.source, 'native')
    assert.isAtLeast(body.buckets.length, 59)
    assert.isAtMost(body.buckets.length, 61)
    for (const bucket of body.buckets) {
      assert.includeMembers(Object.keys(bucket.devices), [A, B])
      assert.isNumber(bucket.seconds)
    }
    const at = (t: DateTime) =>
      body.buckets.find((b: { bucketStart: string }) => b.bucketStart === t.toISO())
    const first = at(ctx.t1)
    assert.equal(first.seconds, 60)
    assert.equal(first.devices[A].bytesIn, 1000)
    assert.closeTo(first.devices[A].mbpsIn, (1000 * 8) / 60 / 1e6, 1e-12)
    assert.equal(first.devices[B].bytesOut, 900)
    assert.deepEqual(first.rest, {
      bytesIn: 50,
      bytesOut: 10,
      mbpsIn: (50 * 8) / 60 / 1e6,
      mbpsOut: (10 * 8) / 60 / 1e6,
    })
    assert.isUndefined(first.devices[C], 'C is folded into rest')

    const second = at(ctx.t2)
    assert.equal(second.devices[A].bytesIn, 1000)
    assert.deepEqual(second.devices[B], { bytesIn: 0, bytesOut: 0, mbpsIn: 0, mbpsOut: 0 })
    assert.deepEqual(second.rest, { bytesIn: 0, bytesOut: 0, mbpsIn: 0, mbpsOut: 0 })

    // The quiet minute after t2 is there too, all zero.
    const quiet = at(ctx.t2.plus({ minutes: 1 }))
    assert.equal(quiet.devices[A].bytesIn, 0)

    // Legend totals are the chart's area.
    const chartA = body.buckets.reduce(
      (sum: number, b: { devices: Record<string, { bytesIn: number }> }) =>
        sum + b.devices[A].bytesIn,
      0
    )
    assert.equal(chartA, body.devices[0].bytesIn)
  })

  test('by=upload changes the ranking and limit=1 grows the rest', async ({ client, assert }) => {
    const ctx = await bootstrap()
    const r = await client
      .get('/api/v1/traffic/top?range=1h&resolution=1m&limit=1&by=upload')
      .bearerToken(ctx.token)
    r.assertStatus(200)
    const body = r.body().data
    assert.deepEqual(
      body.devices.map((d: { mac: string }) => d.mac),
      [B]
    )
    assert.deepEqual(body.rest, { deviceCount: 2, bytesIn: 2050, bytesOut: 210 })
    const first = body.buckets.find(
      (b: { bucketStart: string }) => b.bucketStart === ctx.t1.toISO()
    )
    assert.equal(first.rest.bytesIn, 1050)
  })

  test('scope=wan reads the WAN split columns', async ({ client, assert }) => {
    const ctx = await bootstrap()
    const r = await client
      .get('/api/v1/traffic/top?range=1h&resolution=1m&limit=5&scope=wan')
      .bearerToken(ctx.token)
    r.assertStatus(200)
    const body = r.body().data
    // C has no WAN bytes at all, so it drops out entirely.
    assert.deepEqual(
      body.devices.map((d: { mac: string }) => d.mac),
      [A, B]
    )
    assert.equal(body.devices[0].bytesIn, 1400)
    assert.equal(body.devices[1].bytesOut, 900)
    assert.deepEqual(body.rest, { deviceCount: 0, bytesIn: 0, bytesOut: 0 })
    const first = body.buckets.find(
      (b: { bucketStart: string }) => b.bucketStart === ctx.t1.toISO()
    )
    assert.equal(first.devices[A].bytesIn, 700)
  })

  test('an empty window returns no devices and every bucket as zero', async ({
    client,
    assert,
  }) => {
    const ctx = await bootstrap()
    const from = DateTime.utc().minus({ days: 3 }).toISO()
    const to = DateTime.utc().minus({ days: 2 }).toISO()
    const r = await client
      .get(`/api/v1/traffic/top?from=${from}&to=${to}&resolution=5m`)
      .bearerToken(ctx.token)
    r.assertStatus(200)
    const body = r.body().data
    assert.deepEqual(body.devices, [])
    assert.equal(body.rest.deviceCount, 0)
    // The chart keeps its axis over a quiet window.
    assert.isAbove(body.buckets.length, 0)
    for (const bucket of body.buckets) {
      assert.deepEqual(bucket.devices, {})
      assert.equal(bucket.rest.bytesIn + bucket.rest.bytesOut, 0)
    }
  })

  test('equal totals rank by MAC, so the set never flips between refreshes', async ({
    client,
    assert,
  }) => {
    const ctx = await bootstrap()
    const collectorId = ctx.collectorId
    const D = '02:00:00:00:00:0d'
    // D ties with B (1200 bytes each) and sorts before it, on every refresh.
    await insertBucket(collectorId, D, ctx.t1, { in: 1000, out: 200 })
    for (let i = 0; i < 2; i += 1) {
      _resetQueryCache()
      const r = await client
        .get('/api/v1/traffic/top?range=1h&resolution=1m&limit=2')
        .bearerToken(ctx.token)
      r.assertStatus(200)
      assert.deepEqual(
        r.body().data.devices.map((d: { mac: string }) => d.mac),
        [A, D]
      )
    }
  })

  test('partial first and live last buckets rate over their own seconds', async ({
    client,
    assert,
  }) => {
    const ctx = await bootstrap()
    // Window 16:20:30 … 16:23:30 (relative to t1): the first minute bucket
    // is half inside, the last half inside.
    const from = ctx.t1.minus({ seconds: 30 })
    const to = ctx.t2.plus({ seconds: 90 })
    const r = await client
      .get(`/api/v1/traffic/top?from=${from.toISO()}&to=${to.toISO()}&resolution=1m&limit=2`)
      .bearerToken(ctx.token)
    r.assertStatus(200)
    const body = r.body().data
    assert.deepEqual(
      body.buckets.map((b: { seconds: number }) => b.seconds),
      [30, 60, 60, 30]
    )
    // A's t1 bucket: 1000 bytes over a full minute.
    assert.closeTo(body.buckets[1].devices[A].mbpsIn, (1000 * 8) / 60 / 1e6, 1e-12)
  })

  test('without resolution the Settings → Charts floor sets the width', async ({
    client,
    assert,
  }) => {
    const ctx = await bootstrap()
    await SystemSetting.set('charts', { minBucketSeconds: 30, maxPoints: 1500 })
    const r = await client.get('/api/v1/traffic/top?range=1h&limit=2').bearerToken(ctx.token)
    r.assertStatus(200)
    const body = r.body().data
    assert.equal(body.bucketSeconds, 30)
    assert.equal(body.resolution, '30s')
    assert.equal(body.floorSeconds, 30)
    // An explicit resolution still wins over the floor.
    const fine = await client
      .get('/api/v1/traffic/top?range=10m&resolution=15s&limit=2')
      .bearerToken(ctx.token)
    assert.equal(fine.body().data.bucketSeconds, 15)
  })

  test('the newest rows wait for their poll to complete', async ({ client, assert }) => {
    const ctx = await bootstrap()
    const collectorId = ctx.collectorId
    // A row stamped this very poll interval is not in the series yet: the
    // live bucket's seconds stop at the last complete poll, and its bytes
    // with them (no dip, no overshoot).
    const poll = Math.floor(DateTime.utc().toSeconds() / 5) * 5
    await insertBucket(collectorId, A, DateTime.fromSeconds(poll, { zone: 'utc' }), {
      in: 999_999,
      out: 0,
    })
    const r = await client
      .get('/api/v1/traffic/top?range=10m&resolution=15s&limit=2')
      .bearerToken(ctx.token)
    r.assertStatus(200)
    const body = r.body().data
    const last = body.buckets.at(-1)
    const lastEnd = Date.parse(last.bucketStart) / 1000 + last.seconds
    assert.isAtMost(lastEnd, poll, 'the data ends before the newest poll')
    const total = body.buckets.reduce(
      (sum: number, b: { devices: Record<string, { bytesIn: number }> }) =>
        sum + (b.devices[A]?.bytesIn ?? 0),
      0
    )
    assert.equal(total, 0, 'the unfinished poll is left out')
  })

  test('rejects limit above 10', async ({ client }) => {
    const ctx = await bootstrap()
    const r = await client.get('/api/v1/traffic/top?range=1h&limit=50').bearerToken(ctx.token)
    r.assertStatus(422)
  })
})
