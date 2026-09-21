import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import {
  COLLECTOR_ANNOUNCE_ENABLED_KEY,
  PENDING_LIMIT,
  _resetAnnounceState,
  apiKeyFingerprint,
} from '#services/collector_announce'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

const ENDPOINT = '/api/v1/collectors/announce'
const SETTINGS_ENDPOINT = '/api/v1/settings/collectors'

/**
 * `testUtils.db().truncate()` returns a teardown function and does NOT clean
 * before the test, so each test forces a truncate at both ends (same helper
 * as `tests/functional/setup/wizard.spec.ts`).
 */
async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

/**
 * The rate limiter is module-level state shared by the whole process, so
 * every test starts from a fresh budget or the 12/minute cap would leak
 * across tests in file order.
 */
function resetRateLimits() {
  _resetAnnounceState()
}

/** Loopback as either family — whichever the test HTTP server binds. */
const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|\[::1\]):9800$/

/** Swaps `globalThis.fetch` so adopt's probe never leaves the process. */
function mockFetch() {
  const original = globalThis.fetch
  let impl: typeof fetch = original
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => impl(...args)) as typeof fetch
  return {
    set: (next: typeof fetch) => {
      impl = next
    },
    restore: () => {
      globalThis.fetch = original
    },
  }
}

