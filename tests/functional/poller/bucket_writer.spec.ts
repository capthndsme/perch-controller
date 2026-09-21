import Collector from '#models/collector'
import {
  alignToBucket,
  upsertTopPeers,
  writeBuckets,
  writeProtocolBuckets,
} from '#services/bucket_writer'
import { backfillRollups } from '#services/rollup_maintainer'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

/** Rebuild every rollup tier around `t` (the maintainer does this once a minute). */
async function rollupAround(t: DateTime) {
  await backfillRollups(t.minus({ days: 1 }), t.plus({ days: 1 }))
}

/**
 * Same isolation pattern as `wizard.spec.ts` — truncate at both setup and
 * teardown so cross-file ordering can't leak buckets from a previous test
 * into a new test's "did we write what we expected?" count.
 */
async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
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

test.group('bucket_writer | alignToBucket', () => {
  test('aligns to the nearest interval boundary', ({ assert }) => {
    const ts = DateTime.fromISO('2026-05-25T12:34:47.123Z', { zone: 'utc' })
    const aligned = alignToBucket(ts, 15)
    // Luxon canonicalises UTC offsets as `Z` for the offset zero zone.
    assert.equal(aligned.toUTC().toISO(), '2026-05-25T12:34:45.000Z')
  })

  test('values exactly on a boundary are unchanged (mod-zero)', ({ assert }) => {
    const ts = DateTime.fromISO('2026-05-25T00:00:00.000Z', { zone: 'utc' })
    const aligned = alignToBucket(ts, 60)
    assert.equal(aligned.toUTC().toISO(), '2026-05-25T00:00:00.000Z')
  })

  test('different intervals discretise differently', ({ assert }) => {
    const ts = DateTime.fromISO('2026-05-25T12:34:47.000Z', { zone: 'utc' })
    assert.equal(alignToBucket(ts, 5).toUTC().toISO(), '2026-05-25T12:34:45.000Z')
    assert.equal(alignToBucket(ts, 60).toUTC().toISO(), '2026-05-25T12:34:00.000Z')
    assert.equal(alignToBucket(ts, 300).toUTC().toISO(), '2026-05-25T12:30:00.000Z')
  })

  test('throws on non-positive interval', ({ assert }) => {
    const ts = DateTime.utc()
    assert.throws(() => alignToBucket(ts, 0), /positive/)
    assert.throws(() => alignToBucket(ts, -1), /positive/)
  })
})

