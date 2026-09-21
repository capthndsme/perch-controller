import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import { _resetPollerState } from '#services/collector_poller'
import { upsertProtocolCategories } from '#services/protocol_categories'
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

/** Manila is UTC+8 all year, so local days start at 16:00Z the day before. */
const TZ = 'Asia/Manila'

async function bootstrap() {
  const admin = await User.create({
    fullName: 'Admin',
    email: 'admin@example.com',
    password: 'admin-pass-123',
    role: 'admin',
  })
  const token = await User.accessTokens.create(admin)
  await SystemSetting.set('site_name', 'Perch @ test')
  await SystemSetting.set('timezone', TZ)
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

const A = 'aa:aa:aa:aa:aa:01'
const B = 'aa:aa:aa:aa:aa:02'
const sqlTs = (dt: DateTime) => dt.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')

async function hourly(
  collectorId: number,
  mac: string,
  at: DateTime,
  bytesIn: number,
  bytesOut: number,
  wan = true
) {
  await db.table('device_traffic_buckets_hourly').insert({
    collector_id: collectorId,
    mac,
    hour_start: sqlTs(at),
    bytes_in: bytesIn,
    bytes_out: bytesOut,
    packets_in: 1,
    packets_out: 1,
    bytes_in_wan: wan ? bytesIn : 0,
    bytes_out_wan: wan ? bytesOut : 0,
    packets_in_wan: wan ? 1 : 0,
    packets_out_wan: wan ? 1 : 0,
    bytes_in_lan: wan ? 0 : bytesIn,
    bytes_out_lan: wan ? 0 : bytesOut,
    packets_in_lan: wan ? 0 : 1,
    packets_out_lan: wan ? 0 : 1,
    updated_at: sqlTs(at),
  })
}

async function hourlyProtocol(
  collectorId: number,
  mac: string,
  at: DateTime,
  protocol: string,
  bytesIn: number,
  bytesOut: number
) {
  await db.table('device_protocol_buckets_hourly').insert({
    collector_id: collectorId,
    mac,
    protocol,
    hour_start: sqlTs(at),
    bytes_in: bytesIn,
    bytes_out: bytesOut,
    packets_in: 1,
    packets_out: 1,
    updated_at: sqlTs(at),
  })
}

async function wifiTotal(at: DateTime, count: number, grain = 300) {
  await db.table('wifi_client_totals').insert({
    grain_seconds: grain,
    slot_start: sqlTs(at),
    client_count: count,
    updated_at: sqlTs(at),
  })
}

test.group('usage read API', (group) => {
  group.each.setup(resetDb)

  test('daily buckets are local days with totals, devices, wifi and protocols', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    await upsertProtocolCategories([{ protocol: 'youtube', category: 'media' }])

    // Local 2026-08-10 runs 2026-08-09T16:00Z → 2026-08-10T16:00Z.
    const day1 = DateTime.fromISO('2026-08-10T00:00:00', { zone: TZ })
    const day2 = day1.plus({ days: 1 })
    // 23:00 local on the 10th must stay on the 10th; 00:00 local on the 11th on the 11th.
    await hourly(collector.id, A, day1.plus({ hours: 23 }), 1_000_000, 100_000)
    await hourly(collector.id, B, day1.plus({ hours: 23 }), 500_000, 50_000, false)
    await hourly(collector.id, A, day2, 2_000_000, 200_000)
    await hourlyProtocol(collector.id, A, day1.plus({ hours: 23 }), 'youtube', 900_000, 90_000)
    await hourlyProtocol(collector.id, A, day1.plus({ hours: 23 }), 'https', 400_000, 40_000)
    await hourlyProtocol(collector.id, A, day1.plus({ hours: 23 }), 'dns', 100_000, 10_000)
    await hourlyProtocol(collector.id, A, day1.plus({ hours: 23 }), 'ntp', 100_000, 10_000)
    await wifiTotal(day1.plus({ hours: 1 }), 10)
    await wifiTotal(day1.plus({ hours: 2 }), 30)
    await wifiTotal(day1.plus({ hours: 3 }), 20)

    const from = day1.toUTC().toISO()
    const to = day2.plus({ days: 1 }).toUTC().toISO()
    const r = await client
      .get(`/api/v1/usage?period=day&from=${from}&to=${to}&protocols=2`)
      .bearerToken(token)
    r.assertStatus(200)
    const body = r.body().data
    assert.equal(body.timezone, TZ)
    assert.equal(body.offsetMinutes, 480)
    assert.equal(body.source, 'hourly')
    assert.equal(body.buckets.length, 2)

    const [b1, b2] = body.buckets
    assert.equal(b1.label, '2026-08-10')
    assert.equal(b1.bucketStart, '2026-08-09T16:00:00.000Z')
    assert.isFalse(b1.partial)
    assert.equal(b1.seconds, 86400)
    assert.equal(b1.bytesIn, 1_500_000)
    assert.equal(b1.bytesOut, 150_000)
    assert.equal(b1.totalBytes, 1_650_000)
    assert.equal(b1.avgMbps, 0.000153, '13.2 Mbit over a day')
    assert.equal(b1.activeDevices, 2)
    assert.equal(b1.wifiClients.avg, 20)
    assert.equal(b1.wifiClients.max, 30)
    assert.equal(b1.wifiClients.peakAt, day1.plus({ hours: 2 }).toUTC().toISO())
    assert.equal(b1.protocols.length, 2)
    assert.equal(b1.protocols[0].protocol, 'youtube')
    assert.equal(b1.protocols[0].category, 'media')
    assert.equal(b1.protocols[0].percentage, 60)
    assert.equal(b1.protocols[1].protocol, 'https')
    assert.equal(b1.otherProtocols.count, 2)
    assert.equal(b1.otherProtocols.totalBytes, 220_000)
    // Categories are complete (not top-N): dns + ntp fold into "network".
    assert.deepEqual(
      b1.categories.map((c: { category: string; totalBytes: number }) => [
        c.category,
        c.totalBytes,
      ]),
      [
        ['media', 990_000],
        ['web', 440_000],
        ['network', 220_000],
      ]
    )
    assert.equal(b1.categories[0].percentage, 60)

    assert.equal(b2.label, '2026-08-11')
    assert.equal(b2.bytesIn, 2_000_000)
    assert.equal(b2.activeDevices, 1)
    assert.isNull(b2.wifiClients.avg)
    assert.deepEqual(b2.protocols, [])
    assert.isNull(b2.otherProtocols)

    assert.equal(body.totals.bytesIn, 3_500_000)
    assert.equal(body.totals.seconds, 172_800)
    assert.equal(body.totals.activeDevices, 2, 'distinct over the window, not summed')
    assert.equal(body.totals.wifiClients.max, 30)
    assert.equal(body.totals.protocols[0].protocol, 'youtube')
    assert.equal(body.totals.categories[0].category, 'media')
    assert.equal(body.totals.categories[0].totalBytes, 990_000)
  })

  test('intervals: local-midnight aligned slots, auto interval by span', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    const day1 = DateTime.fromISO('2026-08-10T00:00:00', { zone: TZ })
    // 23:00 local → last 4 h slot of the 10th (20–24); 00:00 next day → first slot of the 11th.
    await hourly(collector.id, A, day1.plus({ hours: 23 }), 1_000, 100)
    await hourly(collector.id, B, day1.plus({ hours: 23 }), 500, 50)
    await hourly(collector.id, A, day1.plus({ days: 1 }), 2_000, 200)
    await hourly(collector.id, A, day1.plus({ days: 1, hours: 3 }), 4_000, 400)

    const from = day1.toUTC().toISO()
    const to = day1.plus({ days: 2 }).toUTC().toISO()
    const r = await client
      .get(`/api/v1/usage/intervals?from=${from}&to=${to}&interval=4h`)
      .bearerToken(token)
    r.assertStatus(200)
    const body = r.body().data
    assert.equal(body.interval, '4h')
    assert.equal(body.intervalSeconds, 14400)
    assert.equal(body.buckets.length, 12)
    assert.equal(body.buckets[0].bucketStart, day1.toUTC().toISO(), 'first slot is local midnight')
    const late = body.buckets[5]
    assert.equal(late.bucketStart, day1.plus({ hours: 20 }).toUTC().toISO())
    assert.equal(late.bytesIn, 1_500)
    assert.equal(late.activeDevices, 2)
    assert.equal(late.seconds, 14400)
    assert.isFalse(late.partial)
    const first11 = body.buckets[6]
    assert.equal(first11.bucketStart, day1.plus({ days: 1 }).toUTC().toISO())
    assert.equal(first11.bytesIn, 6_000, '00:00 and 03:00 share the 00–04 slot')
    assert.equal(body.buckets[7].bytesIn, 0)

    const auto7 = await client.get('/api/v1/usage/intervals?range=7d').bearerToken(token)
    assert.equal(auto7.body().data.interval, '1h')
    assert.isTrue(auto7.body().data.buckets[auto7.body().data.buckets.length - 1].partial)
    const auto30 = await client.get('/api/v1/usage/intervals?range=30d').bearerToken(token)
    assert.equal(auto30.body().data.interval, '8h')
    const auto90 = await client.get('/api/v1/usage/intervals?range=90d').bearerToken(token)
    assert.equal(auto90.body().data.interval, '12h')
    const bad = await client.get('/api/v1/usage/intervals?interval=2h').bearerToken(token)
    bad.assertStatus(422)
  })

  test('scope=wan drops LAN bytes; week and month buckets fold correctly', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    const day1 = DateTime.fromISO('2026-08-10T00:00:00', { zone: TZ }) // a Monday
    await hourly(collector.id, A, day1.plus({ hours: 5 }), 1_000, 100)
    await hourly(collector.id, B, day1.plus({ hours: 5 }), 5_000, 500, false)
    await hourly(collector.id, A, day1.plus({ days: 8 }), 2_000, 200) // next ISO week
    await hourly(collector.id, A, day1.plus({ days: 25 }), 4_000, 400) // September

    const from = day1.toUTC().toISO()
    const to = day1.plus({ days: 30 }).toUTC().toISO()
    const wan = await client
      .get(`/api/v1/usage?period=week&from=${from}&to=${to}&scope=wan`)
      .bearerToken(token)
    wan.assertStatus(200)
    const weeks = wan.body().data.buckets
    assert.equal(weeks.length, 5)
    assert.equal(weeks[0].label, '2026-W33')
    assert.equal(weeks[0].bucketStart, day1.toUTC().toISO(), 'weeks start on the local Monday')
    assert.equal(weeks[0].bytesIn, 1_000, 'LAN bytes excluded under scope=wan')
    assert.equal(weeks[1].bytesIn, 2_000)
    assert.equal(wan.body().data.totals.bytesIn, 7_000)

    const all = await client
      .get(`/api/v1/usage?period=month&from=${from}&to=${to}`)
      .bearerToken(token)
    all.assertStatus(200)
    const months = all.body().data.buckets
    assert.equal(months.length, 2)
    assert.equal(months[0].label, '2026-08')
    assert.equal(months[0].bucketStart, day1.startOf('month').toUTC().toISO())
    assert.equal(months[0].bytesIn, 8_000, 'LAN included under scope=all')
    assert.equal(months[1].label, '2026-09')
    assert.equal(months[1].bytesIn, 4_000)
    assert.isTrue(months[1].partial, 'cut short by `to`')
  })

  test('the running bucket is partial and rated on elapsed time; defaults apply', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    const now = DateTime.utc()
    const lastHour = now.minus({ hours: 1 }).startOf('hour')
    await hourly(collector.id, A, lastHour, 36_000_000, 0)

    const r = await client.get('/api/v1/usage').bearerToken(token)
    r.assertStatus(200)
    const body = r.body().data
    assert.equal(body.period, 'day')
    assert.equal(body.range, '30d')
    assert.isAtLeast(body.buckets.length, 30)
    const last = body.buckets[body.buckets.length - 1]
    assert.isTrue(last.partial)
    assert.isBelow(last.seconds, 86400)
    assert.isAtLeast(last.bytesIn + body.buckets[body.buckets.length - 2].bytesIn, 36_000_000)
    for (const b of body.buckets.slice(0, -1)) assert.isFalse(b.partial)
  })

  test('rejects an unknown period', async ({ client }) => {
    const { token } = await bootstrap()
    const r = await client.get('/api/v1/usage?period=year').bearerToken(token)
    r.assertStatus(422)
  })
})
