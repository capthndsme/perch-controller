import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import { _resetAnnounceState, apiKeyFingerprint } from '#services/collector_announce'
import {
  _resetSetupLoginRateLimits,
  SETUP_LOGIN_FAILURE_LIMIT,
} from '#services/setup_login_rate_limit'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

/**
 * `testUtils.db().truncate()` returns a function that truncates on
 * teardown — it does NOT clean BEFORE the test runs, so the first test in
 * each spec file inherits whatever the previous file left behind. This
 * helper forces a truncate at both setup and teardown so each test sees a
 * pristine DB regardless of file ordering.
 */
async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

/**
 * Helper that mocks `globalThis.fetch` for the duration of a test group.
 * Returns a setter that lets each test prescribe its own probe response
 * without having to remember teardown bookkeeping.
 */
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

const ADMIN_PAYLOAD = {
  fullName: 'Admin Person',
  email: 'admin@example.com',
  password: 'admin-pass-123',
  passwordConfirmation: 'admin-pass-123',
}

const INSTANCE_PAYLOAD = { siteName: 'Perch @ test', timezone: 'UTC' }

const COLLECTOR_PAYLOAD = {
  name: 'localhost',
  baseUrl: 'http://127.0.0.1:9800',
  pollIntervalSeconds: 15,
}

/**
 * All wizard endpoints route their successful responses through
 * `ctx.serialize(...)`, which wraps everything in `{ data: ... }` (see
 * `providers/api_provider.ts`). Errors raised via `response.<status>(...)`
 * are NOT wrapped. Tests below assert against the wrapped shape for happy
 * paths and the flat shape for middleware/controller-level rejections.
 */

test.group('setup wizard | status progression', (group) => {
  group.each.setup(resetDb)

  test('empty DB → step admin', async ({ client, assert }) => {
    const r = await client.get('/api/v1/setup/status')
    r.assertStatus(200)
    const data = r.body().data
    assert.equal(data.step, 'admin')
    assert.isFalse(data.adminExists)
    assert.isFalse(data.hasInstance)
    assert.isFalse(data.hasCollector)
    assert.match(data.version, /^\d+\.\d+\.\d+/)
    assert.equal(data.suggestedCollectorUrl, 'http://127.0.0.1:9800')
    assert.equal(data.defaultPollIntervalSeconds, 5)
  })

  test('after admin → step instance', async ({ client, assert }) => {
    await client.post('/api/v1/setup/admin').json(ADMIN_PAYLOAD)
    const r = await client.get('/api/v1/setup/status')
    r.assertStatus(200)
    assert.equal(r.body().data.step, 'instance')
    assert.isTrue(r.body().data.adminExists)
    assert.isFalse(r.body().data.hasInstance)
  })

  test('after instance → step collector', async ({ client, assert }) => {
    const admin = await client.post('/api/v1/setup/admin').json(ADMIN_PAYLOAD)
    const token = admin.body().data.token as string
    const inst = await client
      .post('/api/v1/setup/instance')
      .bearerToken(token)
      .json(INSTANCE_PAYLOAD)
    inst.assertStatus(200) // ensure step 2 actually succeeded before step 3 assertion

    const r = await client.get('/api/v1/setup/status')
    r.assertStatus(200)
    assert.equal(r.body().data.step, 'collector')
    assert.isTrue(r.body().data.hasInstance)
    assert.isFalse(r.body().data.hasCollector)
  })
})

