import Collector from '#models/collector'
import {
  assertMergeRegistryMatchesSchema,
  CollectorMergeError,
  mergeTables,
  planCollectorMerge,
  rebuildWindows,
} from '#services/collector_merge'
import { backfillRollups, ROLLUP_SPECS } from '#services/rollup_maintainer'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

const MAC_A = '02:00:00:00:00:0a'
const MAC_B = '02:00:00:00:00:0b'
const MAC_C = '02:00:00:00:00:0c'

/** A UTC day two days back: inside every retention window, never the open day. */
const DAY = DateTime.utc().minus({ days: 2 }).startOf('day')
const NOW_SQL = sqlTs(DateTime.utc())

function at(hour: number, minute: number, second = 0, dayOffset = 0): DateTime {
  return DAY.plus({ days: dayOffset, hours: hour, minutes: minute, seconds: second })
}

function sqlTs(dt: DateTime): string {
  return dt.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
}

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

function rows<T>(result: unknown): T[] {
  return ((Array.isArray(result) ? result[0] : result) ?? []) as T[]
}

async function makeCollector(fields: Partial<Collector>): Promise<Collector> {
  return Collector.create({
    pollIntervalSeconds: 5,
    enabled: true,
    lifecycle: 'adopted',
    source: 'manual',
    ...fields,
  } as Partial<Collector>)
}

/**
 * One poll's worth of traffic, written the way the poller does: a 5 s row in
 * the traffic table, and an upsert into the minute's row in the protocol
 * table (PROTOCOL_NATIVE_GRAIN_SECONDS).
 */
async function bucket(collectorId: number, mac: string, when: DateTime, bytesIn: number) {
  await db.table('device_traffic_buckets').insert({
    collector_id: collectorId,
    mac,
    bucket_start: sqlTs(when),
    bytes_in: bytesIn,
    bytes_out: 1,
    packets_in: 1,
    packets_out: 1,
    bytes_in_wan: bytesIn,
    created_at: NOW_SQL,
  })
  await db.rawQuery(
    `INSERT INTO device_protocol_buckets
       (collector_id, mac, protocol, bucket_start, bytes_in, bytes_out, packets_in, packets_out,
        created_at, updated_at)
     VALUES (?, ?, 'tls', ?, ?, 1, 1, 1, ?, ?)
     ON DUPLICATE KEY UPDATE bytes_in = bytes_in + VALUES(bytes_in),
       bytes_out = bytes_out + VALUES(bytes_out), packets_in = packets_in + VALUES(packets_in),
       packets_out = packets_out + VALUES(packets_out)`,
    [collectorId, mac, sqlTs(when.startOf('minute')), bytesIn, NOW_SQL, NOW_SQL]
  )
}

async function protocolBytesIn(collectorId: number, mac: string, minute: DateTime) {
  const row = await db
    .from('device_protocol_buckets')
    .where({ collector_id: collectorId, mac, protocol: 'tls', bucket_start: sqlTs(minute) })
    .first()
  return row ? Number(row.bytes_in) : null
}

/** Builds every collector's own rollups, the state the maintainer leaves behind. */
async function rebuildAll() {
  await backfillRollups(DAY.minus({ days: 45 }), DAY.plus({ days: 2 }))
}

async function isEnabled(collectorId: number): Promise<boolean> {
  const collector = await Collector.findOrFail(collectorId)
  return Boolean(collector.enabled)
}

async function countIn(table: string, collectorId: number): Promise<number> {
  const result = await db.from(table).where('collector_id', collectorId).count('* as total')
  return Number((result[0] as { total: number }).total)
}

async function countsFor(collectorId: number): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const t of mergeTables()) out[t.table] = await countIn(t.table, collectorId)
  return out
}

async function nativeBytesIn(collectorId: number, mac: string, when: DateTime) {
  const row = await db
    .from('device_traffic_buckets')
    .where({ collector_id: collectorId, mac, bucket_start: sqlTs(when) })
    .first()
  return row ? Number(row.bytes_in) : null
}

/**
 * Every traffic and protocol rollup of this collector compared with a fresh
 * aggregate of its source tier, both ways (a missing or wrong row, and a row
 * no source explains). Empty means the merge left exactly what a rebuild
 * from the merged buckets would produce.
 */