function okProbe() {
  return async () =>
    new Response(
      JSON.stringify({
        summary: { total_devices: 7 },
        meta: { capture_interface: 'br-lan', version: '0.1.0' },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
}

/**
 * An admin, an instance name and one ALREADY adopted collector, which is
 * what `requireSetupComplete` needs before `/api/v1/settings/*` opens.
 */
async function seedSetupComplete(): Promise<string> {
  const admin = await User.create({
    fullName: 'Admin',
    email: 'admin@example.com',
    password: 'admin-pass-123',
    role: 'admin',
  })
  await SystemSetting.set('site_name', 'Perch @ test')
  await SystemSetting.set('timezone', 'UTC')
  await Collector.create({
    name: 'localhost',
    baseUrl: 'http://192.168.99.1:9800',
    pollIntervalSeconds: 15,
    enabled: true,
    apiKey: null,
    lastStatus: null,
  })
  const token = await User.accessTokens.create(admin)
  return token.value!.release()
}

function announcePayload(overrides: Record<string, unknown> = {}) {
  return {
    instanceId: '9d4c1a0f6b2e47c8a15d3e9f7b0c2a68',
    hostname: 'OpenWrt',
    version: '0.1.0',
    captureInterface: 'br-lan',
    port: 9800,
    tls: false,
    baseUrl: 'http://10.99.99.99:9999',
    ...overrides,
  }
}

test.group('collector announce', (group) => {
  group.each.setup(resetDb)
  group.each.setup(resetRateLimits)

  test('first announce creates a pending, announced, disabled row', async ({ client, assert }) => {
    const response = await client.post(ENDPOINT).json(announcePayload())

    response.assertStatus(200)
    assert.deepEqual(response.body().data, {
      status: 'pending',
      collectorId: response.body().data.collectorId,
      announceIntervalSeconds: 60,
    })
    assert.notInclude(JSON.stringify(response.body()), 'apiKey')

    const rows = await Collector.all()
    assert.lengthOf(rows, 1)
    const row = rows[0]
    assert.equal(row.lifecycle, 'pending')
    assert.equal(row.source, 'announced')
    assert.isNotOk(row.enabled)
    assert.equal(row.name, 'OpenWrt')
    assert.equal(row.instanceId, '9d4c1a0f6b2e47c8a15d3e9f7b0c2a68')
    assert.equal(row.hostname, 'OpenWrt')
    assert.equal(row.version, '0.1.0')
    assert.equal(row.captureInterface, 'br-lan')
    assert.equal(row.pollIntervalSeconds, 5)
    assert.isNotNull(row.lastAnnounceAt)
    assert.isNull(row.lastSeenAt)
  })

  test('base_url comes from the request address, not the announced one', async ({
    client,
    assert,
  }) => {
    await client.post(ENDPOINT).json(announcePayload())

    const row = await Collector.firstOrFail()
    assert.match(row.baseUrl ?? '', LOOPBACK_URL)
    assert.equal(row.transport, 'poll')
    assert.equal(row.announcedBaseUrl, 'http://10.99.99.99:9999')
    assert.notEqual(row.baseUrl, row.announcedBaseUrl)
  })

  test('X-Forwarded-For from a trusted proxy decides the address', async ({ client, assert }) => {
    // The test client connects from loopback, which is what TRUST_PROXY
    // defaults to, so `request.ip()` honours the forwarded address. This is
    // the whole point of making the trusted-proxy list configurable: behind
    // a reverse proxy the announce must still compute the COLLECTOR's
    // address, not the proxy's.
    const response = await client
      .post(ENDPOINT)
      .header('x-forwarded-for', '192.168.7.42')
      .json(announcePayload())
    response.assertStatus(200)

    const row = await Collector.firstOrFail()
    assert.equal(row.baseUrl, 'http://192.168.7.42:9800')
    assert.equal(row.announcedBaseUrl, 'http://10.99.99.99:9999')
  })

  test('tls: true produces an https base_url', async ({ client, assert }) => {
    await client
      .post(ENDPOINT)
      .header('x-forwarded-for', '192.168.7.43')
      .json(announcePayload({ tls: true, port: 9443 }))

    const row = await Collector.firstOrFail()
    assert.equal(row.baseUrl, 'https://192.168.7.43:9443')
  })

  test('an IPv6 source address is bracketed', async ({ client, assert }) => {
    await client.post(ENDPOINT).header('x-forwarded-for', '2001:db8::1').json(announcePayload())

    const row = await Collector.firstOrFail()
    assert.equal(row.baseUrl, 'http://[2001:db8::1]:9800')
  })

  test('a second announce with the same instanceId updates in place', async ({
    client,
    assert,
  }) => {
    await client.post(ENDPOINT).json(announcePayload())
    const first = await Collector.firstOrFail()

    const second = await client
      .post(ENDPOINT)
      .json(announcePayload({ hostname: 'OpenWrt-renamed', version: '0.2.0' }))
    second.assertStatus(200)
    assert.equal(second.body().data.collectorId, first.id)

    const rows = await Collector.all()
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].hostname, 'OpenWrt-renamed')
    assert.equal(rows[0].version, '0.2.0')
    // `name` is only ever seeded on create; an announce never renames a row.
    assert.equal(rows[0].name, 'OpenWrt')
  })

  test('an announce claims an existing row at the same address', async ({ client, assert }) => {
    // Learn the address this test client announces from, then rebuild the
    // table with a hand-registered row sitting at exactly that address.
    await client.post(ENDPOINT).json(announcePayload({ instanceId: 'probe-instance-id' }))
    const probed = await Collector.firstOrFail()
    const pollUrl = probed.baseUrl
    await Collector.query().delete()

    const manual = await Collector.create({
      name: 'localhost',
      baseUrl: pollUrl,
      apiKey: 'manual-key',
      pollIntervalSeconds: 15,
      enabled: true,
      source: 'manual',
      lifecycle: 'adopted',
    })

    const response = await client.post(ENDPOINT).json(announcePayload())
    response.assertStatus(200)
    assert.equal(response.body().data.status, 'adopted')
    assert.equal(response.body().data.collectorId, manual.id)
    assert.equal(response.body().data.announceIntervalSeconds, 900)

    const rows = await Collector.all()
    assert.lengthOf(rows, 1, 'the claim must not produce a duplicate row')
    const row = rows[0]
    assert.equal(row.instanceId, '9d4c1a0f6b2e47c8a15d3e9f7b0c2a68')
    assert.equal(row.hostname, 'OpenWrt')
    assert.equal(row.captureInterface, 'br-lan')
    assert.equal(row.announcedBaseUrl, 'http://10.99.99.99:9999')
    // Untouched by a claim.
    assert.equal(row.lifecycle, 'adopted')
    assert.equal(row.baseUrl, pollUrl)
    assert.equal(row.apiKey, 'manual-key')
    assert.equal(row.name, 'localhost')
    assert.isOk(row.enabled)
    assert.equal(row.pollIntervalSeconds, 15)
  })

  test('a recreated daemon at the same address is re-identified, not duplicated', async ({
    client,
    assert,
  }) => {
    // First boot: the daemon announces and gets a pending row.
    await client.post(ENDPOINT).json(announcePayload({ instanceId: 'first-boot-instance-id' }))
    const before = await Collector.firstOrFail()
    assert.equal(before.instanceId, 'first-boot-instance-id')

    // Reinstalled: same box, same address, brand new instance-id file.
    const response = await client
      .post(ENDPOINT)
      .json(announcePayload({ instanceId: 'second-boot-instance-id', hostname: 'OpenWrt-rebuilt' }))
    response.assertStatus(200)
    assert.equal(response.body().data.collectorId, before.id)

    const rows = await Collector.all()
    assert.lengthOf(rows, 1, 'the reinstall must not pile up a second pending row')
    assert.equal(rows[0].instanceId, 'second-boot-instance-id')
    assert.equal(rows[0].hostname, 'OpenWrt-rebuilt')
    assert.equal(rows[0].baseUrl, before.baseUrl)
    assert.equal(rows[0].lifecycle, 'pending')
  })

  test('a rebuilt pending daemon relearns its key', async ({ client, assert }) => {
    // First boot announces one key and lands in pending. Nobody has trusted
    // it yet — the admin has not adopted, and the fingerprint on screen is
    // only there to be compared.
    await client
      .post(ENDPOINT)
      .json(announcePayload({ instanceId: 'first-boot-instance-id', apiKey: 'first-boot-key' }))
    const before = await Collector.firstOrFail()
    assert.equal(before.apiKey, 'first-boot-key')
    assert.equal(before.apiKeyFingerprint, apiKeyFingerprint('first-boot-key'))

    // Rebuilt: new instance id AND a new key, same address.
    const response = await client.post(ENDPOINT).json(
      announcePayload({
        instanceId: 'second-boot-instance-id',
        apiKey: 'second-boot-key',
      })
    )
    response.assertStatus(200)
    assert.equal(response.body().data.status, 'pending')

    const rows = await Collector.all()
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].instanceId, 'second-boot-instance-id')
    assert.equal(rows[0].apiKey, 'second-boot-key', 'the stale key would be un-adoptable')
    assert.equal(rows[0].apiKeyFingerprint, apiKeyFingerprint('second-boot-key'))
  })

  test('a dismissed row re-identified at its address keeps its key cleared', async ({
    client,
    assert,
  }) => {
    await client.post(ENDPOINT).json(announcePayload({ instanceId: 'probe-instance-id' }))
    const probed = await Collector.firstOrFail()
    await Collector.query().delete()

    // Dismissal deliberately drops the key; a rebuilt daemon announcing a
    // new one must not push it back into a row the admin said no to.
    const dismissed = await Collector.create({
      name: 'nope',
      baseUrl: probed.baseUrl,
      apiKey: null,
      pollIntervalSeconds: 5,
      enabled: false,
      source: 'announced',
      lifecycle: 'dismissed',
      instanceId: 'dismissed-instance-id',
    })

    const response = await client
      .post(ENDPOINT)
      .json(announcePayload({ instanceId: 'rebuilt-instance-id', apiKey: 'rebuilt-key' }))
    response.assertStatus(200)
    assert.equal(response.body().data.status, 'dismissed')

    const row = await Collector.findOrFail(dismissed.id)
    assert.equal(row.instanceId, 'rebuilt-instance-id')
    assert.isNull(row.apiKey)
    assert.isNull(row.apiKeyFingerprint)
  })

  test('re-identifying an adopted keyed collector requires its key', async ({ client, assert }) => {
    await client.post(ENDPOINT).json(announcePayload({ instanceId: 'original-instance-id' }))
    const probed = await Collector.firstOrFail()
    await Collector.query().delete()

    const adopted = await Collector.create({
      name: 'router',
      baseUrl: probed.baseUrl,
      apiKey: 'the-real-collector-key',
      pollIntervalSeconds: 5,
      enabled: true,
      source: 'announced',
      lifecycle: 'adopted',
      instanceId: 'original-instance-id',
    })

    const impostor = await client
      .post(ENDPOINT)
      .json(announcePayload({ instanceId: 'impostor-instance-id' }))
    impostor.assertStatus(401)
    impostor.assertBodyContains({ error: 'announce_key_mismatch' })

    const untouched = await Collector.findOrFail(adopted.id)
    assert.equal(untouched.instanceId, 'original-instance-id')
    assert.isNull(untouched.lastAnnounceAt)
    assert.lengthOf(await Collector.all(), 1)

    // With the key, the same announce is the legitimate reinstall.
    const rebuilt = await client
      .post(ENDPOINT)
      .header('authorization', 'Bearer the-real-collector-key')
      .json(announcePayload({ instanceId: 'impostor-instance-id' }))
    rebuilt.assertStatus(200)
    assert.equal(rebuilt.body().data.status, 'adopted')
    const reIdentified = await Collector.findOrFail(adopted.id)
    assert.equal(reIdentified.instanceId, 'impostor-instance-id')
    // Unlike a pending row, an ADOPTED row keeps the key it was adopted
    // with: the admin trusted that one, and the poller is using it.
    assert.equal(reIdentified.apiKey, 'the-real-collector-key', 'the key is kept, not replaced')
  })

  test('an address change never lands two rows on one URL', async ({ client, assert }) => {
    // A row already owns the address this test client announces from.
    await client.post(ENDPOINT).json(announcePayload({ instanceId: 'squatter-instance-id' }))
    const squatter = await Collector.firstOrFail()

    // A second announced collector, currently registered elsewhere, now
    // announces from the squatter's address.
    const mover = await Collector.create({
      name: 'mover',
      baseUrl: 'http://192.168.77.7:9800',
      pollIntervalSeconds: 5,
      enabled: false,
      source: 'announced',
      lifecycle: 'pending',
      instanceId: 'mover-instance-id',
    })

    const response = await client
      .post(ENDPOINT)
      .json(announcePayload({ instanceId: 'mover-instance-id' }))
    response.assertStatus(200)

    const movedRow = await Collector.findOrFail(mover.id)
    assert.equal(movedRow.baseUrl, 'http://192.168.77.7:9800', 'the old address is kept')
    assert.isNotNull(movedRow.lastAnnounceAt, 'the refresh itself still happened')

    const squatterRow = await Collector.findOrFail(squatter.id)
    assert.equal(squatterRow.baseUrl, squatter.baseUrl)
    const allRows = await Collector.all()
    const urls = allRows.map((row) => row.baseUrl)
    assert.equal(new Set(urls).size, urls.length, 'no two rows share a base_url')
  })

  test('concurrent announces for one instance id produce one row', async ({ client, assert }) => {
    const [a, b] = await Promise.all([
      client.post(ENDPOINT).json(announcePayload({ instanceId: 'racing-instance-id' })),
      client.post(ENDPOINT).json(announcePayload({ instanceId: 'racing-instance-id' })),
    ])

    a.assertStatus(200)
    b.assertStatus(200)
    const rows = await Collector.all()
    assert.lengthOf(rows, 1)
    assert.equal(a.body().data.collectorId, rows[0].id)
    assert.equal(b.body().data.collectorId, rows[0].id)
  })

  test('an announce without baseUrl keeps the last one it claimed', async ({ client, assert }) => {
    await client.post(ENDPOINT).json(announcePayload())
    const claimed = await Collector.firstOrFail()
    assert.equal(claimed.announcedBaseUrl, 'http://10.99.99.99:9999')

    // The daemon restarts listening on a wildcard address and can no longer
    // say how it is reachable; that is "I cannot tell you", not "nowhere".
    const wildcard = announcePayload()
    delete (wildcard as Record<string, unknown>).baseUrl
    const response = await client.post(ENDPOINT).json(wildcard)
    response.assertStatus(200)

    const row = await Collector.firstOrFail()
    assert.equal(row.announcedBaseUrl, 'http://10.99.99.99:9999')
  })

  test('re-announcing an adopted keyed collector without the key is rejected', async ({
    client,
    assert,
  }) => {
    const adopted = await Collector.create({
      name: 'router',
      baseUrl: 'http://192.168.1.1:9800',
      apiKey: 'the-real-collector-key',
      pollIntervalSeconds: 5,
      enabled: true,
      source: 'announced',
      lifecycle: 'adopted',
      instanceId: '9d4c1a0f6b2e47c8a15d3e9f7b0c2a68',
      hostname: 'OpenWrt',
    })

    const noKey = await client.post(ENDPOINT).json(announcePayload())
    noKey.assertStatus(401)
    noKey.assertBodyContains({ error: 'announce_key_mismatch' })

    const wrongKey = await client
      .post(ENDPOINT)
      .header('authorization', 'Bearer not-the-collector-key')
      .json(announcePayload())
    wrongKey.assertStatus(401)
    wrongKey.assertBodyContains({ error: 'announce_key_mismatch' })

    const row = await Collector.findOrFail(adopted.id)
    assert.equal(row.baseUrl, 'http://192.168.1.1:9800')
    assert.equal(row.apiKey, 'the-real-collector-key')
    assert.isNull(row.lastAnnounceAt)
    assert.isNull(row.announcedBaseUrl)
  })

  test('re-announcing with the correct key refreshes last_announce_at', async ({
    client,
    assert,
  }) => {
    const adopted = await Collector.create({
      name: 'router',
      baseUrl: 'http://192.168.1.1:9800',
      apiKey: 'the-real-collector-key',
      pollIntervalSeconds: 5,
      enabled: true,
      source: 'manual',
      lifecycle: 'adopted',
      instanceId: '9d4c1a0f6b2e47c8a15d3e9f7b0c2a68',
    })

    const response = await client
      .post(ENDPOINT)
      .header('authorization', 'Bearer the-real-collector-key')
      .json(announcePayload())
    response.assertStatus(200)
    assert.equal(response.body().data.status, 'adopted')

    const row = await Collector.findOrFail(adopted.id)
    assert.isNotNull(row.lastAnnounceAt)
    assert.equal(row.hostname, 'OpenWrt')
    // `manual` rows keep the address an admin gave them.
    assert.equal(row.baseUrl, 'http://192.168.1.1:9800')
  })

  test('the 13th announce in a minute from one address is rate limited', async ({
    client,
    assert,
  }) => {
    for (let i = 0; i < 12; i++) {
      const ok = await client.post(ENDPOINT).json(announcePayload())
      ok.assertStatus(200)
    }

    const limited = await client.post(ENDPOINT).json(announcePayload())
    limited.assertStatus(429)
    limited.assertBodyContains({ error: 'announce_rate_limited', retryAfterSeconds: 60 })
    assert.equal(limited.header('retry-after'), '60')
  })

  test('an announce past the pending cap is refused', async ({ client, assert }) => {
    for (let i = 0; i < PENDING_LIMIT; i++) {
      await Collector.create({
        name: `pending-${i}`,
        baseUrl: `http://192.168.50.${i + 1}:9800`,
        pollIntervalSeconds: 5,
        enabled: false,
        source: 'announced',
        lifecycle: 'pending',
        instanceId: `seeded-instance-${i}`,
      })
    }

    const response = await client.post(ENDPOINT).json(announcePayload())
    response.assertStatus(409)
    response.assertBodyContains({ error: 'announce_pending_limit' })
    assert.lengthOf(await Collector.all(), PENDING_LIMIT)

    // Refreshing an existing pending row still works, so a full list never
    // blinds the admin to the collector they are waiting for.
    const refresh = await client
      .post(ENDPOINT)
      .json(announcePayload({ instanceId: 'seeded-instance-0' }))
    refresh.assertStatus(200)
    assert.lengthOf(await Collector.all(), PENDING_LIMIT)
  })

  test('the feature switch turns the endpoint off', async ({ client, assert }) => {
    await SystemSetting.set(COLLECTOR_ANNOUNCE_ENABLED_KEY, false)

    const response = await client.post(ENDPOINT).json(announcePayload())
    response.assertStatus(403)
    response.assertBodyContains({ error: 'announce_disabled' })
    assert.lengthOf(await Collector.all(), 0)
  })

  test('announce works before setup is complete and does not complete setup', async ({
    client,
    assert,
  }) => {
    const before = await client.get('/api/v1/setup/status')
    assert.equal(before.body().data.step, 'admin')

    const response = await client.post(ENDPOINT).json(announcePayload())
    response.assertStatus(200)
    assert.equal(response.body().data.status, 'pending')

    const after = await client.get('/api/v1/setup/status')
    after.assertStatus(200)
    assert.equal(after.body().data.step, 'admin')
    assert.isFalse(after.body().data.hasCollector)
  })

  test('an announced key is stored encrypted with its fingerprint', async ({ client, assert }) => {
    const response = await client
      .post(ENDPOINT)
      .json(announcePayload({ apiKey: 'announced-collector-key' }))
    response.assertStatus(200)
    assert.notInclude(JSON.stringify(response.body()), 'announced-collector-key')

    const row = await Collector.firstOrFail()
    assert.equal(row.apiKey, 'announced-collector-key')
    assert.equal(row.apiKeyFingerprint, apiKeyFingerprint('announced-collector-key'))
  })

  test('a fingerprint-only announce stores no key', async ({ client, assert }) => {
    const response = await client
      .post(ENDPOINT)
      .header('authorization', 'Bearer announced-collector-key')
      .json(announcePayload({ apiKeyFingerprint: apiKeyFingerprint('announced-collector-key') }))
    response.assertStatus(200)

    const row = await Collector.firstOrFail()
    assert.isNull(row.apiKey)
    assert.equal(row.apiKeyFingerprint, apiKeyFingerprint('announced-collector-key'))
  })
})

