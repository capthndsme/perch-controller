import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import { _resetPollerState, pollOnce } from '#services/collector_poller'
import { _resetInfraPortsState } from '#services/infra_ports'
import { _resetQueryCache } from '#services/query_cache'
import {
  _resetRouterState,
  pickRouterResolution,
  recordGatewaySample,
  type GatewayReport,
} from '#services/router_metrics'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  _resetQueryCache()
  _resetRouterState()
  _resetPollerState()
  _resetInfraPortsState()
  return teardown
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
  // The setup gate wants a collector before any read endpoint answers; this
  // one is the router's.
  const collector = await Collector.create({
    name: 'gateway',
    baseUrl: 'http://127.0.0.1:9800',
    transport: 'poll',
    pollIntervalSeconds: 5,
    enabled: true,
    apiKey: null,
    lastStatus: null,
  })
  return { token: token.value!.release(), collector }
}

/** A gateway object the way the collector on the router reports it (docs/collector-agent.md 4.1). */
function report(opts: {
  conntrack?: number
  wan: Array<{ name: string; rx: number; tx: number }>
  wanSource?: 'configured' | 'default-route'
}): GatewayReport {
  return {
    collectedAt: '2026-09-21T14:17:10Z',
    conntrack: { entries: opts.conntrack ?? 2495, limit: 262144 },
    tcpEstablished: 2,
    load: { load1: 1.44, load5: 1.1, load15: 1.49 },
    memory: { totalBytes: 15637843968, availableBytes: 15525001216 },
    wan: opts.wan.map((iface) => ({ name: iface.name, rxBytes: iface.rx, txBytes: iface.tx })),
    wanSource: opts.wanSource ?? 'default-route',
  }
}

