import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import { writeBuckets } from '#services/bucket_writer'
import { backfillRollups } from '#services/rollup_maintainer'
import { _resetQueryCache } from '#services/query_cache'
import { rebuildWifiLatestTables } from '#services/wifi_bucket_writer'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

async function resetDb() {
  // The query cache is a module-level singleton that survives between tests.
  // Reset it alongside the DB truncate so a cached result from one test (same
  // endpoint + window cache-key) can't leak into the next.
  _resetQueryCache()
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

/**
 * The read API sits behind both `requireSetupComplete` and `auth`.
 * Wizard tests cover the gate; this spec assumes the gate is open and
 * focuses on the SQL/serialisation layer. We satisfy the gate by:
 *   1. creating an admin user (snapshot.adminExists = true)
 *   2. setting site_name (snapshot.hasInstance = true)
 *   3. creating the collector row whose buckets we test against
 *      (snapshot.hasCollector = true → step = 'complete')
 */
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
    pollIntervalSeconds: 15,
    enabled: true,
    apiKey: null,
    lastStatus: { ok: true, checkedAt: DateTime.utc().toISO()! },
  })
  return { token: token.value!.release(), collector }
}

/**
 * "Now" for seeding. The read window is half-open (`bucket_start < until`,
 * with `until` truncated to the second), so a bucket stamped in the *current*
 * second is excluded until the clock ticks. Seed two seconds back so the
 * newest bucket is always inside the window regardless of request timing.
 */
function recentBase(): DateTime {
  return DateTime.utc().minus({ seconds: 2 })
}

/**
 * Seed three (mac, bucket_start) triples for one collector. Bucket
 * timestamps are spaced 15 s apart so a `range=1m` query will see them
 * all and a `range=5s` query will see only the newest two.
 */
async function seedBuckets(collectorId: number, baseTs: DateTime) {
  const fmt = (t: DateTime) => t.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
  const now = fmt(DateTime.utc())
  // Each bucket is split 70/30 WAN/LAN so the `?scope=` filter has a
  // distinguishable signal in addition to the totals. The invariant
  // `bytes_in == bytes_in_wan + bytes_in_lan` (and same for `_out`) holds
  // for every row below.
  await db
    .insertQuery()
    .table('device_traffic_buckets')
    .multiInsert([
      {
        collector_id: collectorId,
        mac: 'aa:aa:aa:aa:aa:aa',
        bucket_start: fmt(baseTs.minus({ seconds: 30 })),
        bytes_in: 100,
        bytes_out: 200,
        packets_in: 1,
        packets_out: 2,
        bytes_in_wan: 70,
        bytes_out_wan: 140,
        packets_in_wan: 1,
        packets_out_wan: 1,
        bytes_in_lan: 30,
        bytes_out_lan: 60,
        packets_in_lan: 0,
        packets_out_lan: 1,
        created_at: now,
        updated_at: now,
      },
      {
        collector_id: collectorId,
        mac: 'aa:aa:aa:aa:aa:aa',
        bucket_start: fmt(baseTs.minus({ seconds: 15 })),
        bytes_in: 500,
        bytes_out: 600,
        packets_in: 5,
        packets_out: 6,
        bytes_in_wan: 350,
        bytes_out_wan: 420,
        packets_in_wan: 3,
        packets_out_wan: 4,
        bytes_in_lan: 150,
        bytes_out_lan: 180,
        packets_in_lan: 2,
        packets_out_lan: 2,
        created_at: now,
        updated_at: now,
      },
      {
        collector_id: collectorId,
        mac: 'aa:aa:aa:aa:aa:aa',
        bucket_start: fmt(baseTs),
        bytes_in: 1_000_000,
        bytes_out: 1_000_000,
        packets_in: 100,
        packets_out: 100,
        bytes_in_wan: 700_000,
        bytes_out_wan: 700_000,
        packets_in_wan: 70,
        packets_out_wan: 70,
        bytes_in_lan: 300_000,
        bytes_out_lan: 300_000,
        packets_in_lan: 30,
        packets_out_lan: 30,
        created_at: now,
        updated_at: now,
      },
      // Different MAC, only one bucket — lets us assert the index returns
      // one row per MAC (latest-per-group semantics).
      {
        collector_id: collectorId,
        mac: 'bb:bb:bb:bb:bb:bb',
        bucket_start: fmt(baseTs),
        bytes_in: 50,
        bytes_out: 60,
        packets_in: 1,
        packets_out: 1,
        bytes_in_wan: 35,
        bytes_out_wan: 42,
        packets_in_wan: 1,
        packets_out_wan: 1,
        bytes_in_lan: 15,
        bytes_out_lan: 18,
        packets_in_lan: 0,
        packets_out_lan: 0,
        created_at: now,
        updated_at: now,
      },
    ])
}