test.group('setup wizard | admin one-shot', (group) => {
  group.each.setup(resetDb)

  test('first call creates admin and returns bearer token', async ({ client, assert }) => {
    const r = await client.post('/api/v1/setup/admin').json(ADMIN_PAYLOAD)
    r.assertStatus(200)
    const data = r.body().data
    assert.equal(data.user.email, ADMIN_PAYLOAD.email)
    assert.equal(data.user.role, 'admin')
    assert.isString(data.token)

    const stored = await User.findByOrFail('email', ADMIN_PAYLOAD.email)
    assert.equal(stored.role, 'admin')
    assert.isTrue(stored.isAdmin)
  })

  test('second call conflicts with 409', async ({ client }) => {
    await client.post('/api/v1/setup/admin').json(ADMIN_PAYLOAD)
    const r = await client
      .post('/api/v1/setup/admin')
      .json({ ...ADMIN_PAYLOAD, email: 'second@example.com' })
    r.assertStatus(409)
    r.assertBodyContains({ error: 'admin_already_exists' })
  })

  test('validation failure returns 422', async ({ client }) => {
    const r = await client
      .post('/api/v1/setup/admin')
      .json({ ...ADMIN_PAYLOAD, email: 'not-an-email' })
    r.assertStatus(422)
  })
})

test.group('setup wizard | instance auth gates', (group) => {
  group.each.setup(resetDb)

  test('unauthenticated → 401', async ({ client }) => {
    await client.post('/api/v1/setup/admin').json(ADMIN_PAYLOAD)
    const r = await client.post('/api/v1/setup/instance').json(INSTANCE_PAYLOAD)
    r.assertStatus(401)
  })

  test('non-admin user → 403', async ({ client }) => {
    await client.post('/api/v1/setup/admin').json(ADMIN_PAYLOAD)
    // Manually create an operator-role user + token (the public signup path
    // would 503 here because setup is mid-flight).
    const operator = await User.create({
      fullName: 'Op',
      email: 'op@example.com',
      password: 'opopopop',
      role: 'operator',
    })
    const opToken = await User.accessTokens.create(operator)

    const r = await client
      .post('/api/v1/setup/instance')
      .bearerToken(opToken.value!.release())
      .json(INSTANCE_PAYLOAD)
    r.assertStatus(403)
    r.assertBodyContains({ error: 'admin_required' })
  })

  test('admin → 200, persists settings', async ({ client, assert }) => {
    const admin = await client.post('/api/v1/setup/admin').json(ADMIN_PAYLOAD)
    const r = await client
      .post('/api/v1/setup/instance')
      .bearerToken(admin.body().data.token)
      .json(INSTANCE_PAYLOAD)
    r.assertStatus(200)
    assert.equal(r.body().data.siteName, INSTANCE_PAYLOAD.siteName)
    assert.equal(r.body().data.timezone, INSTANCE_PAYLOAD.timezone)
    assert.equal(await SystemSetting.get('site_name'), INSTANCE_PAYLOAD.siteName)
    assert.equal(await SystemSetting.get('timezone'), INSTANCE_PAYLOAD.timezone)
  })
})

