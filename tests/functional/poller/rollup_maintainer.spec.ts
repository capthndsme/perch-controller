import Collector from '#models/collector'
import WifiAccessPoint from '#models/wifi_access_point'
import { writeBuckets, writeProtocolBuckets } from '#services/bucket_writer'
import { backfillRollups, runAllRollups, ROLLUP_SPECS } from '#services/rollup_maintainer'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

async function makeCollector() {
  return Collector.create({
    name: 'test',
    baseUrl: 'http://127.0.0.1:9800',
    pollIntervalSeconds: 5,
    enabled: true,
    apiKey: null,
    lastStatus: null,
  })
}

async function makeAp() {
  return WifiAccessPoint.create({
    name: 'ap',
    friendlyName: null,
    metricsUrl: 'http://192.168.1.17:9100/metrics',
    pollIntervalSeconds: 5,
    enabled: true,
    enableTwoWayCommands: false,
    sshHost: null,
    sshPort: 22,
    sshUsername: null,
    sshPrivateKey: null,
    model: null,
    openwrtRelease: null,
    nodename: null,
    lastStatus: null,
    lastSeenAt: null,
  })
}

const MAC = 'aa:aa:aa:aa:aa:aa'

test.group('rollup_maintainer | ladder', (group) => {
  group.each.setup(resetDb)

  test('native → 5m → hourly → daily sums stay exact along the chain', async ({ assert }) => {
    const collector = await makeCollector()
    // 23:50 and 00:10 straddle a day boundary: two days, two hours, two slots.
    const t0 = DateTime.fromISO('2026-05-25T23:50:00.000Z', { zone: 'utc' })
    await writeBuckets(collector.id, 5, t0, [
      { mac: MAC, bytesIn: 100, bytesOut: 10, packetsIn: 1, packetsOut: 1, bytesInWan: 60 },
    ])
    await writeBuckets(collector.id, 5, t0.plus({ minutes: 2 }), [
      { mac: MAC, bytesIn: 50, bytesOut: 5, packetsIn: 1, packetsOut: 1, bytesInWan: 40 },
    ])
    await writeBuckets(collector.id, 5, t0.plus({ minutes: 20 }), [
      { mac: MAC, bytesIn: 200, bytesOut: 20, packetsIn: 2, packetsOut: 2 },
    ])

    await backfillRollups(t0.minus({ days: 1 }), t0.plus({ days: 1 }))

    const fiveMin = await db.from('device_traffic_buckets_5m').orderBy('slot_start')
    assert.equal(fiveMin.length, 2, '23:50 slot and 00:10 slot')
    assert.equal(Number(fiveMin[0].bytes_in), 150)
    assert.equal(Number(fiveMin[0].bytes_in_wan), 100, 'scope split carried')
    assert.equal(Number(fiveMin[1].bytes_in), 200)

    const hourly = await db.from('device_traffic_buckets_hourly').orderBy('hour_start')
    assert.equal(hourly.length, 2, '23:00 and 00:00 hour rows')
    assert.equal(Number(hourly[0].bytes_in), 150)
    assert.equal(Number(hourly[1].bytes_in), 200)

    const daily = await db.from('device_traffic_buckets_daily').orderBy('day_start')
    assert.equal(daily.length, 2, 'May 25 and May 26 (UTC days)')
    assert.equal(
      DateTime.fromJSDate(daily[0].day_start, { zone: 'utc' }).toISO(),
      '2026-05-25T00:00:00.000Z'
    )
    assert.equal(Number(daily[0].bytes_in), 150)
    assert.equal(Number(daily[1].bytes_in), 200)
  })

  test('re-running the same window is idempotent (replace, not add)', async ({ assert }) => {
    const collector = await makeCollector()
    const t0 = DateTime.fromISO('2026-05-25T12:00:00.000Z', { zone: 'utc' })
    await writeBuckets(collector.id, 5, t0, [
      { mac: MAC, bytesIn: 100, bytesOut: 10, packetsIn: 1, packetsOut: 1 },
    ])

    await runAllRollups({ now: t0.plus({ minutes: 1 }) })
    await runAllRollups({ now: t0.plus({ minutes: 2 }) })
    await runAllRollups({ now: t0.plus({ minutes: 3 }) })

    const hourly = await db.from('device_traffic_buckets_hourly').select('*')
    assert.equal(hourly.length, 1)
    assert.equal(Number(hourly[0].bytes_in), 100, 'three passes did not triple the sum')
  })

  test('a late native write inside the lookback corrects the open slot', async ({ assert }) => {
    const collector = await makeCollector()
    const t0 = DateTime.fromISO('2026-05-25T12:00:00.000Z', { zone: 'utc' })
    await writeBuckets(collector.id, 5, t0, [
      { mac: MAC, bytesIn: 100, bytesOut: 0, packetsIn: 1, packetsOut: 0 },
    ])
    await runAllRollups({ now: t0.plus({ minutes: 1 }) })

    // Another native bucket lands in the same hour a minute later.
    await writeBuckets(collector.id, 5, t0.plus({ minutes: 1 }), [
      { mac: MAC, bytesIn: 25, bytesOut: 0, packetsIn: 1, packetsOut: 0 },
    ])
    await runAllRollups({ now: t0.plus({ minutes: 2 }) })

    const hourly = await db.from('device_traffic_buckets_hourly').select('*')
    assert.equal(Number(hourly[0].bytes_in), 125)
    const daily = await db.from('device_traffic_buckets_daily').select('*')
    assert.equal(Number(daily[0].bytes_in), 125, 'daily follows the corrected hourly')
  })

  test('protocol buckets store at 1m natively and roll up per (mac, protocol)', async ({
    assert,
  }) => {
    const collector = await makeCollector()
    const t0 = DateTime.fromISO('2026-05-25T12:00:00.000Z', { zone: 'utc' })
    // Three 5 s ticks inside one minute merge into a single native row.
    for (const sec of [0, 5, 10]) {
      await writeProtocolBuckets(collector.id, 5, t0.plus({ seconds: sec }), [
        { mac: MAC, protocol: 'https', bytesIn: 10, bytesOut: 1, packetsIn: 1, packetsOut: 1 },
        { mac: MAC, protocol: 'dns', bytesIn: 1, bytesOut: 1, packetsIn: 1, packetsOut: 1 },
      ])
    }
    const native = await db.from('device_protocol_buckets').orderBy('protocol')
    assert.equal(native.length, 2, 'one 1m row per protocol')
    assert.equal(Number(native.find((r) => r.protocol === 'https')!.bytes_in), 30)

    await backfillRollups(t0.minus({ hours: 1 }), t0.plus({ hours: 1 }))
    const hourly = await db.from('device_protocol_buckets_hourly').orderBy('protocol')
    assert.equal(hourly.length, 2)
    assert.equal(Number(hourly.find((r) => r.protocol === 'https')!.bytes_in), 30)
    assert.equal(Number(hourly.find((r) => r.protocol === 'dns')!.bytes_in), 3)
  })

  test('wifi snapshot streams roll into weighted 5-minute rows', async ({ assert }) => {
    const ap = await makeAp()
    const t0 = DateTime.fromISO('2026-05-25T12:00:00.000Z', { zone: 'utc' })
    const rows = [-50, -60, -70].map((signal, i) => ({
      ap_id: ap.id,
      mac: MAC,
      ifname: 'phy1-ap0',
      ssid: 'Home',
      band: '5',
      signal_dbm: signal,
      snr_db: 30,
      tx_rate_kbps: 1000 * (i + 1),
      rx_rate_kbps: 500,
      inactive_ms: i === 2 ? 300000 : 100,
      recorded_at: t0.plus({ seconds: i * 5 }).toFormat('yyyy-MM-dd HH:mm:ss'),
    }))
    await db.insertQuery().table('wifi_station_snapshots').multiInsert(rows)

    const only = ROLLUP_SPECS.filter((s) => s.name === 'wifi_station:snapshots→5m')
    await backfillRollups(t0.minus({ hours: 1 }), t0.plus({ hours: 1 }), only)

    const slots = await db.from('wifi_station_buckets_5m').select('*')
    assert.equal(slots.length, 1)
    assert.equal(Number(slots[0].samples), 3)
    assert.equal(Number(slots[0].active_samples), 2, 'the 300 s-inactive sample is not active')
    assert.equal(Number(slots[0].avg_signal_dbm), -60)
    assert.equal(Number(slots[0].min_signal_dbm), -70)
    assert.equal(Number(slots[0].max_tx_rate_kbps), 3000)
  })
})