async function rollupMismatches(collectorId: number): Promise<string[]> {
  const names = [
    'traffic:native→5m',
    'traffic:5m→hourly',
    'traffic:hourly→daily',
    'protocol:native→5m',
    'protocol:5m→hourly',
    'protocol:hourly→daily',
  ]
  const problems: string[] = []
  for (const name of names) {
    const spec = ROLLUP_SPECS.find((s) => s.name === name)!
    const col = spec.sourceTimeColumn
    const slot = `DATE_SUB(${col}, INTERVAL MOD(TO_SECONDS(${col}), ${spec.grainSeconds}) SECOND)`
    const aggs = Object.keys(spec.aggregates)
    const expected =
      `SELECT ${spec.keys.join(', ')}, ${slot} AS slot, ` +
      `${aggs.map((c) => `${spec.aggregates[c]} AS ${c}`).join(', ')} ` +
      `FROM ${spec.source} WHERE collector_id = ? GROUP BY ${spec.keys.join(', ')}, slot`
    const on = [
      ...spec.keys.map((k) => `a.${k} = e.${k}`),
      `a.${spec.targetTimeColumn} = e.slot`,
      ...aggs.map((c) => `a.${c} = e.${c}`),
    ].join(' AND ')
    const [missing] = rows<{ n: number }>(
      await db.rawQuery(
        `SELECT COUNT(*) AS n FROM (${expected}) e LEFT JOIN ${spec.target} a ON ${on}
          WHERE a.collector_id IS NULL`,
        [collectorId]
      )
    )
    const [extra] = rows<{ n: number }>(
      await db.rawQuery(
        `SELECT COUNT(*) AS n FROM ${spec.target} a LEFT JOIN (${expected}) e ON ${on}
          WHERE a.collector_id = ? AND e.slot IS NULL`,
        [collectorId, collectorId]
      )
    )
    if (Number(missing.n) > 0) problems.push(`${name}: ${missing.n} expected rows missing or wrong`)
    if (Number(extra.n) > 0) problems.push(`${name}: ${extra.n} rows no source explains`)
  }
  return problems
}

async function merge(args: string[]) {
  const ace = await app.container.make('ace')
  return ace.exec('collectors:merge', args)
}

/**
 * Two collectors that ran side by side from 08:00 to 10:00 on DAY: the same
 * device every 10 minutes on both, plus one peer-hour collision. The old box
 * also saw MAC_C, so it has more rows and keeps its row id.
 */
async function seedSideBySide() {
  const old = await makeCollector({ name: 'old-box', baseUrl: 'http://192.168.1.10:9800' })
  const gw = await makeCollector({
    name: 'gateway',
    baseUrl: 'http://192.168.1.1:9800',
    source: 'announced',
    instanceId: 'gw-side-by-side',
  })
  for (let minute = 0; minute <= 120; minute += 10) {
    await bucket(old.id, MAC_A, at(8, minute), 100)
    await bucket(gw.id, MAC_A, at(8, minute), 60)
  }
  await bucket(old.id, MAC_C, at(9, 0, 5), 500)
  await bucket(old.id, MAC_C, at(9, 0, 10), 500)
  await db
    .table('device_peer_buckets_hourly')
    .insert([
      peerRow(old.id, MAC_A, '203.0.113.5', at(8, 0), 1000),
      peerRow(gw.id, MAC_A, '203.0.113.5', at(8, 0), 600),
    ])
  await rebuildAll()
  return { old, gw }
}

function peerRow(collectorId: number, mac: string, peer: string, hour: DateTime, bytesIn: number) {
  return {
    collector_id: collectorId,
    mac,
    scope: 'wan',
    peer_ip: peer,
    hour_start: sqlTs(hour),
    bytes_in: bytesIn,
    bytes_out: bytesIn / 10,
    updated_at: NOW_SQL,
  }
}

async function peerBytesIn(collectorId: number, mac: string, peer: string, hour: DateTime) {
  const row = await db
    .from('device_peer_buckets_hourly')
    .where({ collector_id: collectorId, mac, scope: 'wan', peer_ip: peer, hour_start: sqlTs(hour) })
    .first()
  return row ? Number(row.bytes_in) : null
}

