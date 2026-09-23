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

/**
 * `?mac=` on `/usage` and `/usage/intervals`: one device's usage for the
 * device page's Usage card. Same buckets and alignment as the network-wide
 * report, read from that MAC's rows only.
 */

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

const A = '02:00:00:00:00:0a'
const B = '02:00:00:00:00:0b'
const sqlTs = (dt: DateTime) => dt.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')

function trafficRow(
  collectorId: number,
  mac: string,
  bytesIn: number,
  bytesOut: number,
  wan: boolean
) {
  return {
    collector_id: collectorId,
    mac,
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
  }
}

async function hourly(
  collectorId: number,
  mac: string,
  at: DateTime,
  bytesIn: number,
  bytesOut: number,
  wan = true
) {
  await db.table('device_traffic_buckets_hourly').insert({
    ...trafficRow(collectorId, mac, bytesIn, bytesOut, wan),
    hour_start: sqlTs(at),
    updated_at: sqlTs(at),
  })
}

async function daily(
  collectorId: number,
  mac: string,
  dayUtc: string,
  bytesIn: number,
  bytesOut: number
) {
  await db.table('device_traffic_buckets_daily').insert({
    ...trafficRow(collectorId, mac, bytesIn, bytesOut, true),
    day_start: `${dayUtc} 00:00:00`,
    updated_at: `${dayUtc} 00:00:00`,
  })
}

async function protocolRow(
  table: 'device_protocol_buckets_hourly' | 'device_protocol_buckets_daily',
  collectorId: number,
  mac: string,
  at: string,
  protocol: string,
  bytesIn: number,
  bytesOut: number
) {
  await db.table(table).insert({
    collector_id: collectorId,
    mac,
    protocol,
    [table === 'device_protocol_buckets_daily' ? 'day_start' : 'hour_start']: at,
    bytes_in: bytesIn,
    bytes_out: bytesOut,
    packets_in: 1,
    packets_out: 1,
    updated_at: at,
  })
}

async function wifiTotal(at: DateTime, count: number) {
  await db.table('wifi_client_totals').insert({
    grain_seconds: 300,
    slot_start: sqlTs(at),
    client_count: count,
    updated_at: sqlTs(at),
  })
}

/** Two devices on local 2026-08-10 and 11, protocols for both, Wi-Fi totals. */
async function seedTwoDays(collectorId: number) {
  await upsertProtocolCategories([{ protocol: 'youtube', category: 'media' }])
  const day1 = DateTime.fromISO('2026-08-10T00:00:00', { zone: TZ })
  const day2 = day1.plus({ days: 1 })
  // 23:00 local on the 10th stays on the 10th; 00:00 on the 11th is the 11th.
  await hourly(collectorId, A, day1.plus({ hours: 23 }), 1_000_000, 100_000)
  await hourly(collectorId, B, day1.plus({ hours: 23 }), 500_000, 50_000, false)
  await hourly(collectorId, A, day2, 2_000_000, 200_000, false)
  await hourly(collectorId, B, day2.plus({ hours: 4 }), 7_000_000, 700_000)
  const at = sqlTs(day1.plus({ hours: 23 }))
  const hourlyTable = 'device_protocol_buckets_hourly'
  await protocolRow(hourlyTable, collectorId, A, at, 'youtube', 900_000, 90_000)
  await protocolRow(hourlyTable, collectorId, A, at, 'https', 100_000, 10_000)
  await protocolRow(hourlyTable, collectorId, B, at, 'bittorrent', 500_000, 50_000)
  await protocolRow(hourlyTable, collectorId, B, sqlTs(day2), 'dns', 1_000, 100)
  await wifiTotal(day1.plus({ hours: 2 }), 12)
  return { day1, day2, from: day1.toUTC().toISO()!, to: day2.plus({ days: 1 }).toUTC().toISO()! }
}

