import WifiAccessPoint from '#models/wifi_access_point'
import { pruneOldBuckets } from '#services/bucket_retention'
import { backfillRollups } from '#services/rollup_maintainer'
import { writeWifiInterfaceBuckets, type WifiInterfaceDelta } from '#services/wifi_bucket_writer'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

/** Rebuild every rollup tier around `t` (the maintainer does this once a minute). */
async function rollupAround(t: DateTime) {
  await backfillRollups(t.minus({ days: 1 }), t.plus({ days: 1 }))
}

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

async function makeAp() {
  return WifiAccessPoint.create({
    name: 'living-room',
    friendlyName: 'Living Room AP',
    metricsUrl: 'http://192.168.1.17:9100/metrics',
    pollIntervalSeconds: 15,
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

function delta(over: Partial<WifiInterfaceDelta> = {}): WifiInterfaceDelta {
  return {
    ifname: 'wlan0',
    ssid: 'HomeNet',
    radio: 'radio0',
    band: '5g',
    bytesIn: 0,
    bytesOut: 0,
    packetsIn: 0,
    packetsOut: 0,
    errsIn: 0,
    errsOut: 0,
    dropsIn: 0,
    dropsOut: 0,
    ...over,
  }
}

test.group('wifi_bucket_writer | rollup maintenance', (group) => {
  group.each.setup(resetDb)

  test('fans a native write into the 5-minute + hourly rollups, summing counters', async ({
    assert,
  }) => {
    const ap = await makeAp()
    const t0 = DateTime.fromISO('2026-05-25T12:00:00.000Z', { zone: 'utc' })

    // Two native buckets in the same 5-minute slot (12:00 and 12:02).
    await writeWifiInterfaceBuckets(ap.id, 15, t0, [
      delta({ bytesIn: 100, bytesOut: 10, packetsIn: 1, packetsOut: 1, errsIn: 1, dropsIn: 2 }),
    ])
    await writeWifiInterfaceBuckets(ap.id, 15, t0.plus({ minutes: 2 }), [
      delta({ bytesIn: 50, bytesOut: 5, packetsIn: 2, packetsOut: 2, errsIn: 1, dropsIn: 3 }),
    ])

    const native = await db.from('wifi_interface_buckets').select('id')
    assert.equal(native.length, 2, 'two distinct native buckets')

    await rollupAround(t0)
    const fiveMin = await db.from('wifi_interface_buckets_5m').select('*')
    assert.equal(fiveMin.length, 1, 'both native buckets collapse into one 5-minute slot')
    assert.equal(Number(fiveMin[0].bytes_in), 150)
    assert.equal(Number(fiveMin[0].bytes_out), 15)
    assert.equal(Number(fiveMin[0].packets_in), 3)
    assert.equal(Number(fiveMin[0].errs_in), 2)
    assert.equal(Number(fiveMin[0].drops_in), 5)
    assert.equal(fiveMin[0].ssid, 'HomeNet', 'interface attribute carried into the rollup')
    assert.equal(fiveMin[0].band, '5g')

    const hourly = await db.from('wifi_interface_buckets_hourly').select('*')
    assert.equal(hourly.length, 1, 'both native buckets collapse into one hour row')
    assert.equal(Number(hourly[0].bytes_in), 150)
    assert.equal(Number(hourly[0].bytes_out), 15)
  })

  test('splits the rollups across slot and hour boundaries', async ({ assert }) => {
    const ap = await makeAp()
    const t = DateTime.fromISO('2026-05-25T12:50:00.000Z', { zone: 'utc' })

    await writeWifiInterfaceBuckets(ap.id, 15, t, [delta({ bytesIn: 100, packetsIn: 1 })])
    // +20 min crosses into the 13:00 hour (and a new 5-minute slot).
    await writeWifiInterfaceBuckets(ap.id, 15, t.plus({ minutes: 20 }), [
      delta({ bytesIn: 100, packetsIn: 1 }),
    ])

    await rollupAround(t)
    const fiveMin = await db.from('wifi_interface_buckets_5m').orderBy('slot_start')
    assert.equal(fiveMin.length, 2, '12:50 and 13:10 are distinct 5-minute slots')
    const hourly = await db.from('wifi_interface_buckets_hourly').orderBy('hour_start')
    assert.equal(hourly.length, 2, '12:00 and 13:00 are distinct hour rows')
  })

  test('rollup sums equal the native sum exactly', async ({ assert }) => {
    const ap = await makeAp()
    const t0 = DateTime.fromISO('2026-05-25T12:00:00.000Z', { zone: 'utc' })
    for (let i = 0; i < 6; i += 1) {
      await writeWifiInterfaceBuckets(ap.id, 15, t0.plus({ minutes: i * 3 }), [
        delta({ bytesIn: 10 * (i + 1), bytesOut: i + 1, packetsIn: 1, packetsOut: 1 }),
      ])
    }

    await rollupAround(t0)
    const nativeSum = await db.from('wifi_interface_buckets').sum('bytes_in as t').first()
    const hourlySum = await db.from('wifi_interface_buckets_hourly').sum('bytes_in as t').first()
    const fiveMinSum = await db.from('wifi_interface_buckets_5m').sum('bytes_in as t').first()
    assert.equal(Number(hourlySum.t), Number(nativeSum.t), 'hourly == native')
    assert.equal(Number(fiveMinSum.t), Number(nativeSum.t), '5-minute == native')
  })

  test('retention prunes native wifi at 30d but keeps the rollups within 2 years', async ({
    assert,
  }) => {
    const ap = await makeAp()
    const now = DateTime.fromISO('2026-06-14T00:00:00.000Z', { zone: 'utc' })
    await writeWifiInterfaceBuckets(ap.id, 15, now.minus({ days: 40 }), [
      delta({ bytesIn: 99, packetsIn: 1 }),
    ])
    await rollupAround(now.minus({ days: 40 }))

    await pruneOldBuckets(30, { now })

    const native = await db.from('wifi_interface_buckets').select('id')
    const fiveMin = await db.from('wifi_interface_buckets_5m').select('*')
    const hourly = await db.from('wifi_interface_buckets_hourly').select('*')
    assert.equal(native.length, 0, 'native wifi pruned at 30 days')
    assert.equal(fiveMin.length, 1, 'wifi 5-minute rollup retained')
    assert.equal(hourly.length, 1, 'wifi hourly rollup retained')
  })

  test('drops an implausible wifi delta (counter reset) but keeps the plausible ones', async ({
    assert,
  }) => {
    const ap = await makeAp()
    const t0 = DateTime.fromISO('2026-05-25T12:00:00.000Z', { zone: 'utc' })

    const written = await writeWifiInterfaceBuckets(ap.id, 15, t0, [
      delta({ ifname: 'wlan0', bytesIn: 100, bytesOut: 200, packetsIn: 1 }),
      // 6 GB in one bucket — above the 5 GB ceiling.
      delta({ ifname: 'wlan1', bytesOut: 6_000_000_000, packetsIn: 1 }),
    ])

    assert.equal(written, 1, 'only the plausible delta is written')
    const native = await db.from('wifi_interface_buckets').select('ifname')
    assert.equal(native.length, 1)
    assert.equal(native[0].ifname, 'wlan0')
  })
})