test.group('collectors:merge', (group) => {
  group.each.setup(resetDb)

  test('hand-over: the bigger old row stays, takes the new identity, and reads as one history', async ({
    assert,
  }) => {
    const oldCreatedAt = DateTime.utc().minus({ days: 100 }).startOf('second')
    const old = await makeCollector({
      name: 'old-box',
      baseUrl: 'http://192.168.1.10:9800',
      source: 'env',
      createdAt: oldCreatedAt,
    })
    const gw = await makeCollector({
      name: 'gateway',
      baseUrl: 'http://192.168.1.1:9800',
      source: 'announced',
      instanceId: 'gw-instance-0001',
      hostname: 'OpenWrt',
      version: '1.2.3',
      captureInterface: 'lan0',
      apiKey: 'gateway-key-123456',
      apiKeyFingerprint: 'abcd1234',
    })

    // The old box: MAC_A from 10:00, MAC_C once, last bucket 10:18:15.
    for (let i = 0; i < 12; i++) await bucket(old.id, MAC_A, at(10, 0, i * 5), 100)
    await bucket(old.id, MAC_C, at(10, 5), 500)
    await bucket(old.id, MAC_A, at(10, 18, 10), 111)
    await bucket(old.id, MAC_A, at(10, 18, 15), 112)
    // The gateway from 10:18:10: a 10 s overlap, two colliding buckets.
    await bucket(gw.id, MAC_A, at(10, 18, 10), 7)
    await bucket(gw.id, MAC_A, at(10, 18, 15), 8)
    await bucket(gw.id, MAC_A, at(10, 18, 20), 9)
    await bucket(gw.id, MAC_B, at(10, 18, 30), 40)

    const hour = sqlTs(at(10, 0))
    const slot = sqlTs(at(10, 15))
    await db
      .table('device_peer_buckets_hourly')
      .insert([
        peerRow(old.id, MAC_A, '203.0.113.5', at(10, 0), 1000),
        peerRow(gw.id, MAC_A, '203.0.113.5', at(10, 0), 30),
        peerRow(gw.id, MAC_B, '203.0.113.6', at(10, 0), 40),
      ])
    const destination = {
      mac: MAC_A,
      server_name: 'example.com',
      peer_ip: '203.0.113.5',
      protocol: 'tls',
      hour_start: hour,
      updated_at: NOW_SQL,
    }
    const unnamed = {
      ...destination,
      server_name: 'example.org',
      peer_ip: '203.0.113.7',
      bytes_out: 1,
      packets_in: 1,
      packets_out: 1,
    }
    await db.table('device_destination_buckets_hourly').insert([
      {
        ...destination,
        collector_id: old.id,
        category: 'web',
        bytes_in: 1000,
        bytes_out: 100,
        packets_in: 10,
        packets_out: 1,
      },
      {
        ...destination,
        collector_id: gw.id,
        category: 'cdn',
        bytes_in: 30,
        bytes_out: 3,
        packets_in: 3,
        packets_out: 1,
      },
      // The target has no category for this one: the old box's must survive.
      { ...unnamed, collector_id: old.id, category: 'video', bytes_in: 10 },
      { ...unnamed, collector_id: gw.id, category: '', bytes_in: 5 },
    ])
    const service = { mac: MAC_A, server_name: 'example.com', protocol: 'tls', updated_at: NOW_SQL }
    for (const [table, column, value] of [
      ['device_service_buckets_5m', 'slot_start', slot],
      ['device_service_buckets_hourly', 'hour_start', hour],
    ] as const) {
      await db.table(table).insert([
        {
          ...service,
          [column]: value,
          collector_id: old.id,
          bytes_served: 200,
          bytes_received: 20,
          packets_served: 2,
          packets_received: 1,
        },
        {
          ...service,
          [column]: value,
          collector_id: gw.id,
          bytes_served: 5,
          bytes_received: 1,
          packets_served: 1,
          packets_received: 1,
        },
      ])
    }
    await db.table('device_top_peers').insert([
      {
        collector_id: old.id,
        mac: MAC_A,
        peer_ip: '203.0.113.5',
        scope: 'wan',
        bytes_in: 5,
        bytes_out: 5,
        updated_at: sqlTs(at(10, 18, 15)),
      },
      {
        collector_id: old.id,
        mac: MAC_A,
        peer_ip: '203.0.113.9',
        scope: 'wan',
        bytes_in: 1,
        bytes_out: 1,
        updated_at: sqlTs(at(10, 18, 15)),
      },
      {
        collector_id: gw.id,
        mac: MAC_A,
        peer_ip: '203.0.113.5',
        scope: 'wan',
        bytes_in: 7,
        bytes_out: 7,
        updated_at: sqlTs(at(10, 18, 30)),
      },
    ])
    await db.table('device_identities').insert([
      {
        collector_id: old.id,
        mac: MAC_A,
        primary_ip: '192.168.1.50',
        ips: '["192.168.1.50"]',
        first_seen_at: sqlTs(at(9, 0)),
        last_seen_at: sqlTs(at(10, 18, 15)),
        created_at: NOW_SQL,
      },
      {
        collector_id: gw.id,
        mac: MAC_A,
        primary_ip: '192.168.1.51',
        ips: '["192.168.1.51"]',
        first_seen_at: sqlTs(at(10, 18, 10)),
        last_seen_at: sqlTs(at(10, 18, 30)),
        created_at: NOW_SQL,
      },
      {
        collector_id: gw.id,
        mac: MAC_B,
        primary_ip: '192.168.1.60',
        ips: '["192.168.1.60"]',
        first_seen_at: sqlTs(at(10, 18, 30)),
        last_seen_at: sqlTs(at(10, 18, 30)),
        created_at: NOW_SQL,
      },
    ])
    await rebuildAll()

    const plan = await planCollectorMerge({ fromId: old.id, intoId: gw.id })
    assert.equal(plan.survivorId, old.id, 'the side with more rows keeps its row')
    assert.equal(plan.policy, 'replace')
    assert.equal(plan.policySource, 'automatic')
    assert.equal(plan.overlap!.seconds, 10)

    const run = await merge([`--from=${old.id}`, `--into=${gw.id}`, '--grace=0'])
    assert.equal(run.exitCode, 0)

    // One collector: the old row id with the gateway's identity.
    const all = await Collector.all()
    assert.lengthOf(all, 1)
    const merged = all[0]
    assert.equal(merged.id, old.id)
    assert.equal(merged.name, 'gateway')
    assert.equal(merged.baseUrl, 'http://192.168.1.1:9800')
    assert.equal(merged.instanceId, 'gw-instance-0001')
    assert.equal(merged.apiKey, 'gateway-key-123456')
    assert.equal(merged.apiKeyFingerprint, 'abcd1234')
    assert.equal(merged.source, 'announced')
    assert.equal(merged.lifecycle, 'adopted')
    assert.equal(merged.hostname, 'OpenWrt')
    assert.equal(merged.version, '1.2.3')
    assert.equal(merged.captureInterface, 'lan0')
    assert.isOk(merged.enabled)
    assert.equal(
      merged.createdAt.toSeconds(),
      oldCreatedAt.toSeconds(),
      'history starts with the old row'
    )

    // Native: in the overlap the gateway's measurement wins; the rest moves.
    assert.equal(await nativeBytesIn(old.id, MAC_A, at(10, 18, 10)), 7)
    assert.equal(await nativeBytesIn(old.id, MAC_A, at(10, 18, 15)), 8)
    assert.equal(await nativeBytesIn(old.id, MAC_A, at(10, 18, 20)), 9)
    assert.equal(await nativeBytesIn(old.id, MAC_B, at(10, 18, 30)), 40)
    assert.equal(await nativeBytesIn(old.id, MAC_A, at(10, 0)), 100)
    assert.equal(await countIn('device_traffic_buckets', old.id), 17)
    // Protocol rows are per minute, so the shared minute adds both collectors'
    // parts of it (111 + 112 from the old box, 7 + 8 + 9 from the gateway).
    assert.equal(await countIn('device_protocol_buckets', old.id), 4)
    assert.equal(await protocolBytesIn(old.id, MAC_A, at(10, 18)), 247)
    assert.equal(await protocolBytesIn(old.id, MAC_A, at(10, 0)), 1200)

    // Every rollup agrees with the merged buckets.
    assert.deepEqual(await rollupMismatches(old.id), [])
    const fiveMin = await db
      .from('device_traffic_buckets_5m')
      .where({ collector_id: old.id, mac: MAC_A, slot_start: slot })
      .first()
    assert.equal(Number(fiveMin.bytes_in), 24)

    // Accumulators add up: each collector recorded its own part of the hour.
    assert.equal(await peerBytesIn(old.id, MAC_A, '203.0.113.5', at(10, 0)), 1030)
    assert.equal(await peerBytesIn(old.id, MAC_B, '203.0.113.6', at(10, 0)), 40)
    const dest = await db
      .from('device_destination_buckets_hourly')
      .where({ collector_id: old.id, mac: MAC_A, server_name: 'example.com' })
      .first()
    assert.equal(Number(dest.bytes_in), 1030)
    assert.equal(Number(dest.packets_in), 13)
    assert.equal(dest.category, 'cdn', 'non-additive columns follow the target')
    const kept = await db
      .from('device_destination_buckets_hourly')
      .where({ collector_id: old.id, mac: MAC_A, server_name: 'example.org' })
      .first()
    assert.equal(kept.category, 'video', "an empty category never blanks the other side's")
    assert.equal(Number(kept.bytes_in), 15)
    for (const table of ['device_service_buckets_5m', 'device_service_buckets_hourly']) {
      const svc = await db.from(table).where({ collector_id: old.id, mac: MAC_A }).first()
      assert.equal(Number(svc.bytes_served), 205, table)
    }

    // The top-peer snapshot takes the target's copy, keeps the rest.
    const peers = await db
      .from('device_top_peers')
      .where({ collector_id: old.id, mac: MAC_A })
      .orderBy('peer_ip')
    assert.deepEqual(
      peers.map((p) => [p.peer_ip, Number(p.bytes_in)]),
      [
        ['203.0.113.5', 7],
        ['203.0.113.9', 1],
      ]
    )

    // Identities: one per device, earliest first seen, newest addresses.
    const identities = await db
      .from('device_identities')
      .where('collector_id', old.id)
      .select(
        'mac',
        'primary_ip',
        db.raw(`DATE_FORMAT(first_seen_at, '%Y-%m-%d %H:%i:%s') AS first_seen`),
        db.raw(`DATE_FORMAT(last_seen_at, '%Y-%m-%d %H:%i:%s') AS last_seen`)
      )
      .orderBy('mac')
    assert.deepEqual(
      identities.map((i) => [i.mac, i.primary_ip, i.first_seen, i.last_seen]),
      [
        [MAC_A, '192.168.1.51', sqlTs(at(9, 0)), sqlTs(at(10, 18, 30))],
        [MAC_B, '192.168.1.60', sqlTs(at(10, 18, 30)), sqlTs(at(10, 18, 30))],
      ]
    )

    // Nothing is left behind under the removed row.
    for (const [table, n] of Object.entries(await countsFor(gw.id))) {
      assert.equal(n, 0, `${table} still has rows of the removed collector`)
    }
  })

  test('when the target has more rows it keeps its own row and the old one is deleted', async ({
    assert,
  }) => {
    const old = await makeCollector({ name: 'old', baseUrl: 'http://192.168.1.10:9800' })
    const gw = await makeCollector({
      name: 'gateway',
      baseUrl: 'http://192.168.1.1:9800',
      source: 'announced',
      instanceId: 'gw-instance-0002',
      enabled: false,
    })
    await bucket(old.id, MAC_A, at(10, 0, 0), 100)
    await bucket(old.id, MAC_A, at(10, 0, 5), 101)
    for (let i = 1; i <= 20; i++) await bucket(gw.id, MAC_A, at(10, 0, i * 5), 50 + i)
    await rebuildAll()

    const run = await merge([`--from=${old.id}`, `--into=${gw.id}`, '--grace=0'])
    assert.equal(run.exitCode, 0)

    assert.isNull(await Collector.find(old.id))
    const merged = await Collector.findOrFail(gw.id)
    assert.equal(merged.name, 'gateway')
    assert.equal(merged.instanceId, 'gw-instance-0002')
    assert.notOk(merged.enabled, 'a disabled target stays disabled')
    assert.equal(await nativeBytesIn(gw.id, MAC_A, at(10, 0, 0)), 100, 'the old bucket moved')
    assert.equal(await nativeBytesIn(gw.id, MAC_A, at(10, 0, 5)), 51, 'the target won the overlap')
    assert.equal(await countIn('device_traffic_buckets', gw.id), 21)
    assert.deepEqual(await rollupMismatches(gw.id), [])
  })

  test('a long side-by-side overlap is refused until --overlap is given; nothing changes', async ({
    assert,
  }) => {
    const { old, gw } = await seedSideBySide()
    const before = { old: await countsFor(old.id), gw: await countsFor(gw.id) }

    const plan = await planCollectorMerge({ fromId: old.id, intoId: gw.id })
    assert.isNull(plan.policy)
    assert.lengthOf(plan.refusals, 1)
    assert.match(plan.refusals[0], /--overlap=into/)

    const run = await merge([`--from=${old.id}`, `--into=${gw.id}`, '--grace=0'])
    assert.equal(run.exitCode, 1)
    assert.deepEqual(await countsFor(old.id), before.old)
    assert.deepEqual(await countsFor(gw.id), before.gw)
    assert.isTrue(await isEnabled(old.id))
    assert.isTrue(await isEnabled(gw.id))
  })

  test("--overlap=into keeps the target's numbers wherever both recorded a slot", async ({
    assert,
  }) => {
    const { old, gw } = await seedSideBySide()

    const run = await merge([`--from=${old.id}`, `--into=${gw.id}`, '--overlap=into', '--grace=0'])
    assert.equal(run.exitCode, 0)

    const merged = await Collector.findOrFail(old.id)
    assert.equal(merged.name, 'gateway')
    assert.isNull(await Collector.find(gw.id))
    assert.equal(await nativeBytesIn(old.id, MAC_A, at(8, 30)), 60)
    assert.equal(await nativeBytesIn(old.id, MAC_C, at(9, 0, 5)), 500, 'uncontested rows stay')
    assert.equal(await peerBytesIn(old.id, MAC_A, '203.0.113.5', at(8, 0)), 600)
    assert.deepEqual(await rollupMismatches(old.id), [])
  })

  test('--overlap=sum adds both collectors where both recorded a slot', async ({ assert }) => {
    const { old, gw } = await seedSideBySide()

    const run = await merge([`--from=${old.id}`, `--into=${gw.id}`, '--overlap=sum', '--grace=0'])
    assert.equal(run.exitCode, 0)

    assert.equal(await nativeBytesIn(old.id, MAC_A, at(8, 30)), 160)
    assert.equal(await peerBytesIn(old.id, MAC_A, '203.0.113.5', at(8, 0)), 1600)
    assert.deepEqual(await rollupMismatches(old.id), [])
  })

  test('a collision older than the native tier keeps the policy value in every rollup', async ({
    assert,
  }) => {
    const old = await makeCollector({ name: 'old', baseUrl: 'http://192.168.1.10:9800' })
    const gw = await makeCollector({ name: 'gateway', baseUrl: 'http://192.168.1.1:9800' })
    // Forty days back only the 5-minute tier remains (native keeps 30), for both.
    const oldSlot = at(8, 0, 0, -40)
    const fiveMin = {
      mac: MAC_A,
      slot_start: sqlTs(oldSlot),
      bytes_out: 1,
      packets_in: 1,
      packets_out: 1,
      updated_at: NOW_SQL,
    }
    await db.table('device_traffic_buckets_5m').insert([
      { ...fiveMin, collector_id: old.id, bytes_in: 100 },
      { ...fiveMin, collector_id: gw.id, bytes_in: 40 },
    ])
    for (let i = 0; i < 6; i++) await bucket(old.id, MAC_A, at(10, 0, i * 5), 100)
    await bucket(gw.id, MAC_A, at(10, 0, 25), 7)
    await bucket(gw.id, MAC_A, at(10, 0, 30), 8)
    await rebuildAll()

    // Both spans now start forty days back, so the overlap is long: say it
    // was a hand-over anyway.
    const refused = await planCollectorMerge({ fromId: old.id, intoId: gw.id })
    assert.lengthOf(refused.refusals, 1)
    const run = await merge([
      `--from=${old.id}`,
      `--into=${gw.id}`,
      '--overlap=replace',
      '--grace=0',
    ])
    assert.equal(run.exitCode, 0)

    const [survivor] = await Collector.all()
    const value = async (table: string, column: string, when: DateTime) => {
      const row = await db
        .from(table)
        .where({ collector_id: survivor.id, mac: MAC_A, [column]: sqlTs(when) })
        .first()
      return row ? Number(row.bytes_in) : null
    }
    assert.equal(await value('device_traffic_buckets_5m', 'slot_start', oldSlot), 140)
    assert.equal(await value('device_traffic_buckets_hourly', 'hour_start', oldSlot), 140)
    assert.equal(
      await value('device_traffic_buckets_daily', 'day_start', DAY.minus({ days: 40 })),
      140
    )
    // Where native still exists, the rebuild is exact: 5 × 100 + 7 + 8.
    assert.equal(await value('device_traffic_buckets_5m', 'slot_start', at(10, 0)), 515)
  })

  test('--dry-run prints the plan and changes nothing', async ({ assert }) => {
    const { old, gw } = await seedSideBySide()
    const before = { old: await countsFor(old.id), gw: await countsFor(gw.id) }

    const run = await merge([`--from=${old.id}`, `--into=${gw.id}`, '--overlap=into', '--dry-run'])
    assert.equal(run.exitCode, 0)
    assert.deepEqual(await countsFor(old.id), before.old)
    assert.deepEqual(await countsFor(gw.id), before.gw)
    assert.isTrue(await isEnabled(old.id))
    assert.isTrue(await isEnabled(gw.id))
    const target = await Collector.findOrFail(gw.id)
    assert.equal(target.name, 'gateway')
  })

  test('invalid requests exit non-zero and change nothing', async ({ assert }) => {
    const old = await makeCollector({ name: 'old', baseUrl: 'http://192.168.1.10:9800' })
    const pending = await makeCollector({
      name: 'new',
      baseUrl: 'http://192.168.1.1:9800',
      lifecycle: 'pending',
      enabled: false,
    })
    await bucket(old.id, MAC_A, at(10, 0), 100)

    for (const args of [
      [],
      [`--from=${old.id}`],
      [`--from=${old.id}`, `--into=${old.id}`],
      [`--from=${old.id}`, '--into=9999'],
      [`--from=${old.id}`, `--into=${pending.id}`],
      [`--from=${old.id}`, `--into=${pending.id}`, '--overlap=maybe'],
    ]) {
      const run = await merge([...args, '--grace=0'])
      assert.equal(run.exitCode, 1, `expected a refusal for ${args.join(' ') || '(no flags)'}`)
    }
    assert.lengthOf(await Collector.all(), 2)
    assert.equal(await countIn('device_traffic_buckets', old.id), 1)
    assert.isTrue(await isEnabled(old.id))
  })

  test('the registry matches the schema, and an unknown child table blocks the merge', async ({
    assert,
  }) => {
    await assertMergeRegistryMatchesSchema()

    await db.rawQuery(
      `CREATE TABLE merge_guard_probe (
         collector_id INT UNSIGNED NOT NULL,
         CONSTRAINT merge_guard_probe_fk FOREIGN KEY (collector_id)
           REFERENCES collectors (id) ON DELETE CASCADE
       )`
    )
    try {
      await assert.rejects(() => assertMergeRegistryMatchesSchema(), CollectorMergeError)
      const old = await makeCollector({ name: 'old', baseUrl: 'http://192.168.1.10:9800' })
      const gw = await makeCollector({ name: 'gateway', baseUrl: 'http://192.168.1.1:9800' })
      const run = await merge([`--from=${old.id}`, `--into=${gw.id}`, '--grace=0'])
      assert.equal(run.exitCode, 1)
      assert.lengthOf(await Collector.all(), 2)
    } finally {
      await db.rawQuery('DROP TABLE merge_guard_probe')
    }
  })

  test('the plan warns when the old collector announces or the target is disabled', async ({
    assert,
  }) => {
    const bundled = await makeCollector({
      name: 'bundled',
      baseUrl: 'http://172.28.0.1:9800',
      source: 'env',
    })
    const router = await makeCollector({
      name: 'router',
      baseUrl: 'http://192.168.1.1:9800',
      source: 'announced',
      instanceId: 'router-0001',
      enabled: false,
    })
    const intoRouter = await planCollectorMerge({
      fromId: bundled.id,
      intoId: router.id,
      collectorUrl: null,
    })
    assert.equal(intoRouter.survivorId, router.id, 'a tie keeps the target row')
    assert.lengthOf(intoRouter.refusals, 0)
    assert.isTrue(intoRouter.warnings.some((w) => w.includes('is disabled')))
    assert.isFalse(intoRouter.warnings.some((w) => w.includes('pending collector')))

    const fromRouter = await planCollectorMerge({
      fromId: router.id,
      intoId: bundled.id,
      collectorUrl: null,
    })
    assert.isTrue(fromRouter.warnings.some((w) => w.includes('pending collector')))
    assert.isFalse(fromRouter.warnings.some((w) => w.includes('is disabled')))
  })

  test('COLLECTOR_URL that would bring the retired collector back blocks the merge', async ({
    assert,
  }) => {
    const bundled = await makeCollector({
      name: 'bundled',
      baseUrl: 'http://172.28.0.1:9800',
      source: 'env',
    })
    const router = await makeCollector({
      name: 'router',
      baseUrl: 'http://192.168.1.1:9800',
      source: 'announced',
      instanceId: 'router-0002',
    })
    const plan = (collectorUrl: string | null) =>
      planCollectorMerge({ fromId: bundled.id, intoId: router.id, collectorUrl })

    const stale = await plan('http://172.28.0.1:9800/')
    assert.lengthOf(stale.refusals, 1)
    assert.include(stale.refusals[0], 'COLLECTOR_URL')
    assert.isNotNull(stale.policy, 'the plan is still shown in full')
    const unset = await plan(null)
    assert.lengthOf(unset.refusals, 0)
    const pointedAtRouter = await plan('http://192.168.1.1:9800')
    assert.lengthOf(pointedAtRouter.refusals, 0)
  })

  test('COLLECTOR_URL that would take over a lone manual collector blocks the merge', async ({
    assert,
  }) => {
    const a = await makeCollector({ name: 'a', baseUrl: 'http://192.168.1.20:9800' })
    const b = await makeCollector({ name: 'b', baseUrl: 'http://192.168.1.21:9800' })
    const lone = await planCollectorMerge({
      fromId: a.id,
      intoId: b.id,
      collectorUrl: 'http://172.28.0.1:9800',
    })
    assert.lengthOf(lone.refusals, 1)
    assert.include(lone.refusals[0], 'manually added')

    // With the bundled collector's own row still there, nothing moves.
    await makeCollector({ name: 'bundled', baseUrl: 'http://172.28.0.1:9800', source: 'env' })
    const withEnvRow = await planCollectorMerge({
      fromId: a.id,
      intoId: b.id,
      collectorUrl: 'http://172.28.0.1:9800',
    })
    assert.lengthOf(withEnvRow.refusals, 0)
  })

  test('rebuild windows stop a grain short of retention, and are not clamped with pruning off', ({
    assert,
  }) => {
    const now = DateTime.fromISO('2026-09-21T12:00:00Z', { zone: 'utc' })
    const start = now.minus({ days: 40 })
    const overlap = { start, end: now.minus({ days: 1 }), seconds: 39 * 86400 }
    const retention = { nativeDays: 30, fiveMinDays: 730, hourlyDays: 730, dailyDays: 1825 }

    const clamped = rebuildWindows(overlap, { now, retention })
    const fiveMin = clamped.find((w) => w.spec === 'traffic:native→5m')!
    assert.equal(fiveMin.since.toISO(), now.minus({ days: 30 }).plus({ minutes: 5 }).toISO())
    assert.equal(fiveMin.until.toISO(), now.minus({ days: 1 }).toISO())
    const hourly = clamped.find((w) => w.spec === 'traffic:5m→hourly')!
    assert.equal(hourly.since.toISO(), start.toISO(), '5-minute rows are kept 730 days')

    const unpruned = rebuildWindows(overlap, { now, retention: null })
    const unclamped = unpruned.find((w) => w.spec === 'traffic:native→5m')!
    assert.equal(unclamped.since.toISO(), start.toISO())
  })
})