test.group('bucket_writer | writeBuckets', (group) => {
  group.each.setup(resetDb)

  test('two writes to the same (collector, mac, bucket_start) SUM via ON DUPLICATE KEY UPDATE', async ({
    assert,
  }) => {
    const collector = await makeCollector()
    const ts = DateTime.fromISO('2026-05-25T12:00:00.000Z', { zone: 'utc' })

    await writeBuckets(collector.id, 15, ts, [
      { mac: 'aa:aa:aa:aa:aa:aa', bytesIn: 100, bytesOut: 200, packetsIn: 1, packetsOut: 2 },
    ])
    // Same bucket boundary, different counters → must SUM, not overwrite.
    await writeBuckets(collector.id, 15, ts.plus({ milliseconds: 50 }), [
      { mac: 'aa:aa:aa:aa:aa:aa', bytesIn: 50, bytesOut: 25, packetsIn: 5, packetsOut: 10 },
    ])

    const rows = await db.from('device_traffic_buckets').select('*')
    assert.equal(rows.length, 1, 'exactly one row should exist (merged)')
    const r = rows[0]
    assert.equal(Number(r.bytes_in), 150)
    assert.equal(Number(r.bytes_out), 225)
    assert.equal(Number(r.packets_in), 6)
    assert.equal(Number(r.packets_out), 12)
  })

  test('zero-delta rows are filtered out before any insert', async ({ assert }) => {
    const collector = await makeCollector()
    const ts = DateTime.utc()

    const written = await writeBuckets(collector.id, 15, ts, [
      { mac: 'aa:aa:aa:aa:aa:aa', bytesIn: 0, bytesOut: 0, packetsIn: 0, packetsOut: 0 },
    ])
    assert.equal(written, 0)
    const rows = await db.from('device_traffic_buckets').select('id')
    assert.equal(rows.length, 0)
  })

  test('multiple distinct (collector, mac, bucket_start) all persist', async ({ assert }) => {
    const collector = await makeCollector()
    const ts = DateTime.fromISO('2026-05-25T12:00:00.000Z', { zone: 'utc' })

    await writeBuckets(collector.id, 15, ts, [
      { mac: 'aa:aa:aa:aa:aa:aa', bytesIn: 100, bytesOut: 0, packetsIn: 1, packetsOut: 0 },
      { mac: 'bb:bb:bb:bb:bb:bb', bytesIn: 0, bytesOut: 100, packetsIn: 0, packetsOut: 1 },
    ])
    await writeBuckets(collector.id, 15, ts.plus({ seconds: 30 }), [
      { mac: 'aa:aa:aa:aa:aa:aa', bytesIn: 200, bytesOut: 0, packetsIn: 2, packetsOut: 0 },
    ])

    const rows = await db
      .from('device_traffic_buckets')
      .select('*')
      .orderBy('bucket_start', 'asc')
      .orderBy('mac', 'asc')
    assert.equal(rows.length, 3, 'two distinct mac in t0 + one in t1 = 3 rows')
  })

  test('maintains the hourly rollup as a SUM of native buckets in the hour', async ({ assert }) => {
    const collector = await makeCollector()
    const t0 = DateTime.fromISO('2026-05-25T12:00:00.000Z', { zone: 'utc' })

    // Two distinct 15 s slots inside the same hour.
    await writeBuckets(collector.id, 15, t0, [
      { mac: 'aa:aa:aa:aa:aa:aa', bytesIn: 100, bytesOut: 10, packetsIn: 1, packetsOut: 1 },
    ])
    await writeBuckets(collector.id, 15, t0.plus({ minutes: 30 }), [
      { mac: 'aa:aa:aa:aa:aa:aa', bytesIn: 50, bytesOut: 5, packetsIn: 2, packetsOut: 2 },
    ])

    const native = await db.from('device_traffic_buckets').select('id')
    assert.equal(native.length, 2, 'two distinct native buckets')

    await rollupAround(t0)
    const hourly = await db.from('device_traffic_buckets_hourly').select('*')
    assert.equal(hourly.length, 1, 'both native buckets collapse into one hour row')
    assert.equal(Number(hourly[0].bytes_in), 150)
    assert.equal(Number(hourly[0].bytes_out), 15)
    assert.equal(Number(hourly[0].packets_in), 3)
    assert.equal(Number(hourly[0].packets_out), 3)
  })

  test('hourly rollup splits buckets that fall in different hours', async ({ assert }) => {
    const collector = await makeCollector()
    const t = DateTime.fromISO('2026-05-25T12:50:00.000Z', { zone: 'utc' })

    await writeBuckets(collector.id, 15, t, [
      { mac: 'aa:aa:aa:aa:aa:aa', bytesIn: 100, bytesOut: 0, packetsIn: 1, packetsOut: 0 },
    ])
    // +20 min crosses into the 13:00 hour.
    await writeBuckets(collector.id, 15, t.plus({ minutes: 20 }), [
      { mac: 'aa:aa:aa:aa:aa:aa', bytesIn: 100, bytesOut: 0, packetsIn: 1, packetsOut: 0 },
    ])

    await rollupAround(t)
    const hourly = await db.from('device_traffic_buckets_hourly').orderBy('hour_start')
    assert.equal(hourly.length, 2, '12:00 and 13:00 are distinct hour rows')
  })

  test('hourly rollup carries the WAN/LAN scope splits', async ({ assert }) => {
    const collector = await makeCollector()
    const t = DateTime.fromISO('2026-05-25T12:00:00.000Z', { zone: 'utc' })

    await writeBuckets(collector.id, 15, t, [
      {
        mac: 'aa:aa:aa:aa:aa:aa',
        bytesIn: 100,
        bytesOut: 80,
        packetsIn: 1,
        packetsOut: 1,
        bytesInWan: 70,
        bytesOutWan: 50,
        bytesInLan: 30,
        bytesOutLan: 30,
      },
    ])

    await rollupAround(t)
    const hourly = await db.from('device_traffic_buckets_hourly').select('*')
    assert.equal(hourly.length, 1)
    assert.equal(Number(hourly[0].bytes_in_wan), 70)
    assert.equal(Number(hourly[0].bytes_out_wan), 50)
    assert.equal(Number(hourly[0].bytes_in_lan), 30)
    assert.equal(Number(hourly[0].bytes_out_lan), 30)
  })

  test('maintains the 5-minute rollup, summing within a slot and splitting across', async ({
    assert,
  }) => {
    const collector = await makeCollector()
    const t0 = DateTime.fromISO('2026-05-25T12:00:00.000Z', { zone: 'utc' })

    // Two native buckets in the same 5-minute slot (12:00 and 12:02).
    await writeBuckets(collector.id, 15, t0, [
      { mac: 'aa:aa:aa:aa:aa:aa', bytesIn: 100, bytesOut: 10, packetsIn: 1, packetsOut: 1 },
    ])
    await writeBuckets(collector.id, 15, t0.plus({ minutes: 2 }), [
      { mac: 'aa:aa:aa:aa:aa:aa', bytesIn: 50, bytesOut: 5, packetsIn: 2, packetsOut: 2 },
    ])

    await rollupAround(t0)
    const oneSlot = await db.from('device_traffic_buckets_5m').select('*')
    assert.equal(oneSlot.length, 1, 'both fall in the 12:00 slot')
    assert.equal(Number(oneSlot[0].bytes_in), 150)
    assert.equal(Number(oneSlot[0].bytes_out), 15)

    // A bucket in the next slot (12:07) creates a second row.
    await writeBuckets(collector.id, 15, t0.plus({ minutes: 7 }), [
      { mac: 'aa:aa:aa:aa:aa:aa', bytesIn: 200, bytesOut: 20, packetsIn: 1, packetsOut: 1 },
    ])
    await rollupAround(t0)
    const twoSlots = await db.from('device_traffic_buckets_5m').orderBy('slot_start')
    assert.equal(twoSlots.length, 2, '12:00 and 12:05 are distinct 5-minute slots')
  })
})