async function seedIdentity(collectorId: number) {
  const now = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')
  await db
    .insertQuery()
    .table('device_identities')
    .multiInsert([
      {
        collector_id: collectorId,
        mac: 'aa:aa:aa:aa:aa:aa',
        primary_ip: '192.168.1.100',
        ips: JSON.stringify(['192.168.1.100', 'fe80::a']),
        first_seen_at: now,
        last_seen_at: now,
        created_at: now,
        updated_at: now,
      },
      {
        collector_id: collectorId,
        mac: 'bb:bb:bb:bb:bb:bb',
        primary_ip: '192.168.1.101',
        ips: JSON.stringify(['192.168.1.101']),
        first_seen_at: now,
        last_seen_at: now,
        created_at: now,
        updated_at: now,
      },
    ])
}

async function seedPeers(collectorId: number) {
  const now = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')
  await db
    .insertQuery()
    .table('device_top_peers')
    .multiInsert([
      {
        collector_id: collectorId,
        mac: 'aa:aa:aa:aa:aa:aa',
        peer_ip: '8.8.8.8',
        scope: 'wan',
        bytes_in: 1000,
        bytes_out: 2000,
        updated_at: now,
      },
      {
        collector_id: collectorId,
        mac: 'aa:aa:aa:aa:aa:aa',
        peer_ip: '1.1.1.1',
        scope: 'wan',
        bytes_in: 500,
        bytes_out: 100,
        updated_at: now,
      },
      {
        collector_id: collectorId,
        mac: 'aa:aa:aa:aa:aa:aa',
        peer_ip: '192.168.1.10',
        scope: 'lan',
        bytes_in: 10000,
        bytes_out: 20000,
        updated_at: now,
      },
    ])
}

async function seedProtocolBuckets(collectorId: number, baseTs: DateTime) {
  const fmt = (t: DateTime) => t.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
  const now = fmt(DateTime.utc())
  await db
    .insertQuery()
    .table('device_protocol_buckets')
    .multiInsert([
      {
        collector_id: collectorId,
        mac: 'aa:aa:aa:aa:aa:aa',
        protocol: 'https',
        bucket_start: fmt(baseTs.minus({ seconds: 30 })),
        bytes_in: 1000,
        bytes_out: 2000,
        packets_in: 10,
        packets_out: 20,
        created_at: now,
        updated_at: now,
      },
      {
        collector_id: collectorId,
        mac: 'aa:aa:aa:aa:aa:aa',
        protocol: 'dns',
        bucket_start: fmt(baseTs.minus({ seconds: 30 })),
        bytes_in: 100,
        bytes_out: 50,
        packets_in: 1,
        packets_out: 1,
        created_at: now,
        updated_at: now,
      },
      {
        collector_id: collectorId,
        mac: 'aa:aa:aa:aa:aa:aa',
        protocol: 'https',
        bucket_start: fmt(baseTs),
        bytes_in: 5000,
        bytes_out: 8000,
        packets_in: 50,
        packets_out: 80,
        created_at: now,
        updated_at: now,
      },
      {
        collector_id: collectorId,
        mac: 'bb:bb:bb:bb:bb:bb',
        protocol: 'smb',
        bucket_start: fmt(baseTs),
        bytes_in: 300,
        bytes_out: 700,
        packets_in: 3,
        packets_out: 7,
        created_at: now,
        updated_at: now,
      },
    ])
}

async function seedAsnCache() {
  const now = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')
  await db
    .insertQuery()
    .table('asn_cache')
    .multiInsert([
      {
        ip_address: '8.8.8.8',
        asn: 15169,
        org: 'Google',
        prefix: '8.8.8.0/24',
        checked_at: now,
        created_at: now,
        updated_at: now,
      },
      {
        ip_address: '1.1.1.1',
        asn: 13335,
        org: 'Cloudflare',
        prefix: '1.1.1.0/24',
        checked_at: now,
        created_at: now,
        updated_at: now,
      },
    ])
}