test.group('usage read API: per device (?mac=)', (group) => {
  group.each.setup(resetDb)

  test("daily: only that device's bytes and protocols; network columns are null", async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    const { from, to } = await seedTwoDays(collector.id)

    // Network-wide first: the same window must not come back from the cache
    // for the device query.
    const all = await client
      .get(`/api/v1/usage?period=day&from=${from}&to=${to}`)
      .bearerToken(token)
    all.assertStatus(200)
    assert.equal(all.body().data.totals.bytesIn, 10_500_000)

    // Upper case and dashes are accepted and echoed normalised.
    const r = await client
      .get(`/api/v1/usage?period=day&from=${from}&to=${to}&mac=02-00-00-00-00-0A`)
      .bearerToken(token)
    r.assertStatus(200)
    const body = r.body().data
    assert.equal(body.mac, A)
    assert.equal(body.source, 'hourly')
    assert.equal(body.offsetMinutes, 480)
    assert.lengthOf(body.buckets, 2)

    const [b1, b2] = body.buckets
    assert.equal(b1.label, '2026-08-10')
    assert.equal(b1.bucketStart, '2026-08-09T16:00:00.000Z')
    assert.equal(b1.bytesIn, 1_000_000, "B's 500 kB in the same hour is not counted")
    assert.equal(b1.bytesOut, 100_000)
    assert.equal(b1.totalBytes, 1_100_000)
    assert.isNull(b1.activeDevices)
    assert.isNull(b1.wifiClients, 'Wi-Fi totals exist for the day but are network-wide')
    assert.deepEqual(
      b1.protocols.map((p: { protocol: string; percentage: number }) => [p.protocol, p.percentage]),
      [
        ['youtube', 90],
        ['https', 10],
      ]
    )
    assert.equal(b1.protocols[0].category, 'media')
    assert.isNull(b1.otherProtocols)
    assert.deepEqual(
      b1.categories.map((c: { category: string }) => c.category),
      ['media', 'web']
    )

    assert.equal(b2.label, '2026-08-11')
    assert.equal(b2.bytesIn, 2_000_000)
    assert.deepEqual(b2.protocols, [], "B's dns row is not A's")
    assert.isNull(b2.activeDevices)

    assert.equal(body.totals.bytesIn, 3_000_000)
    assert.equal(body.totals.bytesOut, 300_000)
    assert.isNull(body.totals.activeDevices)
    assert.isNull(body.totals.wifiClients)
    assert.equal(body.totals.protocols[0].protocol, 'youtube')

    // The other device, same window.
    const other = await client
      .get(`/api/v1/usage?period=day&from=${from}&to=${to}&mac=${B}`)
      .bearerToken(token)
    other.assertStatus(200)
    assert.equal(other.body().data.mac, B)
    assert.deepEqual(
      other.body().data.buckets.map((b: { bytesIn: number }) => b.bytesIn),
      [500_000, 7_000_000]
    )
    assert.equal(other.body().data.totals.protocols[0].protocol, 'bittorrent')
  })

  test('scope applies to the device bytes; protocols stay device totals', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    const { from, to } = await seedTwoDays(collector.id)

    const wan = await client
      .get(`/api/v1/usage?period=day&from=${from}&to=${to}&mac=${A}&scope=wan`)
      .bearerToken(token)
    wan.assertStatus(200)
    assert.equal(wan.body().data.scope, 'wan')
    assert.deepEqual(
      wan.body().data.buckets.map((b: { bytesIn: number }) => b.bytesIn),
      [1_000_000, 0],
      "A's LAN-only hour on the 11th drops out"
    )
    const lan = await client
      .get(`/api/v1/usage?period=day&from=${from}&to=${to}&mac=${A}&scope=lan`)
      .bearerToken(token)
    assert.deepEqual(
      lan.body().data.buckets.map((b: { bytesIn: number }) => b.bytesIn),
      [0, 2_000_000]
    )
    assert.equal(lan.body().data.buckets[0].protocols[0].protocol, 'youtube')
  })

  test('monthly over the daily rollups, and a month cut short by `to`', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    // Daily rows are UTC days; 00:00Z folds to 08:00 local, same month.
    await daily(collector.id, A, '2026-03-15', 3_000, 300)
    await daily(collector.id, A, '2026-03-31', 1_000, 100)
    await daily(collector.id, B, '2026-03-15', 9_000, 900)
    await daily(collector.id, A, '2026-05-20', 5_000, 500)
    await daily(collector.id, B, '2026-06-02', 8_000, 800)
    const dailyTable = 'device_protocol_buckets_daily'
    await protocolRow(dailyTable, collector.id, A, '2026-03-15 00:00:00', 'netflix', 2_000, 200)
    await protocolRow(dailyTable, collector.id, B, '2026-03-15 00:00:00', 'zoom', 9_000, 900)

    const from = DateTime.fromISO('2026-01-01T00:00:00', { zone: TZ }).toUTC().toISO()
    const to = DateTime.fromISO('2026-06-10T00:00:00', { zone: TZ }).toUTC().toISO()
    const r = await client
      .get(`/api/v1/usage?period=month&from=${from}&to=${to}&mac=${A}`)
      .bearerToken(token)
    r.assertStatus(200)
    const body = r.body().data
    assert.equal(body.source, 'daily', 'over 120 days reads the daily rollups')
    assert.deepEqual(
      body.buckets.map((b: { label: string }) => b.label),
      ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']
    )
    assert.deepEqual(
      body.buckets.map((b: { bytesIn: number }) => b.bytesIn),
      [0, 0, 4_000, 0, 5_000, 0]
    )
    assert.equal(body.buckets[2].bucketStart, '2026-02-28T16:00:00.000Z')
    assert.equal(body.buckets[2].protocols[0].protocol, 'netflix')
    assert.lengthOf(body.buckets[2].protocols, 1)
    const june = body.buckets[5]
    assert.isTrue(june.partial, 'cut short by `to`')
    assert.equal(june.seconds, 9 * 86400)
    assert.isNull(june.activeDevices)
    assert.equal(body.totals.bytesIn, 9_000)

    // A 3-month monthly window stays on the hourly rollups.
    const since = DateTime.fromISO('2026-04-01T00:00:00', { zone: TZ })
    await hourly(collector.id, A, since.plus({ days: 3 }), 1_234, 0)
    await hourly(collector.id, B, since.plus({ days: 3 }), 99_999, 0)
    const short = await client
      .get(
        `/api/v1/usage?period=month&from=${since.toUTC().toISO()}&to=${since.plus({ months: 3 }).toUTC().toISO()}&mac=${A}`
      )
      .bearerToken(token)
    short.assertStatus(200)
    assert.equal(short.body().data.source, 'hourly')
    assert.deepEqual(
      short.body().data.buckets.map((b: { bytesIn: number }) => b.bytesIn),
      [1_234, 0, 0]
    )
  })

  test("the running day is partial and holds the device's last hour", async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    const lastHour = DateTime.utc().minus({ hours: 1 }).startOf('hour')
    await hourly(collector.id, A, lastHour, 36_000_000, 0)
    await hourly(collector.id, B, lastHour, 1, 0)

    const r = await client.get(`/api/v1/usage?period=day&range=7d&mac=${A}`).bearerToken(token)
    r.assertStatus(200)
    const body = r.body().data
    assert.equal(body.range, '7d')
    assert.lengthOf(body.buckets, 8, '7 days back from now touch 8 local days')
    const last = body.buckets[body.buckets.length - 1]
    assert.isTrue(last.partial)
    assert.isBelow(last.seconds, 86400)
    // The last hour is today, or yesterday right after local midnight.
    const lastTwo = body.buckets.slice(-2)
    assert.equal(lastTwo[0].bytesIn + lastTwo[1].bytesIn, 36_000_000)
    for (const b of body.buckets.slice(0, -1)) assert.isFalse(b.partial)
    assert.equal(body.totals.bytesIn, 36_000_000)
  })

  test('an unknown MAC is every bucket at zero, not a 404', async ({ client, assert }) => {
    const { token, collector } = await bootstrap()
    const { from, to } = await seedTwoDays(collector.id)
    const r = await client
      .get(`/api/v1/usage?period=day&from=${from}&to=${to}&mac=02:00:00:00:00:ff`)
      .bearerToken(token)
    r.assertStatus(200)
    const body = r.body().data
    assert.equal(body.mac, '02:00:00:00:00:ff')
    assert.lengthOf(body.buckets, 2)
    for (const b of body.buckets) {
      assert.equal(b.totalBytes, 0)
      assert.deepEqual(b.protocols, [])
      assert.isNull(b.activeDevices)
    }
    assert.equal(body.totals.totalBytes, 0)

    const slots = await client
      .get(`/api/v1/usage/intervals?from=${from}&to=${to}&interval=8h&mac=02:00:00:00:00:ff`)
      .bearerToken(token)
    slots.assertStatus(200)
    assert.lengthOf(slots.body().data.buckets, 6)
    for (const b of slots.body().data.buckets) assert.equal(b.totalBytes, 0)
  })

  test("intervals: the device's slots only, activeDevices null, mac echoed", async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    const { day1, from, to } = await seedTwoDays(collector.id)
    const r = await client
      .get(`/api/v1/usage/intervals?from=${from}&to=${to}&interval=4h&mac=${A.toUpperCase()}`)
      .bearerToken(token)
    r.assertStatus(200)
    const body = r.body().data
    assert.equal(body.mac, A)
    assert.lengthOf(body.buckets, 12)
    const late = body.buckets[5]
    assert.equal(late.bucketStart, day1.plus({ hours: 20 }).toUTC().toISO())
    assert.equal(late.bytesIn, 1_000_000)
    assert.isNull(late.activeDevices)
    assert.equal(body.buckets[6].bytesIn, 2_000_000)
    assert.equal(body.buckets[7].bytesIn, 0, "B's 04:00 hour on the 11th is not A's")
    assert.equal(
      body.buckets.reduce((sum: number, b: { bytesIn: number }) => sum + b.bytesIn, 0),
      3_000_000
    )

    const wan = await client
      .get(`/api/v1/usage/intervals?from=${from}&to=${to}&interval=4h&mac=${A}&scope=wan`)
      .bearerToken(token)
    assert.equal(wan.body().data.buckets[6].bytesIn, 0)
  })

  test('an invalid mac is a 422 on both endpoints', async ({ client }) => {
    const { token } = await bootstrap()
    for (const bad of ['nope', '02:00:00:00:00', '02:00:00:00:00:0g', '0200.0000.000a', '']) {
      const usage = await client
        .get(`/api/v1/usage?mac=${encodeURIComponent(bad)}`)
        .bearerToken(token)
      usage.assertStatus(422)
      const slots = await client
        .get(`/api/v1/usage/intervals?mac=${encodeURIComponent(bad)}`)
        .bearerToken(token)
      slots.assertStatus(422)
    }
  })

  test('without mac the response is unchanged', async ({ client, assert }) => {
    const { token, collector } = await bootstrap()
    const { from, to } = await seedTwoDays(collector.id)

    // Golden bodies taken from the code before `mac` existed (22a286e).
    const usage = await client
      .get(`/api/v1/usage?period=day&from=${from}&to=${to}&protocols=2`)
      .bearerToken(token)
    usage.assertStatus(200)
    assert.equal(JSON.stringify(usage.body().data), GOLDEN_USAGE)

    const slots = await client
      .get(`/api/v1/usage/intervals?from=${from}&to=${to}&interval=8h`)
      .bearerToken(token)
    slots.assertStatus(200)
    assert.equal(JSON.stringify(slots.body().data), GOLDEN_INTERVALS)
  })
})

