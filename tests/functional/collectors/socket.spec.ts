import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import {
  _resetCollectorAgentState,
  checkCollectorPushFreshness,
  handleCollectorPush,
} from '#services/collector_agent'
import collectorHub from '#services/collector_agent_hub'
import {
  COLLECTOR_ANNOUNCE_ENABLED_KEY,
  PENDING_LIMIT,
  _resetAnnounceState,
  apiKeyFingerprint,
} from '#services/collector_announce'
import { _resetPollerState, nextAttemptAtFor, pollOnce } from '#services/collector_poller'
import { _resetApAgentRateLimits } from '#services/ap_agent_rate_limit'
import { _resetRouterState } from '#services/router_metrics'
import PollCollectorsTask from '#tasks/poll_collectors.task'
import { eventually, seedSetupComplete } from '#tests/helpers/ap_agent'
import {
  COLLECTOR_SUBPROTOCOL,
  DEFAULT_PROTOCOLS,
  FakeCollector,
  TEST_API_KEY,
  TEST_INSTANCE_ID,
  attemptCollectorHandshake,
  device,
  reading,
} from '#tests/helpers/collector_agent'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

const SETTINGS = '/api/v1/settings/collectors'
const MAC = '02:00:00:00:00:20'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

function resetState() {
  _resetAnnounceState()
  _resetApAgentRateLimits()
  _resetCollectorAgentState()
  _resetPollerState()
  _resetRouterState()
}

/** An adopted socket collector row, as if it had been adopted earlier. */
async function seedAgentCollector(
  overrides: Partial<{
    apiKey: string | null
    enabled: boolean
    lifecycle: string
    pollIntervalSeconds: number
    instanceId: string
    transport: string
    baseUrl: string | null
  }> = {}
) {
  const apiKey = overrides.apiKey === undefined ? TEST_API_KEY : overrides.apiKey
  return Collector.create({
    name: 'gateway',
    baseUrl: overrides.baseUrl ?? null,
    transport: overrides.transport ?? 'agent',
    instanceId: overrides.instanceId ?? TEST_INSTANCE_ID,
    source: 'announced',
    lifecycle: overrides.lifecycle ?? 'adopted',
    enabled: overrides.enabled ?? true,
    pollIntervalSeconds: overrides.pollIntervalSeconds ?? 5,
    apiKey,
    apiKeyFingerprint: apiKey ? apiKeyFingerprint(apiKey) : null,
    lastStatus: null,
  })
}

async function trafficRows(collectorId: number) {
  return db
    .from('device_traffic_buckets')
    .where('collector_id', collectorId)
    .select('mac', 'bucket_start', 'bytes_in', 'bytes_out', 'packets_in', 'packets_out')
    .orderBy('bucket_start', 'asc')
}

async function protocolRows(collectorId: number) {
  return db
    .from('device_protocol_buckets')
    .where('collector_id', collectorId)
    .select('mac', 'protocol', 'bytes_in', 'bytes_out')
    .orderBy('protocol', 'asc')
}

function sumBytes(rows: Array<{ bytes_in: unknown; bytes_out: unknown }>) {
  return rows.reduce(
    (acc, row) => ({
      in: acc.in + Number(row.bytes_in),
      out: acc.out + Number(row.bytes_out),
    }),
    { in: 0, out: 0 }
  )
}

/** A polled collector's /summary + /devices for one reading. */
function fetcherFor(params: ReturnType<typeof reading>): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0]) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '')
    const body =
      path === '/api/v1/summary'
        ? { summary: params.summary, meta: params.meta }
        : path === '/api/v1/devices'
          ? { devices: params.devices }
          : null
    if (body === null) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

async function closeCode(collector: FakeCollector): Promise<number> {
  const closed = await collector.closed
  return closed.code
}

async function helloCollectorId(
  collector: FakeCollector,
  params: Record<string, unknown> = {}
): Promise<number> {
  const reply = await collector.hello(params)
  return (reply.result as { collectorId: number }).collectorId
}

async function storedKey(collectorId: number): Promise<string | null> {
  const row = await Collector.findOrFail(collectorId)
  return row.apiKey
}