async function seedWifiContext() {
  const now = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')
  await db
    .insertQuery()
    .table('wifi_access_points')
    .insert({
      name: 'living-room-ap',
      friendly_name: 'Living Room AP',
      metrics_url: 'http://192.168.1.17:9100/metrics',
      poll_interval_seconds: 15,
      enabled: 1,
      enable_two_way_commands: 0,
      ssh_host: null,
      ssh_port: 22,
      ssh_username: null,
      ssh_private_key: null,
      model: 'OpenWrt One',
      openwrt_release: '24.10.0',
      nodename: 'ap-living-room',
      last_seen_at: now,
      last_status: JSON.stringify({ ok: true, checkedAt: DateTime.utc().toISO() }),
      created_at: now,
      updated_at: now,
    })
  const ap = await db.from('wifi_access_points').where('name', 'living-room-ap').firstOrFail()

  await db.insertQuery().table('wifi_station_snapshots').insert({
    ap_id: ap.id,
    mac: 'aa:aa:aa:aa:aa:aa',
    ifname: 'phy1-ap0',
    ssid: 'Home',
    radio: 'radio0',
    channel: 36,
    frequency_mhz: 5180,
    band: '5',
    signal_dbm: -58,
    snr_db: 37,
    tx_rate_kbps: 12000,
    rx_rate_kbps: 9000,
    expected_throughput_kbps: 15000,
    inactive_ms: 200,
    tx_bytes: 10000,
    rx_bytes: 20000,
    tx_packets: 100,
    rx_packets: 200,
    recorded_at: now,
  })
  await rebuildWifiLatestTables()
}

test.group('read API | GET /api/v1/traffic', (group) => {
  group.each.setup(resetDb)

  test('returns aggregate Mbps buckets and summary stats', async ({ client, assert }) => {
    const { token, collector } = await bootstrap()
    await seedBuckets(collector.id, recentBase())

    const r = await client.get('/api/v1/traffic?range=2m&resolution=15s').bearerToken(token)

    r.assertStatus(200)
    const body = r.body().data
    assert.equal(body.resolutionSeconds, 15)
    assert.isAbove(body.buckets.length, 0)
    assert.isNumber(body.summary.bytesIn)
    assert.isNumber(body.summary.bytesOut)
    assert.isNumber(body.summary.latestMbpsIn)
    assert.isNumber(body.summary.latestMbpsOut)
  })
})