const GOLDEN_USAGE =
  '{"range":null,"period":"day","from":"2026-08-09T16:00:00.000Z","to":"2026-08-11T16:00:00.000Z","scope":"all","timezone":"Asia/Manila","offsetMinutes":480,"source":"hourly","protocolsLimit":2,"buckets":[{"bucketStart":"2026-08-09T16:00:00.000Z","bucketEnd":"2026-08-10T16:00:00.000Z","label":"2026-08-10","partial":false,"seconds":86400,"bytesIn":1500000,"bytesOut":150000,"totalBytes":1650000,"avgMbps":0.000153,"activeDevices":2,"wifiClients":{"avg":12,"max":12,"peakAt":"2026-08-09T18:00:00.000Z"},"protocols":[{"protocol":"youtube","category":"media","bytesIn":900000,"bytesOut":90000,"totalBytes":990000,"percentage":60},{"protocol":"bittorrent","category":"download","bytesIn":500000,"bytesOut":50000,"totalBytes":550000,"percentage":33.3}],"otherProtocols":{"count":1,"bytesIn":100000,"bytesOut":10000,"totalBytes":110000,"percentage":6.7},"categories":[{"category":"media","bytesIn":900000,"bytesOut":90000,"totalBytes":990000,"percentage":60},{"category":"download","bytesIn":500000,"bytesOut":50000,"totalBytes":550000,"percentage":33.3},{"category":"web","bytesIn":100000,"bytesOut":10000,"totalBytes":110000,"percentage":6.7}]},{"bucketStart":"2026-08-10T16:00:00.000Z","bucketEnd":"2026-08-11T16:00:00.000Z","label":"2026-08-11","partial":false,"seconds":86400,"bytesIn":9000000,"bytesOut":900000,"totalBytes":9900000,"avgMbps":0.000917,"activeDevices":2,"wifiClients":{"avg":null,"max":null,"peakAt":null},"protocols":[{"protocol":"dns","category":"network","bytesIn":1000,"bytesOut":100,"totalBytes":1100,"percentage":100}],"otherProtocols":null,"categories":[{"category":"network","bytesIn":1000,"bytesOut":100,"totalBytes":1100,"percentage":100}]}],"totals":{"seconds":172800,"bytesIn":10500000,"bytesOut":1050000,"totalBytes":11550000,"avgMbps":0.000535,"activeDevices":2,"wifiClients":{"avg":12,"max":12,"peakAt":"2026-08-09T18:00:00.000Z"},"protocols":[{"protocol":"youtube","category":"media","bytesIn":900000,"bytesOut":90000,"totalBytes":990000,"percentage":60},{"protocol":"bittorrent","category":"download","bytesIn":500000,"bytesOut":50000,"totalBytes":550000,"percentage":33.3}],"otherProtocols":{"count":2,"bytesIn":101000,"bytesOut":10100,"totalBytes":111100,"percentage":6.7},"categories":[{"category":"media","bytesIn":900000,"bytesOut":90000,"totalBytes":990000,"percentage":60},{"category":"download","bytesIn":500000,"bytesOut":50000,"totalBytes":550000,"percentage":33.3},{"category":"web","bytesIn":100000,"bytesOut":10000,"totalBytes":110000,"percentage":6.7},{"category":"network","bytesIn":1000,"bytesOut":100,"totalBytes":1100,"percentage":0.1}]}}'