/**
 * Adoption and dismissal — the admin half of the discovery flow. They live
 * here rather than in `settings/collectors.spec.ts` because what they are
 * really testing is what an announce does next.
 */
test.group('collector adoption', (group) => {
  let fetchMock: ReturnType<typeof mockFetch>

  group.each.setup(resetDb)
  group.each.setup(resetRateLimits)
  group.each.setup(() => {
    fetchMock = mockFetch()
    return () => fetchMock.restore()
  })

  test('adopting a pending collector puts it into service', async ({ client, assert }) => {
    const adminToken = await seedSetupComplete()
    fetchMock.set(okProbe())

    const announced = await client.post(ENDPOINT).json(announcePayload())
    announced.assertStatus(200)
    const collectorId = announced.body().data.collectorId as number

    const adopt = await client
      .post(`${SETTINGS_ENDPOINT}/${collectorId}/adopt`)
      .bearerToken(adminToken)
      .json({ name: 'living-room router', pollIntervalSeconds: 10 })
    adopt.assertStatus(200)
    assert.equal(adopt.body().data.collector.lifecycle, 'adopted')
    assert.isTrue(adopt.body().data.collector.enabled)
    assert.equal(adopt.body().data.collector.name, 'living-room router')
    assert.equal(adopt.body().data.collector.pollIntervalSeconds, 10)
    assert.isTrue(adopt.body().data.probe.ok)

    const row = await Collector.findOrFail(collectorId)
    assert.equal(row.lifecycle, 'adopted')
    assert.isOk(row.enabled)
    assert.isTrue(row.lastStatus?.ok)
    assert.isNotNull(row.lastSeenAt)

    const again = await client
      .post(`${SETTINGS_ENDPOINT}/${collectorId}/adopt`)
      .bearerToken(adminToken)
      .json({})
    again.assertStatus(422)
    again.assertBodyContains({ error: 'collector_not_pending' })
  })

  test('adopting with a key whose fingerprint differs needs acceptKeyChange', async ({
    client,
    assert,
  }) => {
    const adminToken = await seedSetupComplete()
    fetchMock.set(okProbe())

    const announced = await client
      .post(ENDPOINT)
      .json(announcePayload({ apiKey: 'announced-collector-key' }))
    const collectorId = announced.body().data.collectorId as number

    const mismatch = await client
      .post(`${SETTINGS_ENDPOINT}/${collectorId}/adopt`)
      .bearerToken(adminToken)
      .json({ apiKey: 'a-completely-different-key' })
    mismatch.assertStatus(422)
    mismatch.assertBodyContains({ error: 'collector_api_key_mismatch' })
    const untouched = await Collector.findOrFail(collectorId)
    assert.equal(untouched.lifecycle, 'pending')
    assert.equal(untouched.apiKey, 'announced-collector-key')

    const accepted = await client
      .post(`${SETTINGS_ENDPOINT}/${collectorId}/adopt`)
      .bearerToken(adminToken)
      .json({ apiKey: 'a-completely-different-key', acceptKeyChange: true })
    accepted.assertStatus(200)
    assert.equal(accepted.body().data.collector.lifecycle, 'adopted')
    assert.equal(
      accepted.body().data.collector.apiKeyFingerprint,
      apiKeyFingerprint('a-completely-different-key')
    )
    const rekeyed = await Collector.findOrFail(collectorId)
    assert.equal(rekeyed.apiKey, 'a-completely-different-key')
  })

  test('a dismissed collector loses its key and stays out of the default list', async ({
    client,
    assert,
  }) => {
    const adminToken = await seedSetupComplete()
    fetchMock.set(okProbe())

    const announced = await client
      .post(ENDPOINT)
      .json(announcePayload({ apiKey: 'announced-collector-key' }))
    const collectorId = announced.body().data.collectorId as number

    const dismiss = await client
      .post(`${SETTINGS_ENDPOINT}/${collectorId}/dismiss`)
      .bearerToken(adminToken)
    dismiss.assertStatus(200)
    assert.equal(dismiss.body().data.collector.lifecycle, 'dismissed')
    assert.isFalse(dismiss.body().data.collector.enabled)
    assert.isFalse(dismiss.body().data.collector.hasApiKey)
    assert.isNull(dismiss.body().data.collector.apiKeyFingerprint)

    const dismissed = await Collector.findOrFail(collectorId)
    assert.isNull(dismissed.apiKey)
    assert.isNull(dismissed.apiKeyFingerprint)

    // The collector keeps announcing; the row is refreshed, not resurrected,
    // and the daemon is told to drop to the six-hour beat.
    const again = await client.post(ENDPOINT).json(announcePayload({ hostname: 'OpenWrt-again' }))
    again.assertStatus(200)
    assert.equal(again.body().data.status, 'dismissed')
    assert.equal(again.body().data.announceIntervalSeconds, 21_600)
    const refreshed = await Collector.findOrFail(collectorId)
    assert.equal(refreshed.lifecycle, 'dismissed')
    assert.equal(refreshed.hostname, 'OpenWrt-again')
    assert.isNull(refreshed.apiKey)

    const listed = await client.get(SETTINGS_ENDPOINT).bearerToken(adminToken)
    const names = (listed.body().data as Array<{ id: number }>).map((row) => row.id)
    assert.notInclude(names, collectorId)

    const withDismissed = await client
      .get(`${SETTINGS_ENDPOINT}?includeDismissed=true`)
      .bearerToken(adminToken)
    const allIds = (withDismissed.body().data as Array<{ id: number }>).map((row) => row.id)
    assert.include(allIds, collectorId)
  })
})