test.group('read API | GET /api/v1/devices', (group) => {
  group.each.setup(resetDb)

  test('returns windowed bytes per MAC plus latest-bucket Mbps', async ({ client, assert }) => {
    const { token, collector } = await bootstrap()
    await seedBuckets(collector.id, recentBase())
    await seedIdentity(collector.id)

    // Default range is 1h, so all three buckets for aa:aa fall inside.
    const r = await client.get('/api/v1/devices').bearerToken(token)
    r.assertStatus(200)
    const rows = r.body().data as Array<{
      mac: string
      bytesIn: number
      bytesOut: number
      packetsIn: number
      packetsOut: number
      primaryIp: string
      ips: string[]
      mbpsIn: number
      mbpsOut: number
    }>
    assert.equal(rows.length, 2, 'one row per (collector, MAC) seen in window')
    assert.equal(rows[0].mac, 'aa:aa:aa:aa:aa:aa', 'biggest MAC first')
    assert.isAbove(rows[0].bytesIn + rows[0].bytesOut, rows[1].bytesIn + rows[1].bytesOut)
    // Bytes columns sum across the window so they line up with what
    // /api/v1/protocols reports for the same range.
    assert.equal(rows[0].bytesIn, 100 + 500 + 1_000_000)
    assert.equal(rows[0].bytesOut, 200 + 600 + 1_000_000)
    assert.equal(rows[0].packetsIn, 1 + 5 + 100)
    assert.equal(rows[0].packetsOut, 2 + 6 + 100)
    assert.equal(rows[0].primaryIp, '192.168.1.100')
    assert.deepEqual(rows[0].ips, ['192.168.1.100', 'fe80::a'])
    // Mbps columns stay derived from the latest in-window bucket so the
    // "Down/Up now" badge still reflects a single poll interval.
    assert.equal(rows[0].mbpsIn, (1_000_000 * 8) / 15 / 1_000_000)
    assert.equal(rows[0].mbpsOut, (1_000_000 * 8) / 15 / 1_000_000)
  })

  test('enriches rows with latest wifi context when available', async ({ client, assert }) => {
    const { token, collector } = await bootstrap()
    await seedBuckets(collector.id, recentBase())
    await seedIdentity(collector.id)
    await seedWifiContext()

    const response = await client.get('/api/v1/devices').bearerToken(token)
    response.assertStatus(200)
    const rows = response.body().data as Array<{
      mac: string
      wifi: { connected: boolean; ssid?: string }
    }>
    const wifiRow = rows.find((row) => row.mac === 'aa:aa:aa:aa:aa:aa')
    assert.isDefined(wifiRow)
    assert.isTrue(wifiRow!.wifi.connected)
    assert.equal(wifiRow!.wifi.ssid, 'Home')
  })

  test('narrowing ?range= drops buckets older than the window', async ({ client, assert }) => {
    const { token, collector } = await bootstrap()
    await seedBuckets(collector.id, recentBase())
    await seedIdentity(collector.id)

    // The seed places buckets at -30s, -15s, and 0s. A 20s window
    // should only catch the most recent two for aa:aa, and the single
    // bucket for bb:bb.
    const r = await client.get('/api/v1/devices?range=20s').bearerToken(token)
    r.assertStatus(200)
    const rows = r.body().data as Array<{ mac: string; bytesIn: number; bytesOut: number }>
    const aa = rows.find((row) => row.mac === 'aa:aa:aa:aa:aa:aa')!
    assert.equal(aa.bytesIn, 500 + 1_000_000)
    assert.equal(aa.bytesOut, 600 + 1_000_000)
  })

  test('returns empty array when no buckets fall in the window', async ({ client, assert }) => {
    const { token, collector } = await bootstrap()
    // Seed buckets near "now" but ask for a window in the far past so
    // none of them match — the index should hide devices that haven't
    // transmitted in the selected window rather than fabricate a
    // stale row from outside it.
    await seedBuckets(collector.id, recentBase())

    const past = DateTime.utc().minus({ days: 30 })
    const r = await client
      .get(`/api/v1/devices?from=${past.minus({ hours: 1 }).toISO()}&to=${past.toISO()}`)
      .bearerToken(token)
    r.assertStatus(200)
    assert.lengthOf(r.body().data, 0)
  })

  test('rejects unauthenticated callers with 401', async ({ client }) => {
    await bootstrap() // satisfy the setup gate
    const r = await client.get('/api/v1/devices')
    r.assertStatus(401)
  })

  test('returns 503 while setup is still incomplete (gate sanity)', async ({ client }) => {
    // No bootstrap → snapshot.step == 'admin' → 503 from middleware.
    const r = await client.get('/api/v1/devices')
    r.assertStatus(503)
    r.assertBodyContains({ error: 'setup_required' })
  })
})