const GOLDEN_INTERVALS =
  '{"range":null,"interval":"8h","from":"2026-08-09T16:00:00.000Z","to":"2026-08-11T16:00:00.000Z","scope":"all","timezone":"Asia/Manila","offsetMinutes":480,"intervalSeconds":28800,"buckets":[{"bucketStart":"2026-08-09T16:00:00.000Z","bucketEnd":"2026-08-10T00:00:00.000Z","partial":false,"seconds":28800,"bytesIn":0,"bytesOut":0,"totalBytes":0,"avgMbps":0,"activeDevices":0},{"bucketStart":"2026-08-10T00:00:00.000Z","bucketEnd":"2026-08-10T08:00:00.000Z","partial":false,"seconds":28800,"bytesIn":0,"bytesOut":0,"totalBytes":0,"avgMbps":0,"activeDevices":0},{"bucketStart":"2026-08-10T08:00:00.000Z","bucketEnd":"2026-08-10T16:00:00.000Z","partial":false,"seconds":28800,"bytesIn":1500000,"bytesOut":150000,"totalBytes":1650000,"avgMbps":0.000458,"activeDevices":2},{"bucketStart":"2026-08-10T16:00:00.000Z","bucketEnd":"2026-08-11T00:00:00.000Z","partial":false,"seconds":28800,"bytesIn":9000000,"bytesOut":900000,"totalBytes":9900000,"avgMbps":0.00275,"activeDevices":2},{"bucketStart":"2026-08-11T00:00:00.000Z","bucketEnd":"2026-08-11T08:00:00.000Z","partial":false,"seconds":28800,"bytesIn":0,"bytesOut":0,"totalBytes":0,"avgMbps":0,"activeDevices":0},{"bucketStart":"2026-08-11T08:00:00.000Z","bucketEnd":"2026-08-11T16:00:00.000Z","partial":false,"seconds":28800,"bytesIn":0,"bytesOut":0,"totalBytes":0,"avgMbps":0,"activeDevices":0}]}'
