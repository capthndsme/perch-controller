import Collector from '#models/collector'
import { pruneOldBuckets } from '#services/bucket_retention'
import { writeBuckets, writeProtocolBuckets } from '#services/bucket_writer'
import { backfillRollups } from '#services/rollup_maintainer'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
}

async function makeCollector() {
  return Collector.create({
    name: 'test',
    baseUrl: 'http://127.0.0.1:9800',
    pollIntervalSeconds: 15,
    enabled: true,
    apiKey: null,
    lastStatus: null,
  })
}

const NOW = DateTime.fromISO('2026-06-14T00:00:00.000Z', { zone: 'utc' })

/** Build every rollup tier from whatever native rows the test wrote. */
async function rollupAll() {
  await backfillRollups(NOW.minus({ days: 1000 }), NOW)
}
const MAC_OLD = 'aa:aa:aa:aa:aa:aa'
const MAC_NEW = 'bb:bb:bb:bb:bb:bb'

test.group('bucket_retention | pruneOldBuckets', (group) => {
  group.each.setup(resetDb)

  test('deletes native rows older than the cutoff, keeps newer ones', async ({ assert }) => {
    const collector = await makeCollector()
    await writeBuckets(collector.id, 15, NOW.minus({ days: 40 }), [
      { mac: MAC_OLD, bytesIn: 1, bytesOut: 0, packetsIn: 1, packetsOut: 0 },
    ])
    await writeBuckets(collector.id, 15, NOW.minus({ days: 2 }), [
      { mac: MAC_NEW, bytesIn: 1, bytesOut: 0, packetsIn: 1, packetsOut: 0 },
    ])
    await writeProtocolBuckets(collector.id, 15, NOW.minus({ days: 40 }), [
      { mac: MAC_OLD, protocol: 'https', bytesIn: 1, bytesOut: 0, packetsIn: 1, packetsOut: 0 },
    ])

    const result = await pruneOldBuckets(30, { now: NOW })

    const traffic = await db.from('device_traffic_buckets').select('mac')
    assert.equal(traffic.length, 1, 'only the 2-day-old native row survives')
    assert.equal(traffic[0].mac, MAC_NEW)

    const protocol = await db.from('device_protocol_buckets').select('id')
    assert.equal(protocol.length, 0, 'the 40-day-old protocol row is pruned')

    const trafficResult = result.tables.find((t) => t.table === 'device_traffic_buckets')
    assert.equal(trafficResult?.deleted, 1)
  })

  test('keeps the coarse rollups within their 2-year retention (only native pruned)', async ({
    assert,
  }) => {
    const collector = await makeCollector()
    // 400 days old: past the 30-day native window, but well inside the 2-year
    // rollup window. The fine row goes; the rollups (and their values) stay.
    await writeBuckets(collector.id, 15, NOW.minus({ days: 400 }), [
      { mac: MAC_OLD, bytesIn: 5, bytesOut: 0, packetsIn: 1, packetsOut: 0 },
    ])
    await rollupAll()

    await pruneOldBuckets(30, { now: NOW })

    const native = await db.from('device_traffic_buckets').select('id')
    assert.equal(native.length, 0, 'native row pruned')
    const fiveMin = await db.from('device_traffic_buckets_5m').select('*')
    assert.equal(fiveMin.length, 1, '5-minute rollup retained within 2 years')
    const hourly = await db.from('device_traffic_buckets_hourly').select('*')
    assert.equal(hourly.length, 1, 'hourly rollup retained within 2 years')
    assert.equal(Number(hourly[0].bytes_in), 5, 'rollup value intact after native gone')
  })

  test('prunes the 5-minute and hourly rollups past the 2-year wall', async ({ assert }) => {
    const collector = await makeCollector()
    // 740 days old: past every tier's default horizon, so it is fully erased.
    await writeBuckets(collector.id, 15, NOW.minus({ days: 740 }), [
      { mac: MAC_OLD, bytesIn: 7, bytesOut: 0, packetsIn: 1, packetsOut: 0 },
    ])
    await rollupAll()

    const result = await pruneOldBuckets(30, { now: NOW })

    const native = await db.from('device_traffic_buckets').select('id')
    const fiveMinRows = await db.from('device_traffic_buckets_5m').select('*')
    const hourlyRows = await db.from('device_traffic_buckets_hourly').select('*')
    assert.equal(native.length, 0, 'native gone')
    assert.equal(fiveMinRows.length, 0, '5-minute rollup gone past 2 years')
    assert.equal(hourlyRows.length, 0, 'hourly rollup gone past 2 years')

    const fiveMin = result.tables.find((t) => t.table === 'device_traffic_buckets_5m')
    const hourly = result.tables.find((t) => t.table === 'device_traffic_buckets_hourly')
    assert.equal(fiveMin?.deleted, 1, 'counts the pruned 5-minute row')
    assert.equal(hourly?.deleted, 1, 'counts the pruned hourly row')
  })

  test('honors configurable coarse retentions (and clamps below the native window)', async ({
    assert,
  }) => {
    const collector = await makeCollector()
    // 100 days old: kept by the defaults, but a 90-day coarse horizon erases it.
    await writeBuckets(collector.id, 15, NOW.minus({ days: 100 }), [
      { mac: MAC_OLD, bytesIn: 1, bytesOut: 0, packetsIn: 1, packetsOut: 0 },
    ])
    await rollupAll()

    await pruneOldBuckets(30, {
      now: NOW,
      fiveMinRetentionDays: 90,
      hourlyRetentionDays: 90,
    })

    const fiveMinRows = await db.from('device_traffic_buckets_5m').select('*')
    const hourlyRows = await db.from('device_traffic_buckets_hourly').select('*')
    assert.equal(fiveMinRows.length, 0, '5-minute rollup pruned at the configured 90-day horizon')
    assert.equal(hourlyRows.length, 0, 'hourly rollup pruned at the configured 90-day horizon')
  })

  test('dryRun reports would-be deletions without deleting', async ({ assert }) => {
    const collector = await makeCollector()
    await writeBuckets(collector.id, 15, NOW.minus({ days: 40 }), [
      { mac: MAC_OLD, bytesIn: 1, bytesOut: 0, packetsIn: 1, packetsOut: 0 },
    ])

    const result = await pruneOldBuckets(30, { now: NOW, dryRun: true })
    const trafficResult = result.tables.find((t) => t.table === 'device_traffic_buckets')
    assert.equal(trafficResult?.deleted, 1, 'reports one would-be deletion')

    const native = await db.from('device_traffic_buckets').select('id')
    assert.equal(native.length, 1, 'nothing actually deleted on a dry run')
  })

  test('drains old rows across multiple batches', async ({ assert }) => {
    const collector = await makeCollector()
    for (let i = 0; i < 5; i += 1) {
      await writeBuckets(collector.id, 15, NOW.minus({ days: 40 }).plus({ seconds: i * 15 }), [
        { mac: MAC_OLD, bytesIn: 1, bytesOut: 0, packetsIn: 1, packetsOut: 0 },
      ])
    }
    const before = await db.from('device_traffic_buckets').select('id')
    assert.equal(before.length, 5)

    const result = await pruneOldBuckets(30, { now: NOW, batchSize: 2 })

    const after = await db.from('device_traffic_buckets').select('id')
    assert.equal(after.length, 0)
    const trafficResult = result.tables.find((t) => t.table === 'device_traffic_buckets')
    assert.equal(trafficResult?.deleted, 5, 'all five counted across batches')
  })

  test('refuses a non-positive retention rather than wiping everything', async ({ assert }) => {
    await assert.rejects(() => pruneOldBuckets(0), /retentionDays/)
    await assert.rejects(() => pruneOldBuckets(-5), /retentionDays/)
  })
})