test.group('read API | GET /api/v1/devices/:mac/traffic', (group) => {
  group.each.setup(resetDb)

  test('returns buckets in chronological order, filtered by range', async ({ client, assert }) => {
    const { token, collector } = await bootstrap()
    await seedBuckets(collector.id, recentBase())

    const r = await client
      .get('/api/v1/devices/aa:aa:aa:aa:aa:aa/traffic?range=2m&resolution=15s')
      .bearerToken(token)
    r.assertStatus(200)
    const body = r.body().data
    assert.equal(body.mac, 'aa:aa:aa:aa:aa:aa')
    assert.equal(body.resolution, '15s')
    assert.equal(body.resolutionSeconds, 15)
    assert.equal(body.buckets.length, 3, 'all three seeded buckets fall in 2m')
    assert.equal(body.buckets[0].mbpsIn, (100 * 8) / 15 / 1_000_000)

    // Chronological ASC: bytes go 100 → 500 → 1_000_000.
    const series = body.buckets.map((b: { bytesIn: number }) => b.bytesIn)
    assert.deepEqual(series, [100, 500, 1_000_000])
  })

  test('rolls up buckets at requested resolution', async ({ client, assert }) => {
    const { token, collector } = await bootstrap()
    const base = DateTime.utc().startOf('minute').minus({ minutes: 1 }).plus({ seconds: 45 })
    await seedBuckets(collector.id, base)

    const r = await client
      .get('/api/v1/devices/aa:aa:aa:aa:aa:aa/traffic?range=2m&resolution=1m')
      .bearerToken(token)

    r.assertStatus(200)
    const body = r.body().data
    assert.equal(body.resolutionSeconds, 60)
    assert.equal(body.buckets.length, 1)
    assert.equal(body.buckets[0].bytesIn, 1_000_600)
    assert.equal(body.buckets[0].mbpsIn, (1_000_600 * 8) / 60 / 1_000_000)
  })

  test('returns 404 for a MAC that has never been seen', async ({ client }) => {
    const { token } = await bootstrap()
    const r = await client
      .get('/api/v1/devices/ff:ff:ff:ff:ff:fe/traffic?range=24h')
      .bearerToken(token)
    r.assertStatus(404)
    r.assertBodyContains({ error: 'mac_not_found' })
  })

  test('rejects an unknown resolution with 422', async ({ client }) => {
    const { token } = await bootstrap()
    const r = await client
      .get('/api/v1/devices/aa:aa:aa:aa:aa:aa/traffic?resolution=2h')
      .bearerToken(token)
    r.assertStatus(422)
  })

  test('rejects a malformed range with 422', async ({ client }) => {
    const { token } = await bootstrap()
    const r = await client
      .get('/api/v1/devices/aa:aa:aa:aa:aa:aa/traffic?range=potato')
      .bearerToken(token)
    r.assertStatus(422)
  })
})

test.group('read API | GET /api/v1/devices/:mac/overview', (group) => {
  group.each.setup(resetDb)

  test('returns identity, traffic, peers, top ASNs, and protocol breakdown', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    await seedBuckets(collector.id, recentBase())
    await seedProtocolBuckets(collector.id, recentBase())
    await seedIdentity(collector.id)
    await seedPeers(collector.id)
    await seedAsnCache()

    const r = await client
      .get('/api/v1/devices/aa:aa:aa:aa:aa:aa/overview?range=2m&resolution=1m')
      .bearerToken(token)

    r.assertStatus(200)
    const body = r.body().data
    assert.equal(body.identity[0].primaryIp, '192.168.1.100')
    assert.equal(body.traffic.resolutionSeconds, 60)
    assert.equal(body.peers.wan.length, 2)
    assert.equal(body.peers.lan.length, 1)
    assert.equal(body.topAsns[0].org, 'Google')
    assert.equal(body.topAsns[0].asn, 15169)
    assert.isAbove(body.protocols.length, 0)
    assert.equal(body.protocols[0].protocol, 'https')
    assert.isNumber(body.protocols[0].percentage)
  })
})

test.group('read API | GET /api/v1/devices/:mac/protocols', (group) => {
  group.each.setup(resetDb)

  test('returns protocol summary and time series for a MAC', async ({ client, assert }) => {
    const { token, collector } = await bootstrap()
    await seedProtocolBuckets(collector.id, recentBase())
    await seedIdentity(collector.id)

    const r = await client
      .get('/api/v1/devices/aa:aa:aa:aa:aa:aa/protocols?range=2m&resolution=1m')
      .bearerToken(token)

    r.assertStatus(200)
    const body = r.body().data
    assert.equal(body.mac, 'aa:aa:aa:aa:aa:aa')
    assert.equal(body.resolutionSeconds, 60)
    assert.equal(body.protocols.length, 2)
    assert.equal(body.protocols[0].protocol, 'https')
    assert.isAbove(body.protocols[0].percentage, 0)
    assert.isAbove(body.timeSeries.length, 0)
    assert.isObject(body.timeSeries[0].protocols)
    assert.isNumber(body.timeSeries[0].protocols.https.bytesIn)
  })

  test('returns 404 for an unknown MAC', async ({ client }) => {
    const { token } = await bootstrap()
    const r = await client
      .get('/api/v1/devices/ff:ff:ff:ff:ff:fe/protocols?range=1h')
      .bearerToken(token)
    r.assertStatus(404)
  })
})