/** A polled collector's /summary + /devices, with the gateway object in the summary. */
function fetcherFor(gateway: GatewayReport | null) {
  return (async (url: Parameters<typeof fetch>[0]) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '')
    const body =
      path === '/api/v1/summary'
        ? {
            summary: { started_at: '2026-09-21T10:00:00Z', total_devices: 0 },
            meta: { capture_interface: 'br-lan' },
            ...(gateway ? { gateway } : {}),
          }
        : path === '/api/v1/devices'
          ? { devices: [] }
          : null
    if (body === null) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

async function samples() {
  return db.from('router_samples').select('*').orderBy('recorded_at', 'asc')
}

test.group('router_metrics | resolution', () => {
  test('resolution ladder keeps ~200 points', ({ assert }) => {
    const now = DateTime.utc()
    assert.equal(pickRouterResolution(undefined, now.minus({ hours: 1 }), now), 60)
    assert.equal(pickRouterResolution('auto', now.minus({ hours: 12 }), now), 300)
    assert.equal(pickRouterResolution(undefined, now.minus({ days: 2 }), now), 900)
    assert.equal(pickRouterResolution(undefined, now.minus({ days: 30 }), now), 3600)
    assert.equal(pickRouterResolution('1m', now.minus({ days: 30 }), now), 60)
  })
})

test.group('router_metrics | gateway samples', (group) => {
  group.each.setup(resetDb)

  test('one row per 30 s per collector; the WAN rate is per interface', async ({ assert }) => {
    const { collector } = await bootstrap()
    const t0 = DateTime.utc().minus({ minutes: 5 }).startOf('second')

    await recordGatewaySample(
      collector.id,
      report({ wan: [{ name: 'wan0', rx: 500_000, tx: 1_000_000 }] }),
      t0
    )
    // 10 s later: throttled, nothing written.
    await recordGatewaySample(
      collector.id,
      report({ wan: [{ name: 'wan0', rx: 600_000, tx: 1_100_000 }] }),
      t0.plus({ seconds: 10 })
    )
    // 30 s after the first: +1.5 MB in, +3 MB out → 0.4 / 0.8 Mbps. wan2
    // appears with a big counter; it is not in the previous sample, so it
    // adds to the byte sums but not to the rate (no spike).
    await recordGatewaySample(
      collector.id,
      report({
        wan: [
          { name: 'wan0', rx: 2_000_000, tx: 4_000_000 },
          { name: 'wan2', rx: 9_000_000_000, tx: 9_000_000_000 },
        ],
      }),
      t0.plus({ seconds: 30 })
    )

    const rows = await samples()
    assert.lengthOf(rows, 2)
    assert.isNull(rows[0].wan_rx_bps, 'no rate on the first sample')
    assert.equal(Number(rows[1].wan_rx_bps), 400_000)
    assert.equal(Number(rows[1].wan_tx_bps), 800_000)
    assert.equal(Number(rows[1].wan_rx_bytes), 9_002_000_000, 'sums cover the current interfaces')
    assert.equal(Number(rows[1].conntrack_entries), 2495)
    assert.equal(Number(rows[1].tcp_established), 2)
    assert.equal(Number(rows[1].load1), 1.44)
    assert.equal(Number(rows[1].mem_total), 15637843968)
    assert.isNull(rows[1].scrape_ms)
  })

  test('a counter that went backwards (router reboot) voids the rate', async ({ assert }) => {
    const { collector } = await bootstrap()
    const t0 = DateTime.utc().minus({ minutes: 5 }).startOf('second')
    await recordGatewaySample(
      collector.id,
      report({ wan: [{ name: 'wan0', rx: 5_000_000, tx: 5_000_000 }] }),
      t0
    )
    await recordGatewaySample(
      collector.id,
      report({ wan: [{ name: 'wan0', rx: 10, tx: 10 }] }),
      t0.plus({ seconds: 30 })
    )
    // …and the sample after the reboot has a rate again.
    await recordGatewaySample(
      collector.id,
      report({ wan: [{ name: 'wan0', rx: 3_750_010, tx: 10 }] }),
      t0.plus({ seconds: 60 })
    )
    const rows = await samples()
    assert.lengthOf(rows, 3)
    assert.isNull(rows[1].wan_rx_bps)
    assert.isNull(rows[1].wan_tx_bps)
    assert.equal(Number(rows[2].wan_rx_bps), 1_000_000)
    assert.equal(Number(rows[2].wan_tx_bps), 0)
  })

  test('junk in a report is ignored field by field', async ({ assert }) => {
    const { collector } = await bootstrap()
    await recordGatewaySample(
      collector.id,
      {
        conntrack: { entries: -1, limit: Number.NaN },
        tcpEstablished: null,
        load: { load1: 0.5 },
        memory: null,
        wan: [
          { name: 'wan0', rxBytes: 1, txBytes: 2 },
          { name: '', rxBytes: 1, txBytes: 1 },
          { name: 'wan1', rxBytes: -5, txBytes: 1 },
        ],
        wanSource: 'bogus',
      },
      DateTime.utc()
    )
    const [row] = await samples()
    assert.isNull(row.conntrack_entries)
    assert.isNull(row.conntrack_limit)
    assert.isNull(row.mem_total)
    assert.equal(Number(row.load1), 0.5)
    assert.equal(Number(row.wan_rx_bytes), 1, 'only the valid wan0 counts')
  })
})

test.group('router_metrics | read API', (group) => {
  group.each.setup(resetDb)

  test('a polled collector reporting gateway stats is the source', async ({ client, assert }) => {
    const { token, collector } = await bootstrap()
    const t0 = DateTime.utc().minus({ minutes: 2 }).startOf('second')

    await pollOnce(collector, {
      now: () => t0,
      fetcher: fetcherFor(
        report({
          conntrack: 4000,
          wan: [
            { name: 'wan0', rx: 500_000, tx: 1_000_000 },
            { name: 'wan2', rx: 5000, tx: 7000 },
          ],
        })
      ),
    })
    await pollOnce(collector, {
      now: () => t0.plus({ seconds: 30 }),
      fetcher: fetcherFor(
        report({
          conntrack: 5000,
          wan: [
            { name: 'wan0', rx: 2_000_000, tx: 4_000_000 },
            { name: 'wan2', rx: 5000, tx: 7000 },
          ],
        })
      ),
    })

    await collector.refresh()
    assert.deepEqual(collector.lastStatus?.gateway, {
      reportedAt: t0.plus({ seconds: 30 }).toISO()!,
      wanInterfaces: ['wan0', 'wan2'],
      wanSource: 'default-route',
    })

    const r = await client.get('/api/v1/router?range=1h').bearerToken(token)
    r.assertStatus(200)
    const body = r.body().data
    assert.notProperty(body, 'configured')
    assert.notProperty(body, 'url')
    assert.deepEqual(body.source, {
      collectorId: collector.id,
      name: 'gateway',
      transport: 'poll',
      online: true,
      wanInterfaces: ['wan0', 'wan2'],
      wanSource: 'default-route',
      reportedAt: t0.plus({ seconds: 30 }).toISO(),
    })
    assert.deepEqual(body.wanIfaces, ['wan0', 'wan2'])
    assert.equal(body.resolution, '1m')
    assert.equal(body.latest.conntrackEntries, 5000)
    assert.equal(body.latest.conntrackLimit, 262144)
    assert.deepEqual(body.latest.wanIfaces, ['wan0', 'wan2'])
    assert.equal(body.latest.wanTxMbps, 0.8)
    assert.isAtLeast(body.latest.ageSeconds, 0)
    const peak = Math.max(...body.series.map((b: { conntrackMax: number }) => b.conntrackMax))
    assert.equal(peak, 5000)
  })

  test('without a reporting collector: source null, history still served', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    // A sample from the retired scrape era (or from a collector that stopped reporting).
    await recordGatewaySample(
      collector.id,
      report({ wan: [{ name: 'wan0', rx: 1, tx: 1 }] }),
      DateTime.utc().minus({ minutes: 1 })
    )
    // A poll without a gateway object drops the block from last_status.
    await pollOnce(collector, { fetcher: fetcherFor(null) })
    await pollOnce(collector, { fetcher: fetcherFor(null) })
    await collector.refresh()
    assert.isUndefined(collector.lastStatus?.gateway)

    const r = await client.get('/api/v1/router?range=1h').bearerToken(token)
    r.assertStatus(200)
    const body = r.body().data
    assert.isNull(body.source)
    assert.deepEqual(body.wanIfaces, [])
    assert.isNotNull(body.latest)
    assert.isAtLeast(body.series.length, 1)
  })

  test('a failed poll keeps the gateway block; the source reads offline', async ({
    client,
    assert,
  }) => {
    const { token, collector } = await bootstrap()
    await pollOnce(collector, {
      fetcher: fetcherFor(report({ wan: [{ name: 'wan0', rx: 1, tx: 1 }] })),
    })
    await pollOnce(collector, {
      fetcher: (async () => {
        throw new Error('connect ECONNREFUSED')
      }) as unknown as typeof fetch,
    })
    await collector.refresh()
    assert.isFalse(collector.lastStatus?.ok)
    assert.deepEqual(collector.lastStatus?.gateway?.wanInterfaces, ['wan0'])

    const response = await client.get('/api/v1/router?range=1h').bearerToken(token)
    const body = response.body().data
    assert.equal(body.source.collectorId, collector.id)
    assert.isFalse(body.source.online)
  })
})