test.group('bucket_writer | writeProtocolBuckets', (group) => {
  group.each.setup(resetDb)

  test('two writes to the same (collector, mac, protocol, bucket_start) SUM', async ({
    assert,
  }) => {
    const collector = await makeCollector()
    const ts = DateTime.fromISO('2026-05-25T12:00:00.000Z', { zone: 'utc' })

    await writeProtocolBuckets(collector.id, 15, ts, [
      {
        mac: 'aa:aa:aa:aa:aa:aa',
        protocol: 'https',
        bytesIn: 100,
        bytesOut: 200,
        packetsIn: 1,
        packetsOut: 2,
      },
    ])
    await writeProtocolBuckets(collector.id, 15, ts.plus({ milliseconds: 50 }), [
      {
        mac: 'aa:aa:aa:aa:aa:aa',
        protocol: 'https',
        bytesIn: 50,
        bytesOut: 25,
        packetsIn: 5,
        packetsOut: 10,
      },
    ])

    const rows = await db.from('device_protocol_buckets').select('*')
    assert.equal(rows.length, 1)
    assert.equal(Number(rows[0].bytes_in), 150)
    assert.equal(Number(rows[0].bytes_out), 225)
  })

  test('distinct protocols produce distinct rows', async ({ assert }) => {
    const collector = await makeCollector()
    const ts = DateTime.utc()

    await writeProtocolBuckets(collector.id, 15, ts, [
      {
        mac: 'aa:aa:aa:aa:aa:aa',
        protocol: 'https',
        bytesIn: 100,
        bytesOut: 0,
        packetsIn: 1,
        packetsOut: 0,
      },
      {
        mac: 'aa:aa:aa:aa:aa:aa',
        protocol: 'dns',
        bytesIn: 0,
        bytesOut: 50,
        packetsIn: 0,
        packetsOut: 1,
      },
    ])

    const rows = await db.from('device_protocol_buckets').select('protocol').orderBy('protocol')
    assert.equal(rows.length, 2)
    assert.deepEqual(
      rows.map((r) => r.protocol),
      ['dns', 'https']
    )
  })

  test('maintains the protocol hourly rollup per (mac, protocol, hour)', async ({ assert }) => {
    const collector = await makeCollector()
    const t0 = DateTime.fromISO('2026-05-25T12:00:00.000Z', { zone: 'utc' })

    await writeProtocolBuckets(collector.id, 15, t0, [
      {
        mac: 'aa:aa:aa:aa:aa:aa',
        protocol: 'https',
        bytesIn: 100,
        bytesOut: 10,
        packetsIn: 1,
        packetsOut: 1,
      },
    ])
    // Same hour, +20 min: more https plus a new protocol.
    await writeProtocolBuckets(collector.id, 15, t0.plus({ minutes: 20 }), [
      {
        mac: 'aa:aa:aa:aa:aa:aa',
        protocol: 'https',
        bytesIn: 50,
        bytesOut: 5,
        packetsIn: 1,
        packetsOut: 1,
      },
      {
        mac: 'aa:aa:aa:aa:aa:aa',
        protocol: 'dns',
        bytesIn: 7,
        bytesOut: 0,
        packetsIn: 1,
        packetsOut: 0,
      },
    ])

    await rollupAround(t0)
    const hourly = await db.from('device_protocol_buckets_hourly').orderBy('protocol')
    assert.equal(hourly.length, 2, 'https + dns in the same hour = 2 rows')
    const https = hourly.find((r) => r.protocol === 'https')
    assert.equal(Number(https?.bytes_in), 150)
    assert.equal(Number(https?.bytes_out), 15)
    const dns = hourly.find((r) => r.protocol === 'dns')
    assert.equal(Number(dns?.bytes_in), 7)
  })
})