test.group('read API | GET /api/v1/protocols', (group) => {
  group.each.setup(resetDb)

  test('returns network-wide protocol breakdown', async ({ client, assert }) => {
    const { token, collector } = await bootstrap()
    await seedProtocolBuckets(collector.id, recentBase())

    const r = await client.get('/api/v1/protocols?range=2m&resolution=1m').bearerToken(token)
    r.assertStatus(200)
    const body = r.body().data
    assert.isUndefined(body.mac)
    assert.equal(body.protocols.length, 3)
    const names = body.protocols.map((p: { protocol: string }) => p.protocol)
    assert.includeMembers(names, ['https', 'dns', 'smb'])
  })
})

test.group('read API | GET /api/v1/protocols/:protocol/devices', (group) => {
  group.each.setup(resetDb)

  test('returns top devices for a protocol with remaining devices aggregated', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    const baseTs = recentBase()
    const fmt = (t: DateTime) => t.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
    const now = fmt(DateTime.utc())
    await seedProtocolBuckets(collector.id, baseTs)
    await seedIdentity(collector.id)
    await db
      .insertQuery()
      .table('device_protocol_buckets')
      .insert({
        collector_id: collector.id,
        mac: 'bb:bb:bb:bb:bb:bb',
        protocol: 'https',
        bucket_start: fmt(baseTs),
        bytes_in: 1000,
        bytes_out: 3000,
        packets_in: 10,
        packets_out: 30,
        created_at: now,
        updated_at: now,
      })

    const r = await client
      .get('/api/v1/protocols/https/devices?range=2m&limit=1')
      .bearerToken(token)

    r.assertStatus(200)
    const body = r.body().data
    assert.equal(body.protocol, 'https')
    assert.equal(body.totalBytes, 20_000)
    assert.lengthOf(body.devices, 1)
    assert.equal(body.devices[0].mac, 'aa:aa:aa:aa:aa:aa')
    assert.equal(body.devices[0].primaryIp, '192.168.1.100')
    assert.equal(body.devices[0].percentage, 80)
    assert.equal(body.other.deviceCount, 1)
    assert.equal(body.other.totalBytes, 4000)
    assert.equal(body.other.percentage, 20)
  })
})

test.group('read API | GET /api/v1/devices/:mac/peers', (group) => {
  group.each.setup(resetDb)

  test('returns peers for the requested scope, sorted by total bytes desc', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    await seedBuckets(collector.id, recentBase())
    await seedPeers(collector.id)

    const wan = await client
      .get('/api/v1/devices/aa:aa:aa:aa:aa:aa/peers?scope=wan')
      .bearerToken(token)
    wan.assertStatus(200)
    const wanRows = wan.body().data.peers as Array<{ peerIp: string }>
    assert.equal(wanRows.length, 2)
    assert.equal(wanRows[0].peerIp, '8.8.8.8')

    const lan = await client
      .get('/api/v1/devices/aa:aa:aa:aa:aa:aa/peers?scope=lan')
      .bearerToken(token)
    lan.assertStatus(200)
    const lanRows = lan.body().data.peers as Array<{ peerIp: string }>
    assert.equal(lanRows.length, 1)
    assert.equal(lanRows[0].peerIp, '192.168.1.10')
  })

  test('rejects missing scope with 422', async ({ client }) => {
    const { token } = await bootstrap()
    const r = await client.get('/api/v1/devices/aa:aa:aa:aa:aa:aa/peers').bearerToken(token)
    r.assertStatus(422)
  })

  test('returns 404 for an unknown MAC', async ({ client }) => {
    const { token } = await bootstrap()
    const r = await client
      .get('/api/v1/devices/ff:ff:ff:ff:ff:fe/peers?scope=wan')
      .bearerToken(token)
    r.assertStatus(404)
    r.assertBodyContains({ error: 'mac_not_found' })
  })
})

