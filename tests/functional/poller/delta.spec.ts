import Collector from '#models/collector'
import { _resetPollerState, pollOnce } from '#services/collector_poller'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

/**
 * Tiny helper for hand-rolled collector responses. We don't validate
 * the wire shape here — that's the collector's contract — so we hand the
 * poller exactly the fields it destructures.
 */
function makeFetcher(map: Record<string, unknown>) {
  return (async (url: Parameters<typeof fetch>[0]) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '')
    if (map[path] === undefined) {
      throw new Error(`unexpected fetch to ${path}`)
    }
    return new Response(JSON.stringify(map[path]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

const COLLECTOR_STARTED_AT = '2026-05-25T12:00:00.000Z'
const MAC = 'aa:bb:cc:dd:ee:ff'

function summary(opts: { startedAt?: string; totalDevices?: number } = {}) {
  return {
    summary: {
      started_at: opts.startedAt ?? COLLECTOR_STARTED_AT,
      total_devices: opts.totalDevices ?? 1,
    },
    meta: { capture_interface: 'br-lan' },
  }
}

type ScopeCounts = {
  bytesInWan?: number
  bytesOutWan?: number
  packetsInWan?: number
  packetsOutWan?: number
  bytesInLan?: number
  bytesOutLan?: number
  packetsInLan?: number
  packetsOutLan?: number
}

type ProtocolEntry = {
  protocol: string
  bytes_in: number
  bytes_out: number
  packets_in: number
  packets_out: number
}

function devicesPayload(
  counts: {
    bytesIn: number
    bytesOut: number
    packetsIn: number
    packetsOut: number
    protocols?: ProtocolEntry[]
  } & ScopeCounts
) {
  return {
    devices: [
      {
        mac: MAC,
        ips: ['192.168.1.100', 'fe80::dead:beef'],
        first_seen: '2026-05-25T12:00:00.000Z',
        last_seen: '2026-05-25T12:00:15.000Z',
        bytes_in: counts.bytesIn,
        bytes_out: counts.bytesOut,
        packets_in: counts.packetsIn,
        packets_out: counts.packetsOut,
        bytes_in_wan: counts.bytesInWan,
        bytes_out_wan: counts.bytesOutWan,
        packets_in_wan: counts.packetsInWan,
        packets_out_wan: counts.packetsOutWan,
        bytes_in_lan: counts.bytesInLan,
        bytes_out_lan: counts.bytesOutLan,
        packets_in_lan: counts.packetsInLan,
        packets_out_lan: counts.packetsOutLan,
        top_peers: [{ ip: '8.8.8.8', bytes_in: 100, bytes_out: 200 }],
        top_lan_peers: [{ ip: '192.168.1.10', bytes_in: 1, bytes_out: 1 }],
        protocols: counts.protocols,
      },
    ],
  }
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

test.group('collector_poller | delta', (group) => {
  group.each.setup(resetDb)
  group.each.setup(() => {
    // pollOnce keeps a module-level snapshot map; without this reset we'd
    // inherit the previous test's "previous tick" state.
    _resetPollerState()
  })

  test('first tick → baselined; no bucket rows written', async ({ assert }) => {
    const collector = await makeCollector()
    const fetcher = makeFetcher({
      '/api/v1/summary': summary(),
      '/api/v1/devices': devicesPayload({
        bytesIn: 1000,
        bytesOut: 2000,
        packetsIn: 10,
        packetsOut: 20,
      }),
    })

    const outcome = await pollOnce(collector, { fetcher })
    assert.equal(outcome.status, 'baseline')
    if (outcome.status === 'baseline') {
      assert.equal(outcome.reason, 'first_tick')
      assert.equal(outcome.deviceCount, 1)
    }

    const buckets = await db.from('device_traffic_buckets').select('id')
    assert.equal(buckets.length, 0, 'first tick must not write buckets')

    // Peers ARE upserted on first tick — they're latest-only, no delta to
    // compute.
    const peers = await db.from('device_top_peers').select('*')
    assert.equal(peers.length, 2, 'wan + lan peer rows from first tick')

    const identities = await db.from('device_identities').select('*')
    assert.equal(identities.length, 1)
    assert.equal(identities[0].mac, MAC)
    assert.equal(identities[0].primary_ip, '192.168.1.100')
    assert.deepEqual(JSON.parse(identities[0].ips), ['192.168.1.100', 'fe80::dead:beef'])
  })

  test('second tick after a delta → exactly one bucket row with the diff', async ({ assert }) => {
    const collector = await makeCollector()
    const firstFetcher = makeFetcher({
      '/api/v1/summary': summary(),
      '/api/v1/devices': devicesPayload({
        bytesIn: 1000,
        bytesOut: 2000,
        packetsIn: 10,
        packetsOut: 20,
      }),
    })
    await pollOnce(collector, { fetcher: firstFetcher })

    const secondFetcher = makeFetcher({
      '/api/v1/summary': summary(),
      '/api/v1/devices': devicesPayload({
        bytesIn: 1500, // +500
        bytesOut: 2400, // +400
        packetsIn: 12, // +2
        packetsOut: 25, // +5
      }),
    })
    const outcome = await pollOnce(collector, { fetcher: secondFetcher })

    assert.equal(outcome.status, 'wrote')
    if (outcome.status === 'wrote') {
      assert.equal(outcome.bucketsWritten, 1)
      assert.equal(outcome.deviceCount, 1)
    }

    const rows = await db.from('device_traffic_buckets').select('*')
    assert.equal(rows.length, 1)
    assert.equal(Number(rows[0].bytes_in), 500)
    assert.equal(Number(rows[0].bytes_out), 400)
    assert.equal(Number(rows[0].packets_in), 2)
    assert.equal(Number(rows[0].packets_out), 5)
  })

  test('summary.started_at change → reset detected; no negative delta written', async ({
    assert,
  }) => {
    const collector = await makeCollector()
    await pollOnce(collector, {
      fetcher: makeFetcher({
        '/api/v1/summary': summary({ startedAt: '2026-05-25T12:00:00.000Z' }),
        '/api/v1/devices': devicesPayload({
          bytesIn: 50_000,
          bytesOut: 30_000,
          packetsIn: 100,
          packetsOut: 100,
        }),
      }),
    })

    // Collector restarted: new started_at + smaller counters. Without
    // reset detection, the poller would compute a giant NEGATIVE delta.
    const outcome = await pollOnce(collector, {
      fetcher: makeFetcher({
        '/api/v1/summary': summary({ startedAt: '2026-05-25T12:30:00.000Z' }),
        '/api/v1/devices': devicesPayload({
          bytesIn: 5,
          bytesOut: 5,
          packetsIn: 1,
          packetsOut: 1,
        }),
      }),
    })

    assert.equal(outcome.status, 'baseline')
    if (outcome.status === 'baseline') {
      assert.equal(outcome.reason, 'collector_reset')
    }

    const buckets = await db.from('device_traffic_buckets').select('*')
    assert.equal(buckets.length, 0, 'reset path must NOT write a bucket')
  })

  test('per-scope splits → bucket row carries the WAN+LAN diff alongside totals', async ({
    assert,
  }) => {
    const collector = await makeCollector()
    await pollOnce(collector, {
      fetcher: makeFetcher({
        '/api/v1/summary': summary(),
        '/api/v1/devices': devicesPayload({
          bytesIn: 1000,
          bytesOut: 2000,
          packetsIn: 10,
          packetsOut: 20,
          bytesInWan: 600,
          bytesOutWan: 1400,
          packetsInWan: 6,
          packetsOutWan: 14,
          bytesInLan: 400,
          bytesOutLan: 600,
          packetsInLan: 4,
          packetsOutLan: 6,
        }),
      }),
    })

    const outcome = await pollOnce(collector, {
      fetcher: makeFetcher({
        '/api/v1/summary': summary(),
        '/api/v1/devices': devicesPayload({
          bytesIn: 1500, // +500
          bytesOut: 2400, // +400
          packetsIn: 12, // +2
          packetsOut: 25, // +5
          bytesInWan: 900, // +300
          bytesOutWan: 1700, // +300
          packetsInWan: 7, // +1
          packetsOutWan: 17, // +3
          bytesInLan: 600, // +200
          bytesOutLan: 700, // +100
          packetsInLan: 5, // +1
          packetsOutLan: 8, // +2
        }),
      }),
    })

    assert.equal(outcome.status, 'wrote')

    const rows = await db.from('device_traffic_buckets').select('*')
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.equal(Number(row.bytes_in_wan), 300)
    assert.equal(Number(row.bytes_out_wan), 300)
    assert.equal(Number(row.bytes_in_lan), 200)
    assert.equal(Number(row.bytes_out_lan), 100)
    assert.equal(
      Number(row.bytes_in_wan) + Number(row.bytes_in_lan),
      Number(row.bytes_in),
      'invariant: bytes_in == bytes_in_wan + bytes_in_lan'
    )
    assert.equal(
      Number(row.bytes_out_wan) + Number(row.bytes_out_lan),
      Number(row.bytes_out),
      'invariant: bytes_out == bytes_out_wan + bytes_out_lan'
    )
  })

  test('protocol counters → per-protocol bucket rows on second tick', async ({ assert }) => {
    const collector = await makeCollector()
    await pollOnce(collector, {
      fetcher: makeFetcher({
        '/api/v1/summary': summary(),
        '/api/v1/devices': devicesPayload({
          bytesIn: 1000,
          bytesOut: 2000,
          packetsIn: 10,
          packetsOut: 20,
          protocols: [
            { protocol: 'https', bytes_in: 800, bytes_out: 1500, packets_in: 8, packets_out: 15 },
            { protocol: 'dns', bytes_in: 200, bytes_out: 500, packets_in: 2, packets_out: 5 },
          ],
        }),
      }),
    })

    const outcome = await pollOnce(collector, {
      fetcher: makeFetcher({
        '/api/v1/summary': summary(),
        '/api/v1/devices': devicesPayload({
          bytesIn: 1500,
          bytesOut: 2400,
          packetsIn: 12,
          packetsOut: 25,
          protocols: [
            { protocol: 'https', bytes_in: 1100, bytes_out: 1700, packets_in: 10, packets_out: 18 },
            { protocol: 'dns', bytes_in: 400, bytes_out: 700, packets_in: 2, packets_out: 7 },
          ],
        }),
      }),
    })

    assert.equal(outcome.status, 'wrote')
    if (outcome.status === 'wrote') {
      assert.equal(outcome.protocolBucketsWritten, 2)
    }

    const rows = await db.from('device_protocol_buckets').select('*').orderBy('protocol', 'asc')
    assert.equal(rows.length, 2)
    const https = rows.find((r) => r.protocol === 'https')
    const dns = rows.find((r) => r.protocol === 'dns')
    assert.equal(Number(https?.bytes_in), 300)
    assert.equal(Number(https?.bytes_out), 200)
    assert.equal(Number(dns?.bytes_in), 200)
    assert.equal(Number(dns?.bytes_out), 200)
  })

  test('failed fetch → status=failed, last_status persisted, snapshot untouched', async ({
    assert,
  }) => {
    const collector = await makeCollector()

    const outcome = await pollOnce(collector, {
      fetcher: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch,
    })
    assert.equal(outcome.status, 'failed')

    const refreshed = await Collector.findOrFail(collector.id)
    assert.equal(refreshed.lastStatus?.ok, false)
    assert.match(refreshed.lastStatus?.error ?? '', /fetch failed/)
  })
})