test.group('bucket_writer | upsertTopPeers', (group) => {
  group.each.setup(resetDb)

  test('replaces existing peers for the same (collector, mac, scope)', async ({ assert }) => {
    const collector = await makeCollector()
    const mac = 'aa:aa:aa:aa:aa:aa'

    await upsertTopPeers(collector.id, mac, 'wan', [
      { peerIp: '8.8.8.8', bytesIn: 100, bytesOut: 200 },
      { peerIp: '1.1.1.1', bytesIn: 50, bytesOut: 0 },
    ])

    // Second call drops 1.1.1.1 and changes 8.8.8.8's counters; 4.4.4.4 is new.
    await upsertTopPeers(collector.id, mac, 'wan', [
      { peerIp: '8.8.8.8', bytesIn: 999, bytesOut: 999 },
      { peerIp: '4.4.4.4', bytesIn: 1, bytesOut: 1 },
    ])

    const rows = await db
      .from('device_top_peers')
      .where({ collector_id: collector.id, mac, scope: 'wan' })
      .orderBy('peer_ip', 'asc')
    assert.equal(rows.length, 2, '1.1.1.1 must be gone, 4.4.4.4 must be present')
    assert.equal(rows[0].peer_ip, '4.4.4.4')
    assert.equal(rows[1].peer_ip, '8.8.8.8')
    assert.equal(Number(rows[1].bytes_in), 999)
  })

  test('wan and lan scopes are isolated', async ({ assert }) => {
    const collector = await makeCollector()
    const mac = 'aa:aa:aa:aa:aa:aa'

    await upsertTopPeers(collector.id, mac, 'wan', [{ peerIp: '8.8.8.8', bytesIn: 1, bytesOut: 1 }])
    await upsertTopPeers(collector.id, mac, 'lan', [
      { peerIp: '192.168.1.10', bytesIn: 1, bytesOut: 1 },
    ])
    // Replacing wan must NOT touch lan rows.
    await upsertTopPeers(collector.id, mac, 'wan', [])

    const wan = await db
      .from('device_top_peers')
      .where({ collector_id: collector.id, mac, scope: 'wan' })
    const lan = await db
      .from('device_top_peers')
      .where({ collector_id: collector.id, mac, scope: 'lan' })
    assert.equal(wan.length, 0)
    assert.equal(lan.length, 1)
    assert.equal(lan[0].peer_ip, '192.168.1.10')
  })

  test('empty array wipes the scope without inserting', async ({ assert }) => {
    const collector = await makeCollector()
    const mac = 'aa:aa:aa:aa:aa:aa'

    await upsertTopPeers(collector.id, mac, 'wan', [{ peerIp: '8.8.8.8', bytesIn: 1, bytesOut: 1 }])
    await upsertTopPeers(collector.id, mac, 'wan', [])

    const rows = await db.from('device_top_peers').where({ scope: 'wan' })
    assert.equal(rows.length, 0)
  })
})