test.group('setup wizard | collector probe', (group) => {
  let fetchMock: ReturnType<typeof mockFetch>

  group.each.setup(resetDb)
  group.each.setup(() => {
    fetchMock = mockFetch()
    return () => fetchMock.restore()
  })

  async function adminTokenFor(client: any) {
    const r = await client.post('/api/v1/setup/admin').json(ADMIN_PAYLOAD)
    return r.body().data.token as string
  }

  test('reachable collector → ok=true, persisted, setupComplete=true', async ({
    client,
    assert,
  }) => {
    fetchMock.set(
      async () =>
        new Response(
          JSON.stringify({
            summary: { total_devices: 7 },
            meta: { capture_interface: 'br-lan' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    )
    const token = await adminTokenFor(client)
    await client.post('/api/v1/setup/instance').bearerToken(token).json(INSTANCE_PAYLOAD)

    const r = await client
      .post('/api/v1/setup/collector')
      .bearerToken(token)
      .json(COLLECTOR_PAYLOAD)

    r.assertStatus(200)
    const { probe, collector, setupComplete } = r.body().data
    assert.isTrue(probe.ok)
    assert.equal(probe.totalDevices, 7)
    assert.equal(probe.captureInterface, 'br-lan')
    assert.equal(collector.baseUrl, COLLECTOR_PAYLOAD.baseUrl)
    assert.isFalse(collector.hasApiKey)
    assert.isTrue(setupComplete)

    const stored = await Collector.firstOrFail()
    assert.equal(stored.baseUrl, COLLECTOR_PAYLOAD.baseUrl)
    assert.equal(stored.lastStatus?.ok, true)
    assert.equal(stored.lastStatus?.totalDevices, 7)
  })

  test('unreachable collector → ok=false, row still persisted', async ({ client, assert }) => {
    fetchMock.set(async () => {
      throw new TypeError('fetch failed')
    })
    const token = await adminTokenFor(client)
    await client.post('/api/v1/setup/instance').bearerToken(token).json(INSTANCE_PAYLOAD)

    const r = await client
      .post('/api/v1/setup/collector')
      .bearerToken(token)
      .json(COLLECTOR_PAYLOAD)

    r.assertStatus(200)
    const { probe, setupComplete } = r.body().data
    assert.isFalse(probe.ok)
    assert.isString(probe.error)
    assert.match(probe.error as string, /fetch failed/)
    assert.isTrue(setupComplete) // having a row is what flips this
    const stored = await Collector.firstOrFail()
    assert.equal(stored.lastStatus?.ok, false)
  })

  test('api_key is sent on probe, encrypted at rest, never echoed', async ({ client, assert }) => {
    fetchMock.set(async (_url, init) => {
      const headers = new Headers(init?.headers ?? {})
      assert.equal(headers.get('authorization'), 'Bearer super-secret-key')
      return new Response(JSON.stringify({ summary: {}, meta: {} }), { status: 200 })
    })
    const token = await adminTokenFor(client)
    await client.post('/api/v1/setup/instance').bearerToken(token).json(INSTANCE_PAYLOAD)

    const r = await client
      .post('/api/v1/setup/collector')
      .bearerToken(token)
      .json({ ...COLLECTOR_PAYLOAD, apiKey: 'super-secret-key' })

    r.assertStatus(200)
    const collector = r.body().data.collector
    assert.isTrue(collector.hasApiKey)
    assert.notProperty(collector, 'apiKey') // never echoed in the wire shape

    // Model accessor decrypts transparently; row in DB is ciphertext we
    // can't trivially assert here without reaching past the consume hook.
    const stored = await Collector.firstOrFail()
    assert.equal(stored.apiKey, 'super-secret-key')
  })
})

test.group('setup wizard | controller first', (group) => {
  let fetchMock: ReturnType<typeof mockFetch>

  group.each.setup(resetDb)
  group.each.setup(() => {
    _resetAnnounceState()
    fetchMock = mockFetch()
    fetchMock.set(
      async () =>
        new Response(JSON.stringify({ summary: { total_devices: 3 }, meta: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    )
    return () => fetchMock.restore()
  })

  async function tokenAtCollectorStep(client: any): Promise<string> {
    const admin = await client.post('/api/v1/setup/admin').json(ADMIN_PAYLOAD)
    const token = admin.body().data.token as string
    await client.post('/api/v1/setup/instance').bearerToken(token).json(INSTANCE_PAYLOAD)
    return token
  }

  test('skipping the collector step completes setup and opens the API', async ({
    client,
    assert,
  }) => {
    const token = await tokenAtCollectorStep(client)
    const gated = await client.get('/api/v1/collectors').bearerToken(token)
    gated.assertStatus(503)

    const skip = await client.post('/api/v1/setup/collector/skip').bearerToken(token)
    skip.assertStatus(200)
    assert.isTrue(skip.body().data.setupComplete)

    const status = await client.get('/api/v1/setup/status')
    assert.equal(status.body().data.step, 'complete')
    assert.isFalse(status.body().data.hasCollector)
    assert.isTrue(status.body().data.collectorsDeferred)

    const open = await client.get('/api/v1/collectors').bearerToken(token)
    open.assertStatus(200)
    assert.deepEqual(open.body().data, [])
    assert.lengthOf(await Collector.all(), 0)
  })

  test('a router that announced before setup is a candidate, and adopting it completes setup', async ({
    client,
    assert,
  }) => {
    const announce = await client.post('/api/v1/collectors/announce').json({
      instanceId: 'wizard-router-0001',
      hostname: 'OpenWrt',
      version: '0.1.0',
      captureInterface: 'br-lan',
      port: 9800,
      tls: false,
      apiKey: 'router-key-123456',
    })
    announce.assertStatus(200)

    const token = await tokenAtCollectorStep(client)
    const list = await client.get('/api/v1/setup/collector/candidates').bearerToken(token)
    list.assertStatus(200)
    const { candidates, discoveryEnabled } = list.body().data
    assert.isTrue(discoveryEnabled)
    assert.lengthOf(candidates, 1)
    assert.equal(candidates[0].hostname, 'OpenWrt')
    assert.equal(candidates[0].lifecycle, 'pending')
    assert.equal(candidates[0].apiKeyFingerprint, apiKeyFingerprint('router-key-123456'))
    assert.notProperty(candidates[0], 'apiKey')

    const adopt = await client
      .post(`/api/v1/setup/collector/${candidates[0].id}/adopt`)
      .bearerToken(token)
      .json({ name: 'gateway' })
    adopt.assertStatus(200)
    const { collector, probe, setupComplete } = adopt.body().data
    assert.isTrue(setupComplete)
    assert.isTrue(probe.ok)
    assert.equal(collector.name, 'gateway')
    assert.equal(collector.lifecycle, 'adopted')
    assert.isTrue(collector.enabled)

    const status = await client.get('/api/v1/setup/status')
    assert.equal(status.body().data.step, 'complete')
    assert.isFalse(status.body().data.collectorsDeferred)
    const after = await client.get('/api/v1/setup/collector/candidates').bearerToken(token)
    assert.lengthOf(after.body().data.candidates, 0)
  })

  test('the wizard collector endpoints need the admin token', async ({ client }) => {
    await client.post('/api/v1/setup/admin').json(ADMIN_PAYLOAD)
    const list = await client.get('/api/v1/setup/collector/candidates')
    list.assertStatus(401)
    const skip = await client.post('/api/v1/setup/collector/skip')
    skip.assertStatus(401)
    const adopt = await client.post('/api/v1/setup/collector/1/adopt').json({})
    adopt.assertStatus(401)

    const viewer = await User.create({
      fullName: 'Viewer',
      email: 'viewer@example.com',
      password: 'viewer-pass-123',
      role: 'operator',
    })
    const viewerToken = await User.accessTokens.create(viewer)
    const forbidden = await client
      .get('/api/v1/setup/collector/candidates')
      .bearerToken(viewerToken.value!.release())
    forbidden.assertStatus(403)
  })

  test('adopt refuses an unknown id, an adopted collector, and a mismatched key', async ({
    client,
  }) => {
    const token = await tokenAtCollectorStep(client)

    const unknown = await client
      .post('/api/v1/setup/collector/9999/adopt')
      .bearerToken(token)
      .json({})
    unknown.assertStatus(404)
    unknown.assertBodyContains({ error: 'collector_not_found' })

    const adopted = await Collector.create({
      name: 'already',
      baseUrl: 'http://192.168.1.2:9800',
      pollIntervalSeconds: 5,
      enabled: true,
      lifecycle: 'adopted',
      source: 'manual',
    })
    const again = await client
      .post(`/api/v1/setup/collector/${adopted.id}/adopt`)
      .bearerToken(token)
      .json({})
    again.assertStatus(422)
    again.assertBodyContains({ error: 'collector_not_pending' })

    const pending = await Collector.create({
      name: 'router',
      baseUrl: 'http://192.168.1.1:9800',
      pollIntervalSeconds: 5,
      enabled: false,
      lifecycle: 'pending',
      source: 'announced',
      apiKeyFingerprint: apiKeyFingerprint('the-announced-key'),
    })
    const mismatch = await client
      .post(`/api/v1/setup/collector/${pending.id}/adopt`)
      .bearerToken(token)
      .json({ apiKey: 'some-other-key' })
    mismatch.assertStatus(422)
    mismatch.assertBodyContains({ error: 'collector_api_key_mismatch' })
  })
})

/**
 * Resume after a lost session (lab walkthrough 2026-09-23, finding 1): the
 * step-1 admin signs in again through `setup/login`. Nobody else can: the
 * route wants the admin's own credentials, is rate-limited, and closes once
 * setup is complete.
 */
test.group('setup wizard | resume with the step-1 credentials', (group) => {
  group.each.setup(resetDb)
  group.each.setup(() => _resetSetupLoginRateLimits())

  const LOGIN = { email: ADMIN_PAYLOAD.email, password: ADMIN_PAYLOAD.password }

  test('a dropped token is recovered by signing in, and setup can finish', async ({
    client,
    assert,
  }) => {
    // Step 1, then the token is lost (tab closed, other browser).
    const created = await client.post('/api/v1/setup/admin').json(ADMIN_PAYLOAD)
    created.assertStatus(200)

    // The normal login stays behind the setup gate.
    const gated = await client.post('/api/v1/auth/login').json(LOGIN)
    gated.assertStatus(503)
    gated.assertBodyContains({ error: 'setup_required', step: 'instance' })

    const login = await client.post('/api/v1/setup/login').json(LOGIN)
    login.assertStatus(200)
    const { token, user } = login.body().data
    assert.isString(token)
    assert.equal(user.email, ADMIN_PAYLOAD.email)
    assert.equal(user.role, 'admin')
    assert.notProperty(user, 'password')

    const inst = await client
      .post('/api/v1/setup/instance')
      .bearerToken(token)
      .json(INSTANCE_PAYLOAD)
    inst.assertStatus(200)

    // Lost again at step 3: sign in again, skip the collector, done.
    const again = await client.post('/api/v1/setup/login').json(LOGIN)
    again.assertStatus(200)
    const skip = await client
      .post('/api/v1/setup/collector/skip')
      .bearerToken(again.body().data.token)
    skip.assertStatus(200)
    assert.isTrue(skip.body().data.setupComplete)

    // From here on it is the ordinary login's job.
    const closed = await client.post('/api/v1/setup/login').json(LOGIN)
    closed.assertStatus(409)
    closed.assertBodyContains({ error: 'setup_complete' })
    const normal = await client.post('/api/v1/auth/login').json(LOGIN)
    normal.assertStatus(200)
  })

  test('refused before step 1: there is nobody to sign in as', async ({ client, assert }) => {
    const r = await client.post('/api/v1/setup/login').json(LOGIN)
    r.assertStatus(409)
    r.assertBodyContains({ error: 'admin_missing' })
    assert.lengthOf(await User.all(), 0)
  })

  test('wrong password and unknown e-mail get the same 401', async ({ client, assert }) => {
    await client.post('/api/v1/setup/admin').json(ADMIN_PAYLOAD)

    const wrongPassword = await client
      .post('/api/v1/setup/login')
      .json({ ...LOGIN, password: 'not-the-password' })
    wrongPassword.assertStatus(401)
    const unknownEmail = await client
      .post('/api/v1/setup/login')
      .json({ ...LOGIN, email: 'someone@example.com' })
    unknownEmail.assertStatus(401)
    assert.deepEqual(wrongPassword.body(), unknownEmail.body())
    assert.equal(wrongPassword.body().error, 'invalid_credentials')
    assert.notProperty(wrongPassword.body(), 'token')
  })

  test('a non-admin account cannot continue the wizard', async ({ client }) => {
    await client.post('/api/v1/setup/admin').json(ADMIN_PAYLOAD)
    await User.create({
      fullName: 'Viewer',
      email: 'viewer@example.com',
      password: 'viewer-pass-123',
      role: 'viewer',
    })
    const r = await client
      .post('/api/v1/setup/login')
      .json({ email: 'viewer@example.com', password: 'viewer-pass-123' })
    r.assertStatus(401)
    r.assertBodyContains({ error: 'invalid_credentials' })
  })

  test('someone racing the owner cannot take over or finish setup', async ({ client, assert }) => {
    await client.post('/api/v1/setup/admin').json(ADMIN_PAYLOAD)

    // A second step 1 is refused: the first admin owns the instance.
    const second = await client.post('/api/v1/setup/admin').json({
      ...ADMIN_PAYLOAD,
      email: 'intruder@example.com',
    })
    second.assertStatus(409)
    assert.lengthOf(await User.query().where('role', 'admin'), 1)

    // Without the admin's token nothing moves.
    const inst = await client.post('/api/v1/setup/instance').json(INSTANCE_PAYLOAD)
    inst.assertStatus(401)
    const skip = await client.post('/api/v1/setup/collector/skip')
    skip.assertStatus(401)
    const forged = await client
      .post('/api/v1/setup/instance')
      .bearerToken('oat_bm90LWEtdG9rZW4.bm90LWEtdG9rZW4')
      .json(INSTANCE_PAYLOAD)
    forged.assertStatus(401)
    const status = await client.get('/api/v1/setup/status')
    assert.equal(status.body().data.step, 'instance')
    assert.isFalse(status.body().data.hasInstance)
  })

  test('repeated failures from one address are throttled, even with the right password', async ({
    client,
    assert,
  }) => {
    await client.post('/api/v1/setup/admin').json(ADMIN_PAYLOAD)
    for (let i = 0; i < SETUP_LOGIN_FAILURE_LIMIT; i++) {
      const r = await client
        .post('/api/v1/setup/login')
        .json({ ...LOGIN, password: `guess-${i}-xxxx` })
      r.assertStatus(401)
    }
    const blocked = await client.post('/api/v1/setup/login').json(LOGIN)
    blocked.assertStatus(429)
    blocked.assertBodyContains({ error: 'rate_limited' })
    assert.isAbove(Number(blocked.header('retry-after')), 0)
    assert.isAbove(blocked.body().retryAfterSeconds, 0)

    _resetSetupLoginRateLimits()
    const ok = await client.post('/api/v1/setup/login').json(LOGIN)
    ok.assertStatus(200)
  })

  test('a malformed body counts as a failure', async ({ client }) => {
    await client.post('/api/v1/setup/admin').json(ADMIN_PAYLOAD)
    for (let i = 0; i < SETUP_LOGIN_FAILURE_LIMIT; i++) {
      const r = await client.post('/api/v1/setup/login').json({ email: 'not-an-email' })
      r.assertStatus(422)
    }
    const blocked = await client.post('/api/v1/setup/login').json(LOGIN)
    blocked.assertStatus(429)
  })
})

test.group('version', (group) => {
  group.each.setup(resetDb)

  test('GET /api/v1/version answers before setup, with the paired daemon releases', async ({
    client,
    assert,
  }) => {
    const r = await client.get('/api/v1/version')
    r.assertStatus(200)
    const data = r.body().data
    assert.match(data.version, /^\d+\.\d+\.\d+/)
    assert.isString(data.apdVersion)
    assert.isString(data.collectorVersion)
    assert.equal(
      data.apdReleaseUrl,
      `https://github.com/capthndsme/perch-apd/releases/download/v${data.apdVersion}`
    )
    assert.equal(
      data.collectorReleaseUrl,
      `https://github.com/capthndsme/perch-collector/releases/download/v${data.collectorVersion}`
    )
  })
})
