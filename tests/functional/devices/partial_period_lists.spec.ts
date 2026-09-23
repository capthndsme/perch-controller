import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import { writeDestinationBuckets, writeServiceBuckets } from '#services/bucket_writer'
import { _resetQueryCache } from '#services/query_cache'
import { coveredFrom } from '#services/rollup_tiers'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

/**
 * Window totals read from hour rows (and 5-minute slots) used to start at
 * the first row whose start was inside the window (`hour_start >= from`):
 * a "last hour" list read only the minutes since the top of the hour, and
 * nothing at all right after it. They now start at the row that holds the
 * window start and say so in `coveredFrom`.
 */

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  _resetQueryCache()
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
    lastStatus: null,
  })
  return { token: token.value!.release(), collectorId: collector.id }
}

const MAC = 'aa:aa:aa:aa:aa:01'
const fmt = (t: DateTime) => t.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')

test.group('coveredFrom', () => {
  test('floors to the row that holds the start', ({ assert }) => {
    const t = DateTime.fromISO('2026-09-23T10:37:12Z', { zone: 'utc' })
    assert.equal(coveredFrom(t, 3600).toISO(), '2026-09-23T10:00:00.000Z')
    assert.equal(coveredFrom(t, 300).toISO(), '2026-09-23T10:35:00.000Z')
    const aligned = DateTime.fromISO('2026-09-23T10:00:00Z', { zone: 'utc' })
    assert.equal(coveredFrom(aligned, 3600).toISO(), aligned.toISO())
  })
})

test.group('lists | the partial first period counts', (group) => {
  group.each.setup(resetDb)

  // A window from 10:30 to 11:00, two hours back: its hour row starts at
  // 10:00, before the window, and was left out.
  const hour = DateTime.utc().startOf('hour').minus({ hours: 2 })
  const from = hour.plus({ minutes: 30 })
  const to = hour.plus({ minutes: 60 })

  test('destinations: the hour that holds the window start', async ({ client, assert }) => {
    const { token, collectorId } = await bootstrap()
    await writeDestinationBuckets(collectorId, hour.plus({ minutes: 40 }), [
      {
        mac: MAC,
        serverName: 'video.example.com',
        protocol: 'https',
        category: 'media',
        bytesIn: 1_000_000,
        bytesOut: 10_000,
        packetsIn: 100,
        packetsOut: 10,
      },
    ])
    const r = await client
      .get(`/api/v1/destinations?from=${from.toISO()}&to=${to.toISO()}`)
      .bearerToken(token)
    r.assertStatus(200)
    const body = r.body().data
    assert.equal(body.coveredFrom, hour.toISO())
    assert.equal(body.totalBytesIn, 1_000_000)
    assert.equal(body.destinations[0].serverName, 'video.example.com')
  })

  test('services: the 5-minute slot that holds the start for a short window', async ({
    client,
    assert,
  }) => {
    const { token, collectorId } = await bootstrap()
    const delta = (bytesServed: number) => [
      {
        mac: MAC,
        serverName: 'photos.example',
        protocol: 'https',
        bytesServed,
        bytesReceived: 0,
        packetsServed: 1,
        packetsReceived: 0,
      },
    ]
    // 10:20 (before the window, same hour), 10:32 (the slot that holds the
    // start), 10:50 (inside).
    await writeServiceBuckets(collectorId, hour.plus({ minutes: 20 }), delta(7_000))
    await writeServiceBuckets(collectorId, hour.plus({ minutes: 32 }), delta(3_000))
    await writeServiceBuckets(collectorId, hour.plus({ minutes: 50 }), delta(5_000))
    const windowFrom = hour.plus({ minutes: 33 })
    const r = await client
      .get(`/api/v1/services?from=${windowFrom.toISO()}&to=${to.toISO()}`)
      .bearerToken(token)
    r.assertStatus(200)
    const body = r.body().data
    assert.equal(body.coveredFrom, hour.plus({ minutes: 30 }).toISO())
    // Not the hour row (15 000, which reaches back to 10:20), not nothing.
    assert.equal(body.totalBytesServed, 8_000)

    const device = await client
      .get(`/api/v1/devices/${MAC}/services?from=${windowFrom.toISO()}&to=${to.toISO()}`)
      .bearerToken(token)
    device.assertStatus(200)
    assert.equal(device.body().data.totalBytesServed, 8_000)
  })

  // LAN scope: no ASN lookups in a test.
  test('peers: the hour that holds the start, ties by address', async ({ client, assert }) => {
    const { token, collectorId } = await bootstrap()
    const peer = (peerIp: string, bytesIn: number) => ({
      collector_id: collectorId,
      mac: MAC,
      scope: 'lan',
      peer_ip: peerIp,
      hour_start: fmt(hour),
      bytes_in: bytesIn,
      bytes_out: 0,
      updated_at: fmt(DateTime.utc()),
    })
    await db
      .insertQuery()
      .table('device_peer_buckets_hourly')
      .multiInsert([peer('192.168.1.9', 500), peer('192.168.1.2', 500), peer('192.168.1.5', 900)])
    const r = await client
      .get(`/api/v1/peers/top?scope=lan&from=${from.toISO()}&to=${to.toISO()}`)
      .bearerToken(token)
    r.assertStatus(200)
    const body = r.body().data
    assert.equal(body.coveredFrom, hour.toISO())
    assert.deepEqual(
      body.peers.map((p: { peerIp: string }) => p.peerIp),
      ['192.168.1.5', '192.168.1.2', '192.168.1.9']
    )
  })
})
