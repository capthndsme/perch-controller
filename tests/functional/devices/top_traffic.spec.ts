import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import { _resetQueryCache } from '#services/query_cache'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  _resetQueryCache()
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

  return { token: token.value!.release(), t1, t2 }
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

    assert.lengthOf(body.buckets, 2)
    const first = body.buckets[0]
    assert.equal(first.bucketStart, ctx.t1.toISO())
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

    const second = body.buckets[1]
    assert.equal(second.bucketStart, ctx.t2.toISO())
    assert.equal(second.devices[A].bytesIn, 1000)
    assert.isUndefined(second.devices[B])
    assert.deepEqual(second.rest, { bytesIn: 0, bytesOut: 0, mbpsIn: 0, mbpsOut: 0 })
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
    assert.equal(body.buckets[0].rest.bytesIn, 1050)
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
    assert.equal(body.buckets[0].devices[A].bytesIn, 700)
  })

  test('an empty window returns no devices and no buckets', async ({ client, assert }) => {
    const ctx = await bootstrap()
    const from = DateTime.utc().minus({ days: 3 }).toISO()
    const to = DateTime.utc().minus({ days: 2 }).toISO()
    const r = await client
      .get(`/api/v1/traffic/top?from=${from}&to=${to}&resolution=5m`)
      .bearerToken(ctx.token)
    r.assertStatus(200)
    assert.deepEqual(r.body().data.devices, [])
    assert.deepEqual(r.body().data.buckets, [])
    assert.equal(r.body().data.rest.deviceCount, 0)
  })

  test('rejects limit above 10', async ({ client }) => {
    const ctx = await bootstrap()
    const r = await client.get('/api/v1/traffic/top?range=1h&limit=50').bearerToken(ctx.token)
    r.assertStatus(422)
  })
})