test.group('bucket_writer | counter-reset guard', (group) => {
  group.each.setup(resetDb)

  test('drops an implausible traffic delta but keeps the plausible ones', async ({ assert }) => {
    const collector = await makeCollector()
    const t = DateTime.fromISO('2026-05-25T12:00:00.000Z', { zone: 'utc' })

    const written = await writeBuckets(collector.id, 15, t, [
      { mac: 'aa:aa:aa:aa:aa:aa', bytesIn: 100, bytesOut: 200, packetsIn: 1, packetsOut: 1 },
      // 6 GB in one bucket — a counter-reset dump, above the 5 GB ceiling.
      {
        mac: 'bb:bb:bb:bb:bb:bb',
        bytesIn: 0,
        bytesOut: 6_000_000_000,
        packetsIn: 1,
        packetsOut: 1,
      },
    ])

    assert.equal(written, 1, 'only the plausible delta is written')
    const native = await db.from('device_traffic_buckets').select('mac')
    assert.equal(native.length, 1)
    assert.equal(native[0].mac, 'aa:aa:aa:aa:aa:aa')
    // The glitch must not leak into the rollups either.
    await rollupAround(t)
    const hourly = await db.from('device_traffic_buckets_hourly').select('mac')
    assert.equal(hourly.length, 1, 'the glitch never reaches the hourly rollup')
    assert.equal(hourly[0].mac, 'aa:aa:aa:aa:aa:aa')
  })

  test('drops an implausible protocol delta', async ({ assert }) => {
    const collector = await makeCollector()
    const t = DateTime.fromISO('2026-05-25T12:00:00.000Z', { zone: 'utc' })

    const written = await writeProtocolBuckets(collector.id, 15, t, [
      {
        mac: 'aa:aa:aa:aa:aa:aa',
        protocol: 'https',
        bytesIn: 10,
        bytesOut: 20,
        packetsIn: 1,
        packetsOut: 1,
      },
      {
        mac: 'aa:aa:aa:aa:aa:aa',
        protocol: 'quic',
        bytesIn: 7_000_000_000,
        bytesOut: 0,
        packetsIn: 1,
        packetsOut: 1,
      },
    ])

    assert.equal(written, 1)
    const rows = await db.from('device_protocol_buckets').select('protocol')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].protocol, 'https')
  })
})