async function statusOf(pending: Promise<{ status: string }>): Promise<string> {
  const outcome = await pending
  return outcome.status
}

test.group('collector socket | upgrade', (group) => {
  group.each.setup(resetDb)
  group.each.setup(() => {
    resetState()
    return () => {
      collectorHub.closeAll(1000, 'test reset')
      resetState()
    }
  })

  test('missing headers and foreign subprotocols are refused', async ({ assert }) => {
    const noKey = await attemptCollectorHandshake({ authorization: null })
    assert.equal(noKey.status, 400)
    assert.deepInclude((noKey as { body: any }).body, { error: 'invalid_request' })

    const noId = await attemptCollectorHandshake({ instanceId: null })
    assert.equal(noId.status, 400)

    const badId = await attemptCollectorHandshake({ instanceId: 'x' })
    assert.equal(badId.status, 400)

    const foreign = await attemptCollectorHandshake({ protocols: ['perch-collector.v2'] })
    assert.equal(foreign.status, 400)
    assert.deepInclude((foreign as { body: any }).body, { error: 'unsupported_protocol' })
  })

  test('a row that stores a key refuses any other bearer with 401', async ({ assert }) => {
    await seedAgentCollector()
    const wrong = await attemptCollectorHandshake({ authorization: 'Bearer not-the-key-123' })
    assert.equal(wrong.status, 401)
    assert.deepInclude((wrong as { body: any }).body, { error: 'invalid_collector_key' })

    const right = await attemptCollectorHandshake({})
    assert.equal(right.status, 'open')
    if (right.status === 'open') {
      assert.equal(right.socket.protocol, COLLECTOR_SUBPROTOCOL)
      right.socket.close()
    }
  })

  test('discovery off: only adopted collectors get in', async ({ assert }) => {
    await SystemSetting.set(COLLECTOR_ANNOUNCE_ENABLED_KEY, false)
    const unknown = await attemptCollectorHandshake({})
    assert.equal(unknown.status, 403)
    assert.deepInclude((unknown as { body: any }).body, { error: 'announce_disabled' })

    await seedAgentCollector()
    const adopted = await attemptCollectorHandshake({})
    assert.equal(adopted.status, 'open')
    if (adopted.status === 'open') adopted.socket.close()
  })

  test('a full pending list refuses new instance ids with 409', async ({ assert }) => {
    for (let i = 0; i < PENDING_LIMIT; i++) {
      await Collector.create({
        name: `pending-${i}`,
        baseUrl: `http://192.168.1.${10 + i}:9800`,
        instanceId: `pendinginstance${String(i).padStart(4, '0')}`,
        source: 'announced',
        lifecycle: 'pending',
        enabled: false,
        pollIntervalSeconds: 5,
        apiKey: null,
        lastStatus: null,
      })
    }
    const refused = await attemptCollectorHandshake({})
    assert.equal(refused.status, 409)
    assert.deepInclude((refused as { body: any }).body, { error: 'announce_pending_limit' })
  })
})

