import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import { _resetQueryCache } from '#services/query_cache'
import { _resetRollupPass } from '#services/series_buckets'
import { clampWifiResolution } from '#services/wifi_ap_throughput'
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

async function createAp(name: string, enabled: boolean) {
  const now = fmt(DateTime.utc())
  await db
    .insertQuery()
    .table('wifi_access_points')
    .insert({
      name,
      friendly_name: `${name} (friendly)`,
      metrics_url: `http://${name}.lan:9100/metrics`,
      poll_interval_seconds: 5,
      enabled: enabled ? 1 : 0,
      enable_two_way_commands: 0,
      ssh_port: 22,
      created_at: now,
      updated_at: now,
    })
  const row = await db.from('wifi_access_points').where('name', name).firstOrFail()
  return row.id as number
}

async function insertInterfaceBucket(
  apId: number,
  ifname: string,
  at: DateTime,
  bytesIn: number,
  bytesOut: number
) {
  const now = fmt(DateTime.utc())
  await db
    .insertQuery()
    .table('wifi_interface_buckets')
    .insert({
      ap_id: apId,
      ifname,
      ssid: 'Home',
      radio: ifname.startsWith('phy1') ? 'radio1' : 'radio0',
      band: ifname.startsWith('phy1') ? '5' : '2.4',
      bucket_start: fmt(at),
      bytes_in: bytesIn,
      bytes_out: bytesOut,
      packets_in: 1,
      packets_out: 1,
      errs_in: 0,
      errs_out: 0,
      drops_in: 0,
      drops_out: 0,
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
  await Collector.create({
    name: 'localhost',
    baseUrl: 'http://127.0.0.1:9800',
    pollIntervalSeconds: 5,
    enabled: true,
    apiKey: null,
    lastStatus: null,
  })

  // Two slots, aligned to 5 minutes, well inside the last hour.
  let base = DateTime.utc().minus({ minutes: 25 }).startOf('minute')
  base = base.minus({ minutes: base.minute % 5 })
  const t1 = base
  const t2 = base.plus({ minutes: 5 })

  const busy = await createAp('ap-busy', true)
  const idle = await createAp('ap-idle', true)
  const retired = await createAp('ap-retired', false)
  const ghost = await createAp('ap-ghost', false)

  // The busy AP has two radios in the same slot: they must be summed.
  await insertInterfaceBucket(busy, 'phy0-ap0', t1, 500_000, 1_500_000)
  await insertInterfaceBucket(busy, 'phy1-ap0', t1, 1_000_000, 6_000_000)
  await insertInterfaceBucket(busy, 'phy1-ap0', t2, 200_000, 3_000_000)
  // A disabled AP with history still shows up (it had clients back then).
  await insertInterfaceBucket(retired, 'phy1-ap0', t1, 10_000, 40_000)

  return { token: token.value!.release(), t1, t2, busy, idle, retired, ghost }
}

test.group('wifi | aps/throughput', (group) => {
  group.each.setup(resetDb)

  test('returns per-AP buckets in client terms (download = AP transmit)', async ({
    client,
    assert,
  }) => {
    const ctx = await bootstrap()
    const r = await client
      .get('/api/v1/wifi/aps/throughput?range=1h&resolution=1m')
      .bearerToken(ctx.token)
    r.assertStatus(200)
    const body = r.body().data

    assert.equal(body.resolution, '1m')
    assert.equal(body.resolutionSeconds, 60)
    assert.equal(body.source, 'native')

    // Busiest first, then the disabled-but-historic AP, then the idle one
    // with zero totals. The AP that never had data and is disabled is gone.
    assert.deepEqual(
      body.aps.map((ap: { id: number }) => ap.id),
      [ctx.busy, ctx.retired, ctx.idle]
    )
    const busy = body.aps[0]
    assert.equal(busy.name, 'ap-busy')
    assert.equal(busy.friendlyName, 'ap-busy (friendly)')
    assert.equal(busy.downloadBytes, 1_500_000 + 6_000_000 + 3_000_000)
    assert.equal(busy.uploadBytes, 500_000 + 1_000_000 + 200_000)
    const idle = body.aps[2]
    assert.equal(idle.downloadBytes, 0)
    assert.equal(idle.uploadBytes, 0)

    // Dense: every minute of the hour, every listed AP in each.
    assert.isAtLeast(body.buckets.length, 59)
    for (const bucket of body.buckets) {
      assert.includeMembers(Object.keys(bucket.aps), [
        String(ctx.busy),
        String(ctx.retired),
        String(ctx.idle),
      ])
    }
    const at = (t: DateTime) =>
      body.buckets.find((b: { bucketStart: string }) => b.bucketStart === t.toISO())
    const first = at(ctx.t1)
    assert.equal(first.seconds, 60)
    const busyPoint = first.aps[String(ctx.busy)]
    assert.equal(busyPoint.downloadBytes, 7_500_000, 'both radios summed')
    assert.equal(busyPoint.uploadBytes, 1_500_000)
    assert.closeTo(busyPoint.downloadMbps, (7_500_000 * 8) / 60 / 1e6, 1e-9)
    assert.closeTo(busyPoint.uploadMbps, (1_500_000 * 8) / 60 / 1e6, 1e-9)
    assert.equal(first.aps[String(ctx.retired)].downloadBytes, 40_000)
    assert.equal(first.aps[String(ctx.idle)].downloadBytes, 0, 'a quiet AP reads zero')

    const second = at(ctx.t2)
    assert.equal(second.aps[String(ctx.busy)].downloadBytes, 3_000_000)
    assert.equal(second.aps[String(ctx.retired)].downloadBytes, 0)

    // The quiet minutes between the two are there, as zero.
    assert.equal(at(ctx.t1.plus({ minutes: 2 })).aps[String(ctx.busy)].downloadBytes, 0)
  })

  test('coarsens a too-fine grain over a wide window and echoes it back', async ({
    client,
    assert,
  }) => {
    const ctx = await bootstrap()
    const r = await client
      .get('/api/v1/wifi/aps/throughput?range=30d&resolution=5s')
      .bearerToken(ctx.token)
    r.assertStatus(200)
    const body = r.body().data
    // 30 d under the 1500-point cap: 30-minute buckets at least.
    assert.isAtLeast(body.bucketSeconds, 1800)
    assert.equal(body.resolutionSeconds, body.bucketSeconds)
    assert.isAtMost(body.buckets.length, 1500)
  })

  test('clampWifiResolution keeps a grain that already fits', ({ assert }) => {
    const until = DateTime.utc()
    assert.equal(clampWifiResolution('1m', until.minus({ hours: 1 }), until), '1m')
    assert.equal(clampWifiResolution('5s', until.minus({ hours: 1 }), until), '5s')
    assert.equal(clampWifiResolution('1m', until.minus({ days: 7 }), until), '15m')
  })

  test('rejects an unknown resolution', async ({ client }) => {
    const ctx = await bootstrap()
    const r = await client
      .get('/api/v1/wifi/aps/throughput?range=1h&resolution=2m')
      .bearerToken(ctx.token)
    r.assertStatus(422)
  })
})