test.group('read API | scope filter on traffic endpoints', (group) => {
  group.each.setup(resetDb)

  test('aggregate traffic ?scope=wan returns the WAN-only sums', async ({ client, assert }) => {
    const { token, collector } = await bootstrap()
    await seedBuckets(collector.id, recentBase())

    const all = await client
      .get('/api/v1/traffic?range=2m&resolution=15s&scope=all')
      .bearerToken(token)
    const wan = await client
      .get('/api/v1/traffic?range=2m&resolution=15s&scope=wan')
      .bearerToken(token)
    const lan = await client
      .get('/api/v1/traffic?range=2m&resolution=15s&scope=lan')
      .bearerToken(token)

    all.assertStatus(200)
    wan.assertStatus(200)
    lan.assertStatus(200)

    assert.equal(all.body().data.scope, 'all')
    assert.equal(wan.body().data.scope, 'wan')
    assert.equal(lan.body().data.scope, 'lan')

    // Per-bucket WAN+LAN must reconstruct the totals (the seed enforces
    // a 70/30 split per bucket).
    const allBytes = all.body().data.summary.bytesIn
    const wanBytes = wan.body().data.summary.bytesIn
    const lanBytes = lan.body().data.summary.bytesIn
    assert.equal(wanBytes + lanBytes, allBytes, 'wan + lan must equal all (bytesIn)')
    // 70 % WAN: allow no rounding error since the seed uses exact splits.
    assert.equal(wanBytes, Math.round(allBytes * 0.7))
  })

  test('per-device traffic ?scope=lan rolls up only LAN bytes', async ({ client, assert }) => {
    const { token, collector } = await bootstrap()
    await seedBuckets(collector.id, recentBase())

    const r = await client
      .get('/api/v1/devices/aa:aa:aa:aa:aa:aa/traffic?range=2m&resolution=15s&scope=lan')
      .bearerToken(token)
    r.assertStatus(200)

    const buckets = r.body().data.buckets as Array<{ bytesIn: number; bytesOut: number }>
    const seededLanIn = 30 + 150 + 300_000
    const seededLanOut = 60 + 180 + 300_000
    const totalIn = buckets.reduce((sum, b) => sum + b.bytesIn, 0)
    const totalOut = buckets.reduce((sum, b) => sum + b.bytesOut, 0)
    assert.equal(totalIn, seededLanIn)
    assert.equal(totalOut, seededLanOut)
  })

  test('rejects unknown ?scope= values with 422', async ({ client }) => {
    const { token } = await bootstrap()
    const r = await client.get('/api/v1/traffic?scope=internet').bearerToken(token)
    r.assertStatus(422)
  })
})

