import Collector from '#models/collector'
import { writeTopPeersBatch } from '#services/bucket_writer'
import { _resetPollerState, pollOnce } from '#services/collector_poller'
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

const STARTED_AT = '2026-05-25T12:00:00.000Z'
const ACTIVE = 'aa:aa:aa:aa:aa:aa'
const IDLE = 'bb:bb:bb:bb:bb:bb'

type Peer = { ip: string; bytes_in: number; bytes_out: number }

/** A two-device collector payload: one device whose counters move, one idle. */
function payload(active: { bytesIn: number; wan: Peer[]; lan: Peer[] }) {
  return {
    devices: [
      {
        mac: ACTIVE,
        ips: ['192.168.1.100'],
        bytes_in: active.bytesIn,
        bytes_out: 0,
        packets_in: active.bytesIn / 100,
        packets_out: 0,
        top_peers: active.wan,
        top_lan_peers: active.lan,
      },
      {
        mac: IDLE,
        ips: ['192.168.1.101'],
        bytes_in: 5000,
        bytes_out: 5000,
        packets_in: 50,
        packets_out: 50,
        top_peers: [{ ip: '9.9.9.9', bytes_in: 5000, bytes_out: 5000 }],
        top_lan_peers: [],
      },
    ],
  }
}

function fetcherFor(devices: unknown) {
  const map: Record<string, unknown> = {
    '/api/v1/summary': { summary: { started_at: STARTED_AT, total_devices: 2 } },
    '/api/v1/devices': devices,
  }
  return (async (url: Parameters<typeof fetch>[0]) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '')
    return new Response(JSON.stringify(map[path]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

test.group('bucket_writer | writeTopPeersBatch', (group) => {
  group.each.setup(resetDb)

  test('replace=false refreshes counters without deleting absent IPs', async ({ assert }) => {
    const collector = await makeCollector()
    await writeTopPeersBatch(collector.id, [
      {
        mac: ACTIVE,
        scope: 'wan',
        replace: true,
        peers: [
          { peerIp: '8.8.8.8', bytesIn: 1, bytesOut: 1 },
          { peerIp: '1.1.1.1', bytesIn: 1, bytesOut: 1 },
        ],
      },
    ])
    // Same IP set, new counters: the poller sends replace=false.
    await writeTopPeersBatch(collector.id, [
      {
        mac: ACTIVE,
        scope: 'wan',
        replace: false,
        peers: [{ peerIp: '8.8.8.8', bytesIn: 9, bytesOut: 9 }],
      },
    ])
    const rows = await db.from('device_top_peers').orderBy('peer_ip')
    assert.equal(rows.length, 2, 'no DELETE pass when replace=false')
    assert.equal(Number(rows.find((r) => r.peer_ip === '8.8.8.8')!.bytes_in), 9)
  })

  test('replace=true drops IPs that left the heap, per scope', async ({ assert }) => {
    const collector = await makeCollector()
    await writeTopPeersBatch(collector.id, [
      {
        mac: ACTIVE,
        scope: 'wan',
        replace: true,
        peers: [{ peerIp: '8.8.8.8', bytesIn: 1, bytesOut: 1 }],
      },
      {
        mac: ACTIVE,
        scope: 'lan',
        replace: true,
        peers: [{ peerIp: '192.168.1.10', bytesIn: 1, bytesOut: 1 }],
      },
    ])
    await writeTopPeersBatch(collector.id, [
      {
        mac: ACTIVE,
        scope: 'wan',
        replace: true,
        peers: [{ peerIp: '4.4.4.4', bytesIn: 1, bytesOut: 1 }],
      },
    ])
    const wan = await db.from('device_top_peers').where({ scope: 'wan' })
    const lan = await db.from('device_top_peers').where({ scope: 'lan' })
    assert.deepEqual(
      wan.map((r) => r.peer_ip),
      ['4.4.4.4']
    )
    assert.equal(lan.length, 1, 'other scope untouched')
  })
})

test.group('collector_poller | peer history', (group) => {
  group.each.setup(resetDb)
  group.each.setup(() => {
    _resetPollerState()
    return () => _resetPollerState()
  })

  test('second tick writes hourly peer deltas only for peers seen in both snapshots', async ({
    assert,
  }) => {
    const collector = await makeCollector()
    const t0 = DateTime.fromISO('2026-05-25T12:00:00.000Z', { zone: 'utc' })

    await pollOnce(collector, {
      now: () => t0,
      fetcher: fetcherFor(
        payload({
          bytesIn: 1000,
          wan: [
            { ip: '8.8.8.8', bytes_in: 100, bytes_out: 200 },
            { ip: '1.1.1.1', bytes_in: 50, bytes_out: 0 },
          ],
          lan: [{ ip: '192.168.1.10', bytes_in: 10, bytes_out: 10 }],
        })
      ),
    })
    const outcome = await pollOnce(collector, {
      now: () => t0.plus({ seconds: 5 }),
      fetcher: fetcherFor(
        payload({
          bytesIn: 1500,
          wan: [
            { ip: '8.8.8.8', bytes_in: 400, bytes_out: 250 }, // +300 / +50
            { ip: '4.4.4.4', bytes_in: 70, bytes_out: 0 }, // new → baselined, no delta
          ],
          lan: [{ ip: '192.168.1.10', bytes_in: 10, bytes_out: 10 }], // unchanged
        })
      ),
    })

    assert.equal(outcome.status, 'wrote')
    if (outcome.status === 'wrote') {
      assert.equal(outcome.peerBucketsWritten, 1, 'only 8.8.8.8 moved')
      assert.equal(outcome.activeDevices, 1, 'the idle device was skipped')
    }

    const hourly = await db.from('device_peer_buckets_hourly').select('*')
    assert.equal(hourly.length, 1)
    assert.equal(hourly[0].peer_ip, '8.8.8.8')
    assert.equal(hourly[0].scope, 'wan')
    assert.equal(Number(hourly[0].bytes_in), 300)
    assert.equal(Number(hourly[0].bytes_out), 50)
    assert.equal(
      DateTime.fromJSDate(hourly[0].hour_start, { zone: 'utc' }).toISO(),
      '2026-05-25T12:00:00.000Z'
    )

    // Latest mirror: 1.1.1.1 left the WAN heap and is gone, 4.4.4.4 arrived.
    const latestWan = await db
      .from('device_top_peers')
      .where({ mac: ACTIVE, scope: 'wan' })
      .orderBy('peer_ip')
    assert.deepEqual(
      latestWan.map((r) => r.peer_ip),
      ['4.4.4.4', '8.8.8.8']
    )
    assert.equal(Number(latestWan[1].bytes_in), 400)

    // The idle device's latest peers were written on the first tick and left alone.
    const idlePeers = await db.from('device_top_peers').where({ mac: IDLE })
    assert.equal(idlePeers.length, 1)
  })

  test('a peer whose counter went backwards is re-baselined, not written negative', async ({
    assert,
  }) => {
    const collector = await makeCollector()
    const t0 = DateTime.fromISO('2026-05-25T12:00:00.000Z', { zone: 'utc' })
    await pollOnce(collector, {
      now: () => t0,
      fetcher: fetcherFor(
        payload({ bytesIn: 1000, wan: [{ ip: '8.8.8.8', bytes_in: 500, bytes_out: 0 }], lan: [] })
      ),
    })
    await pollOnce(collector, {
      now: () => t0.plus({ seconds: 5 }),
      fetcher: fetcherFor(
        // Evicted and re-admitted with a fresh counter below the old one.
        payload({ bytesIn: 1100, wan: [{ ip: '8.8.8.8', bytes_in: 20, bytes_out: 0 }], lan: [] })
      ),
    })
    const hourly = await db.from('device_peer_buckets_hourly').select('*')
    assert.equal(hourly.length, 0)
  })
})
