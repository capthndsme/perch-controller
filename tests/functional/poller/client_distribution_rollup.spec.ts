import WifiAccessPoint from '#models/wifi_access_point'
import { recomputeClientDistribution } from '#services/client_distribution_rollup'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

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

type SnapOver = {
  ap_id: number
  mac?: string
  band?: string | null
  inactive_ms?: number | null
  recorded_at: string
}

function snap(over: SnapOver) {
  return {
    mac: 'aa:aa:aa:aa:aa:01',
    ifname: 'wlan0',
    band: '5',
    inactive_ms: 1000,
    ...over,
  }
}

const SINCE = DateTime.fromISO('2026-05-25T11:00:00.000Z', { zone: 'utc' })
const UNTIL = DateTime.fromISO('2026-05-25T13:00:00.000Z', { zone: 'utc' })

test.group('client_distribution_rollup | recompute', (group) => {
  group.each.setup(resetDb)

  test('counts distinct macs per (ap, band, slot), dedup across snapshots', async ({ assert }) => {
    const ap = await makeAp()
    // mac …01 snapshotted 3× inside one 5-min slot → still 1 distinct; …02 once.
    await db
      .table('wifi_station_snapshots')
      .multiInsert([
        snap({ ap_id: ap.id, mac: 'aa:aa:aa:aa:aa:01', recorded_at: '2026-05-25 12:00:00' }),
        snap({ ap_id: ap.id, mac: 'aa:aa:aa:aa:aa:01', recorded_at: '2026-05-25 12:00:30' }),
        snap({ ap_id: ap.id, mac: 'aa:aa:aa:aa:aa:01', recorded_at: '2026-05-25 12:04:00' }),
        snap({ ap_id: ap.id, mac: 'aa:aa:aa:aa:aa:02', recorded_at: '2026-05-25 12:01:00' }),
      ])

    await recomputeClientDistribution({ since: SINCE, until: UNTIL, grains: [300] })

    const rows = await db.from('wifi_client_distribution').where('grain_seconds', 300)
    assert.equal(rows.length, 1, 'one (ap, band, 5-min slot) group')
    assert.equal(
      Number(rows[0].client_count),
      2,
      '2 distinct macs (…01 deduped across 3 snapshots)'
    )
    assert.equal(rows[0].band, '5')
  })

  test('excludes stations past the inactivity threshold', async ({ assert }) => {
    const ap = await makeAp()
    await db.table('wifi_station_snapshots').multiInsert([
      snap({ ap_id: ap.id, mac: 'aa:aa:aa:aa:aa:01', recorded_at: '2026-05-25 12:00:00' }),
      // inactive_ms past 200000 → not an active client.
      snap({
        ap_id: ap.id,
        mac: 'aa:aa:aa:aa:aa:02',
        inactive_ms: 500000,
        recorded_at: '2026-05-25 12:00:00',
      }),
    ])

    await recomputeClientDistribution({ since: SINCE, until: UNTIL, grains: [300] })

    const rows = await db.from('wifi_client_distribution').where('grain_seconds', 300)
    assert.equal(rows.length, 1)
    assert.equal(Number(rows[0].client_count), 1, 'only the active station counts')
  })

  test('stores a null band as empty string', async ({ assert }) => {
    const ap = await makeAp()
    await db
      .table('wifi_station_snapshots')
      .insert(snap({ ap_id: ap.id, band: null, recorded_at: '2026-05-25 12:00:00' }))

    await recomputeClientDistribution({ since: SINCE, until: UNTIL, grains: [300] })

    const rows = await db.from('wifi_client_distribution').where('grain_seconds', 300)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].band, '', 'null band normalized to empty string for the PK')
  })

  test('each grain is an independent exact distinct count (5m vs 1h)', async ({ assert }) => {
    const ap = await makeAp()
    // Two macs in different 5-min slots but the same hour.
    await db
      .table('wifi_station_snapshots')
      .multiInsert([
        snap({ ap_id: ap.id, mac: 'aa:aa:aa:aa:aa:01', recorded_at: '2026-05-25 12:00:00' }),
        snap({ ap_id: ap.id, mac: 'aa:aa:aa:aa:aa:02', recorded_at: '2026-05-25 12:30:00' }),
      ])

    await recomputeClientDistribution({ since: SINCE, until: UNTIL, grains: [300, 3600] })

    const fiveMin = await db
      .from('wifi_client_distribution')
      .where('grain_seconds', 300)
      .orderBy('slot_start')
    assert.equal(fiveMin.length, 2, 'two distinct 5-min slots')
    assert.equal(Number(fiveMin[0].client_count), 1)
    assert.equal(Number(fiveMin[1].client_count), 1)

    const hourly = await db.from('wifi_client_distribution').where('grain_seconds', 3600)
    assert.equal(hourly.length, 1, 'one hour slot')
    assert.equal(
      Number(hourly[0].client_count),
      2,
      '2 distinct in the hour (NOT the sum of 5-min counts — which is also 2 here, but distinct semantics)'
    )
  })

  test('re-running is idempotent (upsert overwrites)', async ({ assert }) => {
    const ap = await makeAp()
    await db
      .table('wifi_station_snapshots')
      .insert(snap({ ap_id: ap.id, recorded_at: '2026-05-25 12:00:00' }))

    await recomputeClientDistribution({ since: SINCE, until: UNTIL, grains: [300] })
    await recomputeClientDistribution({ since: SINCE, until: UNTIL, grains: [300] })

    const rows = await db.from('wifi_client_distribution').where('grain_seconds', 300)
    assert.equal(rows.length, 1, 'no duplicate row on the second run')
    assert.equal(Number(rows[0].client_count), 1)
  })
})