test.group('collector socket | session', (group) => {
  group.each.setup(resetDb)
  group.each.setup(() => {
    resetState()
    return () => {
      collectorHub.closeAll(1000, 'test reset')
      resetState()
    }
  })

  test('hello creates a pending agent row; adopting starts pushes at once', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const collector = await FakeCollector.connect()

    const reply = await collector.hello()
    const result = reply.result as { collectorId: number; lifecycle: string; name: string }
    assert.equal(result.lifecycle, 'pending')
    assert.equal(result.name, 'OpenWrt')
    await collector.waitFor('agent.configure')
    assert.deepEqual(collector.lastConfigure(), { metricsIntervalSeconds: 0, lifecycle: 'pending' })

    const row = await Collector.findOrFail(result.collectorId)
    assert.equal(row.transport, 'agent')
    assert.equal(row.source, 'announced')
    assert.equal(row.lifecycle, 'pending')
    assert.isNull(row.baseUrl, 'a hello without a port has nothing to poll')
    assert.equal(row.apiKeyFingerprint, apiKeyFingerprint(TEST_API_KEY))
    assert.isTrue(collectorHub.isOnline(row.id))

    const listed = await client.get(SETTINGS).bearerToken(adminToken)
    const entry = listed.body().data.find((c: { id: number }) => c.id === row.id)
    assert.equal(entry.transport, 'agent')
    assert.isNull(entry.baseUrl)
    assert.isTrue(entry.connection.online)
    assert.isString(entry.connection.connectedAt)
    assert.match(entry.connection.address, /^(127\.0\.0\.1|::1)$/)
    // Loopback is a trusted proxy that did not send X-Forwarded-Proto: unknown.
    assert.isNull(entry.connection.secure)
    assert.isNull(entry.gateway)

    const adopt = await client
      .post(`${SETTINGS}/${row.id}/adopt`)
      .bearerToken(adminToken)
      .json({ name: 'gateway' })
    adopt.assertStatus(200)
    assert.isTrue(adopt.body().data.probe.ok, 'the probe is collector.status over the socket')
    assert.equal(adopt.body().data.probe.totalDevices, 3)
    assert.equal(adopt.body().data.collector.lifecycle, 'adopted')

    const configures = await collector.waitForCount('agent.configure', 2)
    assert.deepEqual(configures[1].params, { metricsIntervalSeconds: 5, lifecycle: 'adopted' })
    await collector.waitFor('collector.protocols')
    const categories = await eventually(
      () => db.from('protocol_categories').select('protocol', 'category').orderBy('protocol'),
      (rows) => rows.length === DEFAULT_PROTOCOLS.length
    )
    // Stored lower-cased, like the poll path's category sync.
    assert.deepEqual(
      categories.map((c) => c.protocol),
      ['quic', 'tls']
    )

    // The announced key was stored at hello time; the adopted row keeps it.
    const adopted = await Collector.findOrFail(row.id)
    assert.equal(adopted.apiKey, TEST_API_KEY)
    await collector.close()
  })

  test('a socket collector behind a proxy that says https is reported secure', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const collector = await FakeCollector.connect({ headers: { 'X-Forwarded-Proto': 'https' } })
    const reply = await collector.hello()
    const { collectorId } = reply.result as { collectorId: number }

    const listed = await client.get(SETTINGS).bearerToken(adminToken)
    const entry = listed.body().data.find((c: { id: number }) => c.id === collectorId)
    assert.isTrue(entry.connection.secure)
    await collector.close()
  })

  test('a hello with a port on a non-loopback address keeps a pollable base_url', async ({
    assert,
  }) => {
    const collector = await FakeCollector.connect()
    const reply = await collector.hello({ port: 9800 })
    const { collectorId } = reply.result as { collectorId: number }
    const row = await Collector.findOrFail(collectorId)
    assert.match(row.baseUrl ?? '', /^http:\/\/(127\.0\.0\.1|\[::1\]):9800$/)
    await collector.close()
  })

  test('a push goes through the same ingest as a poll', async ({ assert }) => {
    const row = await seedAgentCollector()
    const collector = await FakeCollector.connect()
    await collector.hello()
    await collector.waitFor('agent.configure')

    // 150 devices: a frame far above the deflate threshold, so the push is
    // compressed on the way in (permessage-deflate on this endpoint).
    const devices = Array.from({ length: 150 }, (_, i) =>
      device(`02:00:00:00:01:${i.toString(16).padStart(2, '0')}`, { bytesIn: 1000, bytesOut: 500 })
    )
    assert.include(String(collector.socket.extensions), 'permessage-deflate')
    collector.notifyServer('collector.push', reading(devices))
    // The first reading baselines: identities written, no buckets yet.
    const identities = await eventually(
      () => db.from('device_identities').where('collector_id', row.id),
      (rows) => rows.length === 150
    )
    assert.equal(identities[0].collector_id, row.id)
    await eventually(
      () => Collector.findOrFail(row.id),
      (fresh) => fresh.lastStatus?.ok === true
    )
    assert.lengthOf(await trafficRows(row.id), 0)
    await collector.close()
  })

  test('push and poll of the same readings write the same rows', async ({ assert }) => {
    const polled = await Collector.create({
      name: 'polled',
      baseUrl: 'http://127.0.0.1:9',
      transport: 'poll',
      pollIntervalSeconds: 5,
      enabled: true,
      apiKey: null,
      lastStatus: null,
    })
    const pushed = await seedAgentCollector()
    const t0 = DateTime.fromISO('2026-09-21T12:00:00Z', { zone: 'utc' })
    const first = reading([device(MAC, { bytesIn: 1000, bytesOut: 500 })])
    const second = reading([device(MAC, { bytesIn: 51_000, bytesOut: 2500 })], { seq: 2 })
    const third = reading([device(MAC, { bytesIn: 81_000, bytesOut: 12_500 })], { seq: 3 })

    for (const [at, params] of [
      [t0, first],
      [t0.plus({ seconds: 5 }), second],
      [t0.plus({ seconds: 10 }), third],
    ] as const) {
      await pollOnce(polled, { now: () => at, fetcher: fetcherFor(params) })
      const outcome = await handleCollectorPush(pushed.id, params, { receivedAt: at })
      assert.equal(outcome.status, 'ingested')
    }

    const strip = (rows: Array<Record<string, unknown>>) =>
      rows.map((row) => ({ ...row, bucket_start: String(row.bucket_start) }))
    assert.deepEqual(strip(await trafficRows(pushed.id)), strip(await trafficRows(polled.id)))
    assert.deepEqual(await protocolRows(pushed.id), await protocolRows(polled.id))
    assert.deepEqual(sumBytes(await trafficRows(pushed.id)), { in: 80_000, out: 12_000 })
  })

  test('switching from poll to the socket never counts a byte twice', async ({ assert }) => {
    const row = await seedAgentCollector({
      transport: 'poll',
      baseUrl: 'http://127.0.0.1:9',
    })
    const t0 = DateTime.fromISO('2026-09-21T12:00:00Z', { zone: 'utc' })
    await pollOnce(row, {
      now: () => t0,
      fetcher: fetcherFor(reading([device(MAC, { bytesIn: 1000, bytesOut: 1000 })])),
    })
    await pollOnce(row, {
      now: () => t0.plus({ seconds: 5 }),
      fetcher: fetcherFor(reading([device(MAC, { bytesIn: 4000, bytesOut: 2000 })])),
    })

    const collector = await FakeCollector.connect()
    await collector.hello()
    await collector.waitFor('agent.configure')
    const switched = await Collector.findOrFail(row.id)
    assert.equal(switched.transport, 'agent')
    assert.equal(switched.baseUrl, 'http://127.0.0.1:9', 'a hello without a port keeps the address')

    // The poll task no longer touches it…
    const attemptBefore = nextAttemptAtFor(row.id)
    const original = globalThis.fetch
    let fetched = 0
    globalThis.fetch = (async () => {
      fetched += 1
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    try {
      await new PollCollectorsTask().run()
    } finally {
      globalThis.fetch = original
    }
    assert.equal(fetched, 0)
    assert.equal(nextAttemptAtFor(row.id), attemptBefore)

    // …and the first push continues from the poll's snapshot.
    const outcome = await handleCollectorPush(
      row.id,
      reading([device(MAC, { bytesIn: 10_000, bytesOut: 2500 })]),
      { receivedAt: t0.plus({ seconds: 10 }) }
    )
    assert.equal(outcome.status, 'ingested')
    assert.deepEqual(sumBytes(await trafficRows(row.id)), { in: 9000, out: 1500 })
    await collector.close()
  })

  test('early, invalid and disabled pushes are dropped', async ({ assert }) => {
    const row = await seedAgentCollector({ pollIntervalSeconds: 15 })
    const t0 = DateTime.utc()
    const params = reading([device(MAC, { bytesIn: 1, bytesOut: 1 })])
    assert.equal(
      await statusOf(handleCollectorPush(row.id, params, { receivedAt: t0 })),
      'ingested'
    )
    assert.deepEqual(
      await handleCollectorPush(row.id, params, { receivedAt: t0.plus({ seconds: 5 }) }),
      { status: 'dropped', reason: 'too_early' }
    )
    assert.deepEqual(await handleCollectorPush(row.id, { devices: [] }), {
      status: 'dropped',
      reason: 'invalid',
    })

    row.enabled = false
    await row.save()
    assert.deepEqual(
      await handleCollectorPush(row.id, params, { receivedAt: t0.plus({ seconds: 30 }) }),
      { status: 'dropped', reason: 'disabled' }
    )

    const pending = await seedAgentCollector({
      lifecycle: 'pending',
      instanceId: 'otherinstance000001',
    })
    assert.deepEqual(await handleCollectorPush(pending.id, params), {
      status: 'dropped',
      reason: 'not_adopted',
    })
  })

  test('while one push is ingested only the newest waits', async ({ assert }) => {
    const row = await seedAgentCollector()
    const t0 = DateTime.utc()
    const make = (bytesIn: number) => reading([device(MAC, { bytesIn, bytesOut: 1 })])
    const first = handleCollectorPush(row.id, make(1), { receivedAt: t0 })
    const second = handleCollectorPush(row.id, make(2), { receivedAt: t0.plus({ seconds: 6 }) })
    const third = handleCollectorPush(row.id, make(3), { receivedAt: t0.plus({ seconds: 12 }) })
    assert.equal(await statusOf(first), 'ingested')
    assert.deepEqual(await second, { status: 'dropped', reason: 'superseded' })
    assert.equal(await statusOf(third), 'ingested')
    assert.deepEqual(sumBytes(await trafficRows(row.id)), { in: 2, out: 0 })
  })

  test('disabling or editing a socket collector resends its schedule', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const row = await seedAgentCollector()
    const collector = await FakeCollector.connect()
    await collector.hello()
    await collector.waitFor('agent.configure')

    await client
      .put(`${SETTINGS}/${row.id}?probe=false`)
      .bearerToken(adminToken)
      .json({ pollIntervalSeconds: 10 })
      .then((r) => r.assertStatus(200))
    await client
      .put(`${SETTINGS}/${row.id}?probe=false`)
      .bearerToken(adminToken)
      .json({ enabled: false })
      .then((r) => r.assertStatus(200))
    const configures = await collector.waitForCount('agent.configure', 3)
    assert.deepEqual(
      configures.map((c) => c.params.metricsIntervalSeconds),
      [5, 10, 0]
    )

    const probe = await client.post(`${SETTINGS}/${row.id}/probe`).bearerToken(adminToken)
    assert.isTrue(probe.body().data.probe.ok)
    assert.equal(probe.body().data.probe.captureInterface, 'br-lan')
    await collector.close()
  })

  test('dismiss closes the session with 4003, delete with 4001', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const first = await FakeCollector.connect()
    const collectorId = await helloCollectorId(first)
    await client.post(`${SETTINGS}/${collectorId}/dismiss`).bearerToken(adminToken)
    assert.equal(await closeCode(first), 4003)

    // A dismissed collector that comes back gets its answer, then 4003 again.
    const again = await FakeCollector.connect()
    const reply = await again.hello()
    assert.equal((reply.result as { lifecycle: string }).lifecycle, 'dismissed')
    assert.equal(await closeCode(again), 4003)
    assert.isFalse(collectorHub.isOnline(collectorId))

    const other = await FakeCollector.connect({ instanceId: 'otherinstance000002' })
    const otherId = await helloCollectorId(other, { instanceId: 'otherinstance000002' })
    const deleted = await client.delete(`${SETTINGS}/${otherId}`).bearerToken(adminToken)
    deleted.assertStatus(204)
    assert.equal(await closeCode(other), 4001)
  })

  test('adopting with a key the live session does not hold closes it with 4001', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const collector = await FakeCollector.connect()
    // Fingerprint only: the key is not in the hello body.
    const collectorId = await helloCollectorId(collector, {
      apiKey: undefined,
      apiKeyFingerprint: apiKeyFingerprint(TEST_API_KEY),
    })
    const adopt = await client
      .post(`${SETTINGS}/${collectorId}/adopt`)
      .bearerToken(adminToken)
      .json({ apiKey: 'a-different-key-999', acceptKeyChange: true })
    adopt.assertStatus(200)
    assert.equal(await closeCode(collector), 4001)

    // The next connect meets the new key at the door.
    const again = await attemptCollectorHandshake({})
    assert.equal(again.status, 401)
  })

  test('adopting without a key binds the one the connected collector presented', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const collector = await FakeCollector.connect()
    const collectorId = await helloCollectorId(collector, {
      apiKey: undefined,
      apiKeyFingerprint: apiKeyFingerprint(TEST_API_KEY),
    })
    assert.isNull(await storedKey(collectorId))

    const adopt = await client
      .post(`${SETTINGS}/${collectorId}/adopt`)
      .bearerToken(adminToken)
      .json({})
    adopt.assertStatus(200)
    assert.isTrue(adopt.body().data.collector.hasApiKey)
    assert.equal(await storedKey(collectorId), TEST_API_KEY)
    assert.isTrue(collector.socket.readyState === collector.socket.OPEN)
    await collector.close()
  })

  test('protocol violations: no hello, a foreign first frame, a mismatched id', async ({
    assert,
  }) => {
    const junk = await FakeCollector.connect()
    junk.notifyServer('collector.push', reading([]))
    assert.equal(await closeCode(junk), 1008)

    const mismatched = await FakeCollector.connect()
    const reply = await mismatched.hello({ instanceId: 'someoneelse000001' })
    assert.equal((reply.error as { code: number }).code, -32602)
    assert.equal(await closeCode(mismatched), 1008)
  })

  test('a silent socket collector is reported stale once per episode', async ({ assert }) => {
    const row = await seedAgentCollector()
    const collector = await FakeCollector.connect()
    await collector.hello()
    await collector.waitFor('agent.configure')

    const later = DateTime.utc().plus({ seconds: 40 })
    assert.deepEqual(await checkCollectorPushFreshness(later), [row.id])
    assert.deepEqual(await checkCollectorPushFreshness(later.plus({ seconds: 5 })), [])
    const stale = await Collector.findOrFail(row.id)
    assert.isFalse(stale.lastStatus?.ok)
    assert.match(stale.lastStatus?.error ?? '', /no data from the collector/)
    await collector.close()
  })

  test('gateway stats in a push reach router_samples and the collector row', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const row = await seedAgentCollector()
    const collector = await FakeCollector.connect()
    await collector.hello()
    await collector.waitFor('agent.configure')

    collector.notifyServer(
      'collector.push',
      reading([device(MAC, { bytesIn: 1, bytesOut: 1 })], {
        gateway: {
          collectedAt: '2026-09-21T14:17:10Z',
          conntrack: { entries: 2495, limit: 262144 },
          tcpEstablished: 2,
          load: { load1: 1.44, load5: 1.1, load15: 1.49 },
          memory: { totalBytes: 15637843968, availableBytes: 15525001216 },
          wan: [{ name: 'wan0', rxBytes: 693974698743, txBytes: 1697321558462 }],
          wanSource: 'default-route',
        },
      })
    )
    const samples = await eventually(
      () => db.from('router_samples').select('*'),
      (rows) => rows.length === 1
    )
    assert.equal(Number(samples[0].conntrack_entries), 2495)

    const fresh = await eventually(
      () => Collector.findOrFail(row.id),
      (c) => c.lastStatus?.gateway !== undefined
    )
    assert.deepEqual(fresh.lastStatus?.gateway?.wanInterfaces, ['wan0'])

    const listed = await client.get(SETTINGS).bearerToken(adminToken)
    const entry = listed.body().data.find((c: { id: number }) => c.id === row.id)
    assert.deepEqual(entry.gateway.wanInterfaces, ['wan0'])
    assert.equal(entry.gateway.wanSource, 'default-route')

    const router = await client.get('/api/v1/router?range=1h').bearerToken(adminToken)
    assert.equal(router.body().data.source.collectorId, row.id)
    assert.equal(router.body().data.source.transport, 'agent')
    assert.isTrue(router.body().data.source.online)
    await collector.close()
  })

  test('a push for a row that no longer exists closes the session with 4001', async ({
    assert,
  }) => {
    const row = await seedAgentCollector()
    const collector = await FakeCollector.connect()
    await collector.hello()
    await collector.waitFor('agent.configure')
    // The CLI (purge/merge) deletes rows without reaching this process's hub.
    await db.from('collectors').where('id', row.id).delete()
    collector.notifyServer('collector.push', reading([]))
    assert.equal(await closeCode(collector), 4001)
  })
})