test.group('read API | hourly rollup routing + guardrails', (group) => {
  group.each.setup(resetDb)

  test('a wide window reads from the hourly rollup, not the native table', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    const mac = 'aa:aa:aa:aa:aa:aa'
    const fmt = (t: DateTime) => t.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
    const hour = DateTime.utc().startOf('hour').minus({ days: 4 })

    // Seed ONLY the rollup (no native row). If the wide-window read still
    // returns this, it must have come from the rollup table.
    await db
      .insertQuery()
      .table('device_traffic_buckets_hourly')
      .insert({
        collector_id: collector.id,
        mac,
        hour_start: fmt(hour),
        bytes_in: 4242,
        bytes_out: 99,
        packets_in: 1,
        packets_out: 1,
        bytes_in_wan: 0,
        bytes_out_wan: 0,
        packets_in_wan: 0,
        packets_out_wan: 0,
        bytes_in_lan: 0,
        bytes_out_lan: 0,
        packets_in_lan: 0,
        packets_out_lan: 0,
        updated_at: fmt(DateTime.utc()),
      })

    const from = DateTime.utc().minus({ days: 7 })
    const to = DateTime.utc()
    const r = await client
      .get(`/api/v1/devices/${mac}/traffic?from=${from.toISO()}&to=${to.toISO()}&resolution=1h`)
      .bearerToken(token)

    r.assertStatus(200)
    const body = r.body().data
    assert.equal(body.resolutionSeconds, 3600)
    assert.equal(body.buckets.length, 1, 'served the single rollup hour')
    assert.equal(body.buckets[0].bytesIn, 4242)
    assert.equal(body.buckets[0].bytesOut, 99)
  })

  test('wide-window sums from the rollup match the per-hour writes', async ({ client, assert }) => {
    const { token, collector } = await bootstrap()
    const mac = 'aa:aa:aa:aa:aa:aa'
    // writeBuckets maintains the rollup. Two native buckets in one hour 5
    // days ago, one bucket in another hour 1 day ago.
    const h1 = DateTime.utc().startOf('hour').minus({ days: 5 })
    const h2 = DateTime.utc().startOf('hour').minus({ days: 1 })
    await writeBuckets(collector.id, 15, h1, [
      { mac, bytesIn: 100, bytesOut: 10, packetsIn: 1, packetsOut: 1 },
    ])
    await writeBuckets(collector.id, 15, h1.plus({ seconds: 15 }), [
      { mac, bytesIn: 50, bytesOut: 5, packetsIn: 1, packetsOut: 1 },
    ])
    await writeBuckets(collector.id, 15, h2, [
      { mac, bytesIn: 200, bytesOut: 20, packetsIn: 2, packetsOut: 2 },
    ])
    await backfillRollups(DateTime.utc().minus({ days: 8 }), DateTime.utc())

    const from = DateTime.utc().minus({ days: 7 })
    const to = DateTime.utc()
    const r = await client
      .get(`/api/v1/devices/${mac}/traffic?from=${from.toISO()}&to=${to.toISO()}&resolution=1h`)
      .bearerToken(token)

    r.assertStatus(200)
    const buckets = r.body().data.buckets as Array<{ bytesIn: number }>
    assert.equal(buckets.length, 2, 'two distinct hour buckets')
    assert.equal(buckets[0].bytesIn, 150, 'hour 1 = 100 + 50')
    assert.equal(buckets[1].bytesIn, 200, 'hour 2')
  })

  test('coarsens too-fine resolution for a wide window and echoes the effective grain', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    await writeBuckets(collector.id, 15, DateTime.utc().startOf('hour').minus({ days: 10 }), [
      { mac: 'aa:aa:aa:aa:aa:aa', bytesIn: 100, bytesOut: 0, packetsIn: 1, packetsOut: 0 },
    ])

    // 28d window asked at 15s would be ~160k points; the server coarsens it.
    const r = await client.get('/api/v1/traffic?range=28d&resolution=15s').bearerToken(token)
    r.assertStatus(200)
    assert.equal(r.body().data.resolution, '1h', 'coarsened 15s -> 1h')
    assert.equal(r.body().data.resolutionSeconds, 3600)
  })

  test('rejects an absurdly large window with 400 window_too_large', async ({ client }) => {
    const { token } = await bootstrap()
    const r = await client.get('/api/v1/traffic?range=999999d&resolution=15s').bearerToken(token)
    r.assertStatus(400)
    r.assertBodyContains({ error: 'window_too_large' })
  })

  test('a multi-day 15m chart is served from the 5-minute rollup', async ({ client, assert }) => {
    const { token, collector } = await bootstrap()
    const mac = 'aa:aa:aa:aa:aa:aa'
    const fmt = (t: DateTime) => t.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
    // Seed ONLY the 5-minute rollup (no native, no hourly) so a hit proves the
    // 15m read routed to the 5m tier (15m regrouped from 5-minute slots).
    const slot = DateTime.utc().startOf('hour').minus({ days: 3 })
    await db
      .insertQuery()
      .table('device_traffic_buckets_5m')
      .insert({
        collector_id: collector.id,
        mac,
        slot_start: fmt(slot),
        bytes_in: 1234,
        bytes_out: 56,
        packets_in: 1,
        packets_out: 1,
        bytes_in_wan: 0,
        bytes_out_wan: 0,
        packets_in_wan: 0,
        packets_out_wan: 0,
        bytes_in_lan: 0,
        bytes_out_lan: 0,
        packets_in_lan: 0,
        packets_out_lan: 0,
        updated_at: fmt(DateTime.utc()),
      })

    const from = DateTime.utc().minus({ days: 5 })
    const to = DateTime.utc()
    const r = await client
      .get(`/api/v1/devices/${mac}/traffic?from=${from.toISO()}&to=${to.toISO()}&resolution=15m`)
      .bearerToken(token)

    r.assertStatus(200)
    const body = r.body().data
    assert.equal(body.resolutionSeconds, 900)
    assert.equal(body.buckets.length, 1, 'one 15-minute bucket from the single 5-minute slot')
    assert.equal(body.buckets[0].bytesIn, 1234)
    assert.equal(body.buckets[0].bytesOut, 56)
  })
})
