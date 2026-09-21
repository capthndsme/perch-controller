import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import { recomputeClientDistribution } from '#services/client_distribution_rollup'
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

async function ap(name: string): Promise<number> {
  const [id] = await db
    .insertQuery()
    .table('wifi_access_points')
    .insert({
      name,
      friendly_name: name,
      metrics_url: `http://${name}.test:9100/metrics`,
      poll_interval_seconds: 15,
      enabled: 1,
      enable_two_way_commands: 0,
      created_at: DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss'),
      updated_at: DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss'),
    })
    .returning('id')
  return Number(typeof id === 'object' ? (id as { id: number }).id : id)
}

async function station(apId: number, mac: string, band: string, at: DateTime) {
  await db.table('wifi_station_snapshots').insert({
    ap_id: apId,
    mac,
    ifname: 'phy1-ap0',
    ssid: 'Home',
    radio: 'radio0',
    channel: band === '5' ? 36 : 6,
    frequency_mhz: band === '5' ? 5180 : 2437,
    band,
    signal_dbm: -60,
    snr_db: 30,
    tx_rate_kbps: 1000,
    rx_rate_kbps: 1000,
    expected_throughput_kbps: 1000,
    inactive_ms: 500,
    tx_bytes: 1,
    rx_bytes: 1,
    tx_packets: 1,
    rx_packets: 1,
    recorded_at: at.toFormat('yyyy-MM-dd HH:mm:ss'),
  })
}

/**
 * A client that roams between APs (or switches band) inside one slot must be
 * counted once in the history total, even though it is legitimately present
 * in both AP / band parts of that slot.
 */
test.group('wifi clients history | distinct totals', (group) => {
  group.each.setup(resetDb)

  test('rollup and raw paths both report distinct clients per bucket', async ({
    client,
    assert,
  }) => {
    const admin = await User.create({
      fullName: 'Admin',
      email: 'admin@example.com',
      password: 'admin-pass-123',
      role: 'admin',
    })
    const accessToken = await User.accessTokens.create(admin)
    const token = accessToken.value!.release()
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
    const first = await ap('first-floor')
    const second = await ap('second-floor')

    // Slot aligned to 5 minutes, safely in the past: phone A roams between the
    // two APs, phone B switches band on the first AP, phone C sits still.
    const slot = DateTime.utc().minus({ minutes: 20 }).set({ second: 0, millisecond: 0 })
    const slotStart = slot.minus({ minutes: slot.minute % 5 })
    await station(first, 'aa:aa:aa:aa:aa:01', '5', slotStart.plus({ seconds: 30 }))
    await station(second, 'aa:aa:aa:aa:aa:01', '5', slotStart.plus({ seconds: 200 }))
    await station(first, 'aa:aa:aa:aa:aa:02', '2.4', slotStart.plus({ seconds: 30 }))
    await station(first, 'aa:aa:aa:aa:aa:02', '5', slotStart.plus({ seconds: 200 }))
    await station(second, 'aa:aa:aa:aa:aa:03', '5', slotStart.plus({ seconds: 30 }))
    // C also shows up on the first AP five seconds later: same 15 s bucket.
    await station(first, 'aa:aa:aa:aa:aa:03', '5', slotStart.plus({ seconds: 35 }))
    await recomputeClientDistribution({
      since: slotStart.minus({ hours: 1 }),
      until: DateTime.utc(),
    })

    const from = slotStart.toISO()
    const to = slotStart.plus({ minutes: 5 }).toISO()
    const rollup = await client
      .get(`/api/v1/wifi/clients/history?from=${from}&to=${to}&resolution=5m`)
      .bearerToken(token)
    rollup.assertStatus(200)
    const [bucket] = rollup.body().data.buckets
    assert.equal(bucket.total, 3, 'three distinct phones, not five part-counts')
    assert.equal(bucket.aps['first-floor'], 4, 'parts stay as they are: A, B(2.4), B(5), C')
    assert.equal(bucket.aps['second-floor'], 2)

    const raw = await client
      .get(`/api/v1/wifi/clients/history?from=${from}&to=${to}&resolution=15s`)
      .bearerToken(token)
    raw.assertStatus(200)
    const totals = raw.body().data.buckets.map((b: { total: number }) => b.total)
    assert.deepEqual(
      totals,
      [3, 2],
      'first bucket: A, B, C once each (C is on both APs); second: A and B'
    )

    const perAp = await client
      .get(`/api/v1/wifi/clients/history?from=${from}&to=${to}&resolution=5m&apId=${first}`)
      .bearerToken(token)
    perAp.assertStatus(200)
    assert.equal(perAp.body().data.buckets[0].total, 3, 'A, B and C on the first AP, B once')
  })
})
