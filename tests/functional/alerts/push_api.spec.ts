import AlertDelivery from '#models/alert_delivery'
import AlertPushSubscription from '#models/alert_push_subscription'
import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import { fakeAlertClock } from '#services/alerts/clock'
import { _resetDeliveryTests, sendTestDelivery } from '#services/alerts/delivery_worker'
import { PUSH_FILTER_DEFAULTS } from '#services/alerts/filters'
import { newMessageId } from '#services/alerts/routing'
import { _setPushAgent, pushPayload, pushSender } from '#services/alerts/push/push_sender'
import { pushServiceOf } from '#services/alerts/push/push_services'
import { _resetRenewLimits, endpointHash } from '#services/alerts/push/subscriptions'
import { vapidKeys } from '#services/alerts/push/vapid'
import type { RenderedMessage } from '#services/alerts/senders'
import { ALERTS_DEFAULTS, saveAlertsSettings } from '#services/alerts/settings'
import { apiLoose, resetAlertEngineState, truncateAllTables } from '#tests/helpers/alerts'
import type { ApiClient, ApiResponse } from '@japa/api-client'
import { test } from '@japa/runner'
import { execFileSync } from 'node:child_process'
import { createECDH, createDecipheriv, hkdfSync, randomBytes, type ECDH } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { Agent, createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * WP-A3 (docs/design/alerts/api.md §3.4, delivery.md §1): VAPID keys, the
 * subscription endpoints, renew, rotation, and the sender against a local
 * HTTPS "push service" that decrypts what it receives (RFC 8291 aes128gcm)
 * with the browser-side keys, so the whole encryption path is checked.
 */

const BASE = '/api/v1/alerts/push'
const FCM = 'https://fcm.googleapis.com/fcm/send/'

/** A browser's subscription keys: P-256 key pair + 16-byte auth secret. */
function browserKeys() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = randomBytes(16)
  return {
    ecdh,
    auth,
    json: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: auth.toString('base64url'),
    },
  }
}

/** RFC 8291 + RFC 8188, one record: what the browser does with a push. */
function decryptPush(body: Buffer, ecdh: ECDH, auth: Buffer): string {
  const salt = body.subarray(0, 16)
  const idlen = body[20]
  const asPublic = body.subarray(21, 21 + idlen)
  const ciphertext = body.subarray(21 + idlen)
  const shared = ecdh.computeSecret(asPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, keyInfo, 32))
  const cek = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  )
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)
  )
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
  const plain = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ])
  let end = plain.length - 1
  while (end > 0 && plain[end] === 0) end--
  if (plain[end] !== 2) throw new Error('missing last-record delimiter')
  return plain.subarray(0, end).toString('utf8')
}

type Received = {
  path: string
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

/** A local HTTPS server with a throwaway certificate, answering from a script. */
async function fakePushService(
  answers: Array<{ status: number; headers?: Record<string, string> }>
) {
  const dir = mkdtempSync(join(tmpdir(), 'perch-push-'))
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-subj',
      '/CN=localhost',
      '-days',
      '1',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
    ],
    { stdio: 'ignore' }
  )
  const received: Received[] = []
  const server: Server = createServer(
    { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) },
    (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        received.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) })
        const answer = answers.shift() ?? { status: 201 }
        res.writeHead(answer.status, answer.headers ?? {})
        res.end()
      })
    }
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const agent = new Agent({ rejectUnauthorized: false })
  _setPushAgent(agent)
  return {
    received,
    endpoint: (id: string) => `https://127.0.0.1:${port}/push/${id}`,
    async close() {
      _setPushAgent(null)
      agent.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Awaits a request and checks its status (no member access on an await expression). */
async function expectStatus(request: PromiseLike<ApiResponse>, status: number) {
  const response = await request
  response.assertStatus(status)
  return response
}

async function pushConfig(client: ApiClient, token: string) {
  const response = await apiLoose(client).get(`${BASE}/config`).bearerToken(token)
  return response.body().data
}

async function seed() {
  const admin = await User.create({
    fullName: 'Admin',
    email: 'admin@example.com',
    password: 'admin-pass-123',
    role: 'admin',
  })
  const operator = await User.create({
    fullName: 'Operator',
    email: 'operator@example.com',
    password: 'operator-pass-123',
    role: 'operator',
  })
  await SystemSetting.set('site_name', 'Home')
  await SystemSetting.set('timezone', 'Asia/Manila')
  // Setup is complete once an admin and a collector exist (the /api/v1 gate).
  await Collector.create({
    name: 'localhost',
    baseUrl: 'http://127.0.0.1:9800',
    pollIntervalSeconds: 15,
    enabled: true,
    apiKey: null,
    lastStatus: null,
  })
  const adminAccess = await User.accessTokens.create(admin)
  const operatorAccess = await User.accessTokens.create(operator)
  return {
    admin,
    operator,
    adminToken: adminAccess.value!.release(),
    operatorToken: operatorAccess.value!.release(),
  }
}

/** A subscription row made directly (the local endpoint is not on the allowlist). */
async function localSubscription(
  userId: number,
  endpoint: string,
  keys: ReturnType<typeof browserKeys>
) {
  const { keyId } = await vapidKeys()
  return AlertPushSubscription.create({
    userId,
    endpoint,
    endpointHash: endpointHash(endpoint),
    pushService: 'other',
    p256dh: keys.json.p256dh,
    auth: keys.json.auth,
    vapidKeyId: keyId,
    expirationAt: null,
    label: 'Test phone',
    platform: null,
    filters: { ...PUSH_FILTER_DEFAULTS },
    enabled: true,
    state: 'active',
    consecutiveFailures: 0,
    renewTokenHash: null,
  })
}

function message(overrides: Partial<RenderedMessage> = {}): RenderedMessage {
  return {
    deliveryId: 7,
    transition: 'opened',
    severity: 'warning',
    title: 'Garage AP is offline',
    body: 'No report for 2 min (since 14:02). 4 clients were on it.',
    path: '/alerts/812',
    url: 'https://perch.example.com/alerts/812',
    alert: {
      id: 812,
      type: 'ap.offline',
      category: 'agents',
      kind: 'condition',
      state: 'active',
      severity: 'warning',
      flapping: false,
      subject: { kind: 'ap', ref: '4', label: 'Garage AP' },
      firstRaisedAt: '2026-10-01T06:02:05Z',
      openedAt: '2026-10-01T06:03:05Z',
      resolvedAt: null,
      eventCount: 1,
      url: 'https://perch.example.com/alerts/812',
      data: null,
    },
    items: null,
    event: 'ap.offline',
    badge: 2,
    redacted: false,
    instance: { name: 'Home', url: 'https://perch.example.com', controllerVersion: '1.1.0' },
    ...overrides,
  }
}

async function deliveryFor(sub: AlertPushSubscription, now = fakeNow()) {
  return AlertDelivery.create({
    alertId: null,
    destinationKind: 'push',
    pushSubscriptionId: sub.id,
    webhookId: null,
    transition: 'opened',
    status: 'sending',
    holdReason: null,
    groupKey: null,
    items: null,
    messageId: newMessageId(now),
    severity: 'warning',
    attempts: 1,
    sendAfter: now,
    nextAttemptAt: null,
    expiresAt: now.plus({ minutes: 720 }),
    lastStatusCode: null,
    lastError: null,
    sentAt: null,
    createdAt: now,
  })
}

let clock: ReturnType<typeof fakeAlertClock>
const fakeNow = () => clock.now()

test.group('alerts push API', (group) => {
  group.each.setup(async () => {
    await truncateAllTables()
    await resetAlertEngineState()
    _resetDeliveryTests()
    _resetRenewLimits()
    clock = fakeAlertClock('2026-10-01T06:00:00Z')
    return async () => {
      clock.restore()
      await resetAlertEngineState()
    }
  })

  test('push services: the allowlist and what is never an endpoint', ({ assert }) => {
    assert.equal(pushServiceOf(`${FCM}abc`), 'fcm')
    assert.equal(pushServiceOf('https://updates.push.services.mozilla.com/wpush/v2/x'), 'mozilla')
    assert.equal(pushServiceOf('https://web.push.apple.com/QGx'), 'apple')
    assert.equal(pushServiceOf('https://wns2-par02p.notify.windows.com/w/?token=x'), 'wns')
    assert.equal(pushServiceOf('https://push.example.com/x'), 'other')
    assert.isNull(pushServiceOf('http://fcm.googleapis.com/fcm/send/x'))
    assert.isNull(pushServiceOf('https://192.168.1.10/push'))
    assert.isNull(pushServiceOf('https://[::1]/push'))
    assert.isNull(pushServiceOf('https://fcm.googleapis.com:8443/x'))
    assert.isNull(pushServiceOf('https://user:pw@fcm.googleapis.com/x'))
  })

  test('config: one key pair even under concurrent first calls; any user', async ({
    client,
    assert,
  }) => {
    const { operatorToken } = await seed()
    const answers = await Promise.all(
      [1, 2, 3].map(() => apiLoose(client).get(`${BASE}/config`).bearerToken(operatorToken))
    )
    for (const r of answers) r.assertStatus(200)
    const keyIds = new Set(answers.map((r) => r.body().data.vapidKeyId))
    assert.equal(keyIds.size, 1)
    const data = answers[0].body().data
    assert.match(data.vapidKeyId, /^v1-[0-9a-f]{8}$/)
    assert.lengthOf(Buffer.from(data.vapidPublicKey, 'base64url'), 65)
    assert.isTrue(data.available)
    assert.isNull(data.reason)
    assert.deepEqual(data.allowedServices, ['fcm', 'mozilla', 'apple', 'wns'])
    const stored = await SystemSetting.get<Record<string, string>>('alerts_vapid')
    assert.notProperty(stored!, 'privateKey')
    assert.match(stored!.privateKeyEncrypted, /\S/)
  })

  test('subscribe: 201, then 200 with a fresh renew token; filters and platform', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seed()
    const config = await pushConfig(client, adminToken)
    const keys = browserKeys()
    const body = {
      subscription: { endpoint: `${FCM}abc`, expirationTime: null, keys: keys.json },
      vapidKeyId: config.vapidKeyId,
      label: 'Pixel 8',
      filters: { minSeverity: 'critical' },
    }
    const ua =
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36'
    const first = await apiLoose(client)
      .post(`${BASE}/subscriptions`)
      .header('User-Agent', ua)
      .bearerToken(adminToken)
      .json(body)
    first.assertStatus(201)
    const created = first.body().data
    assert.match(created.renewToken, /^pr_[A-Za-z0-9_-]{43}$/)
    assert.equal(created.subscription.endpointHash, endpointHash(`${FCM}abc`))
    assert.equal(created.subscription.pushService, 'fcm')
    assert.equal(created.subscription.platform, 'Chrome on Android')
    assert.equal(created.subscription.label, 'Pixel 8')
    assert.deepEqual(created.subscription.filters, {
      minSeverity: 'critical',
      categories: null,
      types: null,
      quietHours: 'inherit',
    })
    assert.notProperty(created.subscription, 'endpoint')
    assert.notProperty(created.subscription, 'p256dh')

    const again = await apiLoose(client)
      .post(`${BASE}/subscriptions`)
      .bearerToken(adminToken)
      .json({ ...body, label: undefined, filters: { quietHours: 'ignore' } })
    again.assertStatus(200)
    const refreshed = again.body().data
    assert.equal(refreshed.subscription.id, created.subscription.id)
    assert.notEqual(refreshed.renewToken, created.renewToken)
    assert.equal(refreshed.subscription.label, 'Pixel 8')
    assert.equal(refreshed.subscription.filters.minSeverity, 'critical')
    assert.equal(refreshed.subscription.filters.quietHours, 'ignore')
    assert.lengthOf(await AlertPushSubscription.all(), 1)
  })

  test('subscribe: allowlist, keys, key id and the endpoint moving to another user', async ({
    client,
    assert,
  }) => {
    const { admin, adminToken, operator, operatorToken } = await seed()
    const config = await pushConfig(client, adminToken)
    const keys = browserKeys()
    const post = (token: string, endpoint: string, extra: Record<string, unknown> = {}) =>
      apiLoose(client)
        .post(`${BASE}/subscriptions`)
        .bearerToken(token)
        .json({
          subscription: { endpoint, expirationTime: null, keys: keys.json },
          vapidKeyId: config.vapidKeyId,
          ...extra,
        })

    const other = await post(adminToken, 'https://push.example.com/x')
    other.assertStatus(422)
    other.assertBodyContains({ error: 'push_service_not_allowed' })
    const literal = await post(adminToken, 'https://10.0.0.5/push')
    literal.assertStatus(422)
    assert.equal(literal.body().errors[0].field, 'subscription.endpoint')
    const badKey = await apiLoose(client)
      .post(`${BASE}/subscriptions`)
      .bearerToken(adminToken)
      .json({
        subscription: {
          endpoint: `${FCM}x`,
          keys: { p256dh: Buffer.alloc(65, 3).toString('base64url'), auth: keys.json.auth },
        },
        vapidKeyId: config.vapidKeyId,
      })
    badKey.assertStatus(422)
    assert.equal(badKey.body().errors[0].field, 'subscription.keys.p256dh')
    const stale = await post(adminToken, `${FCM}x`, { vapidKeyId: 'v1-00000000' })
    stale.assertStatus(409)
    stale.assertBodyContains({ error: 'vapid_key_mismatch' })

    await saveAlertsSettings({ ...structuredClone(ALERTS_DEFAULTS), allowAnyPushService: true })
    await expectStatus(post(adminToken, 'https://push.example.com/x'), 201)

    // One browser, one subscription: signing in as someone else there moves it.
    await expectStatus(post(adminToken, `${FCM}shared`), 201)
    const moved = await post(operatorToken, `${FCM}shared`)
    moved.assertStatus(200)
    assert.equal(moved.body().data.subscription.userId, operator.id)
    const adminRows = await AlertPushSubscription.query().where('user_id', admin.id)
    assert.lengthOf(adminRows, 1)
  })

  test('list, patch, delete: owner or admin; ?all=1 for admins', async ({ client, assert }) => {
    const { admin, operator, adminToken, operatorToken } = await seed()
    const keys = browserKeys()
    const mine = await localSubscription(operator.id, `${FCM}op`, keys)
    const theirs = await localSubscription(admin.id, `${FCM}ad`, keys)

    const list = await apiLoose(client).get(`${BASE}/subscriptions`).bearerToken(operatorToken)
    list.assertStatus(200)
    assert.deepEqual(
      list.body().data.map((s: { id: number }) => s.id),
      [mine.id]
    )
    await expectStatus(
      apiLoose(client).get(`${BASE}/subscriptions?all=1`).bearerToken(operatorToken),
      403
    )
    const all = await apiLoose(client).get(`${BASE}/subscriptions?all=1`).bearerToken(adminToken)
    assert.lengthOf(all.body().data, 2)

    const patch = await apiLoose(client)
      .patch(`${BASE}/subscriptions/${mine.id}`)
      .bearerToken(operatorToken)
      .json({ label: 'Work phone', enabled: false, filters: { categories: ['wan'] } })
    patch.assertStatus(200)
    assert.equal(patch.body().data.label, 'Work phone')
    assert.isFalse(patch.body().data.enabled)
    assert.deepEqual(patch.body().data.filters.categories, ['wan'])
    assert.equal(patch.body().data.filters.minSeverity, 'warning')

    const forbidden = await apiLoose(client)
      .patch(`${BASE}/subscriptions/${theirs.id}`)
      .bearerToken(operatorToken)
      .json({ label: 'x' })
    forbidden.assertStatus(403)
    forbidden.assertBodyContains({ error: 'not_owner' })
    await expectStatus(
      apiLoose(client).delete(`${BASE}/subscriptions/999`).bearerToken(adminToken),
      404
    )
    await expectStatus(
      apiLoose(client).delete(`${BASE}/subscriptions/${mine.id}`).bearerToken(adminToken),
      204
    )

    // Unsubscribe by endpoint: 204 whether or not anything matched.
    const un = await apiLoose(client)
      .post(`${BASE}/subscriptions/unsubscribe`)
      .bearerToken(operatorToken)
      .json({ endpoint: `${FCM}ad` })
    un.assertStatus(204)
    assert.isNotNull(await AlertPushSubscription.find(theirs.id)) // not the operator's
    await expectStatus(
      apiLoose(client)
        .post(`${BASE}/subscriptions/unsubscribe`)
        .bearerToken(adminToken)
        .json({ endpoint: `${FCM}ad` }),
      204
    )
    assert.isNull(await AlertPushSubscription.find(theirs.id))
  })

  test('renew: the token is the credential; rows move to the new endpoint; rate limit', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seed()
    const config = await pushConfig(client, adminToken)
    const keys = browserKeys()
    const sub = await apiLoose(client)
      .post(`${BASE}/subscriptions`)
      .bearerToken(adminToken)
      .json({
        subscription: { endpoint: `${FCM}old`, keys: keys.json },
        vapidKeyId: config.vapidKeyId,
        label: 'Laptop',
      })
    const token = sub.body().data.renewToken
    const next = browserKeys()
    const renew = (renewToken: string) =>
      apiLoose(client)
        .post(`${BASE}/renew`)
        .json({
          oldEndpoint: `${FCM}old`,
          renewToken,
          subscription: { endpoint: `${FCM}new`, keys: next.json },
        })

    const denied = await renew('pr_wrong')
    denied.assertStatus(401)
    denied.assertBodyContains({ error: 'renew_denied' })
    const ok = await renew(token)
    ok.assertStatus(200)
    assert.match(ok.body().data.renewToken, /^pr_/)
    const row = await AlertPushSubscription.findByOrFail('endpointHash', endpointHash(`${FCM}new`))
    assert.equal(row.label, 'Laptop')
    assert.equal(row.p256dh, next.json.p256dh)
    assert.isNull(await AlertPushSubscription.findBy('endpointHash', endpointHash(`${FCM}old`)))
    // The old token is spent.
    await expectStatus(renew(token), 401)

    for (let i = 0; i < 7; i++) await renew('pr_wrong')
    const limited = await renew('pr_wrong')
    limited.assertStatus(429)
    limited.assertBodyContains({ error: 'renew_rate_limited' })
    assert.isAtLeast(Number(limited.header('retry-after')), 1)
  })

  test('rotate: confirm string, new key, every subscription gone, old key id refused', async ({
    client,
    assert,
  }) => {
    const { admin, adminToken, operatorToken } = await seed()
    const before = await vapidKeys()
    await localSubscription(admin.id, `${FCM}a`, browserKeys())
    await expectStatus(
      apiLoose(client)
        .post('/api/v1/settings/alerts/vapid/rotate')
        .bearerToken(operatorToken)
        .json({ confirm: 'rotate' }),
      403
    )
    await expectStatus(
      apiLoose(client)
        .post('/api/v1/settings/alerts/vapid/rotate')
        .bearerToken(adminToken)
        .json({}),
      422
    )
    const r = await apiLoose(client)
      .post('/api/v1/settings/alerts/vapid/rotate')
      .bearerToken(adminToken)
      .json({ confirm: 'rotate' })
    r.assertStatus(200)
    assert.notEqual(r.body().data.keyId, before.keyId)
    assert.equal(r.body().data.invalidated, 1)
    const row = await AlertPushSubscription.query().firstOrFail()
    assert.equal(row.state, 'gone')
    assert.equal(row.lastError, 'VAPID key rotated')
    const config = await pushConfig(client, adminToken)
    assert.equal(config.vapidKeyId, r.body().data.keyId)
    const settings = await apiLoose(client).get('/api/v1/settings/alerts').bearerToken(adminToken)
    assert.equal(settings.body().data.vapid.keyId, r.body().data.keyId)
    assert.isTrue(settings.body().data.vapid.readable)
  })

  test('payload: tag, renotify, path, trimming to 3000 bytes', ({ assert }) => {
    const opened = pushPayload(message())
    assert.deepInclude(opened, {
      v: 1,
      id: 812,
      url: '/alerts/812',
      tag: 'alert-812',
      renotify: true,
      severity: 'warning',
      transition: 'opened',
      badge: 2,
    })
    assert.isFalse(pushPayload(message({ transition: 'resolved' })).renotify)
    const grouped = pushPayload(message({ alert: null, path: '/alerts', event: 'group' }))
    assert.equal(grouped.tag, 'group-7')
    assert.isNull(grouped.id)
    assert.equal(pushPayload(message({ transition: 'test', alert: null })).tag, 'perch-test')
    const long = pushPayload(message({ title: 'x'.repeat(500), body: 'y'.repeat(5000) }))
    assert.lengthOf(long.title, 120)
    assert.lengthOf(long.body, 400)
    const huge = pushPayload(
      message({ title: '€'.repeat(120), body: '€'.repeat(400), path: `/${'p'.repeat(1900)}` })
    )
    assert.equal(huge.body, '')
    assert.isAtMost(Buffer.byteLength(JSON.stringify(huge)), 3000)
  })

  test('sender: an encrypted push the browser keys can read, with VAPID, TTL, urgency, topic', async ({
    client,
    assert,
  }) => {
    const { admin, adminToken } = await seed()
    const service = await fakePushService([{ status: 201 }])
    try {
      const keys = browserKeys()
      const sub = await localSubscription(admin.id, service.endpoint('a'), keys)
      const delivery = await deliveryFor(sub)
      const result = await pushSender.send({ delivery, message: message(), destination: sub })
      assert.equal(result.outcome, 'sent')
      assert.equal(result.statusCode, 201)

      const [got] = service.received
      assert.equal(got.path, '/push/a')
      assert.equal(got.headers['content-encoding'], 'aes128gcm')
      assert.equal(got.headers['urgency'], 'normal')
      assert.equal(got.headers['topic'], `a${(812).toString(36)}`)
      assert.equal(Number(got.headers['ttl']), 720 * 60)
      const vapid = await vapidKeys()
      assert.match(
        String(got.headers['authorization']),
        new RegExp(`^vapid t=[^,]+, k=${vapid.publicKey}$`)
      )
      const jwt = String(got.headers['authorization']).slice('vapid t='.length).split(',')[0]
      const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())
      assert.equal(claims.aud, service.endpoint('a').replace(/\/push\/a$/, ''))
      assert.equal(claims.sub, 'https://github.com/capthndsme/perch-controller')

      const plain = JSON.parse(decryptPush(got.body, keys.ecdh, keys.auth))
      assert.equal(plain.title, 'Garage AP is offline')
      assert.equal(plain.tag, 'alert-812')
      assert.equal(plain.url, '/alerts/812')

      // The test button: same path, logged as a delivery, answer carries the service.
      const tested = await apiLoose(client)
        .post(`${BASE}/subscriptions/${sub.id}/test`)
        .bearerToken(adminToken)
      tested.assertStatus(200)
      assert.equal(tested.body().data.result.outcome, 'sent')
      assert.equal(tested.body().data.result.pushService, 'other')
      assert.equal(tested.body().data.delivery.transition, 'test')
      const testPush = JSON.parse(decryptPush(service.received[1].body, keys.ecdh, keys.auth))
      assert.equal(testPush.tag, 'perch-test')
      assert.equal(testPush.url, '/settings/notifications')
      const limited = await apiLoose(client)
        .post(`${BASE}/subscriptions/${sub.id}/test`)
        .bearerToken(adminToken)
      limited.assertStatus(429)
      limited.assertBodyContains({ error: 'test_rate_limited' })
    } finally {
      await service.close()
    }
  })

  test('sender: 410 gone, 429 Retry-After, 5xx retry, 403 failing, 413 once more without the body', async ({
    assert,
  }) => {
    const { admin } = await seed()
    const service = await fakePushService([
      { status: 410 },
      { status: 429, headers: { 'Retry-After': '120' } },
      { status: 503 },
      { status: 403 },
      { status: 413 },
      { status: 201 },
    ])
    try {
      const keys = browserKeys()
      const sub = await localSubscription(admin.id, service.endpoint('b'), keys)
      const send = async () =>
        pushSender.send({ delivery: await deliveryFor(sub), message: message(), destination: sub })

      const gone = await send()
      assert.deepInclude(gone, { outcome: 'failed', statusCode: 410, destinationState: 'gone' })
      const limited = await send()
      assert.deepInclude(limited, { outcome: 'retry', statusCode: 429, retryAfterSeconds: 120 })
      assert.deepInclude(await send(), { outcome: 'retry', statusCode: 503 })
      const refused = await send()
      assert.deepInclude(refused, {
        outcome: 'failed',
        statusCode: 403,
        destinationState: 'failing',
      })
      assert.match((refused as { error: string }).error, /VAPID/)

      const big = await send()
      assert.deepInclude(big, { outcome: 'sent', statusCode: 201 })
      const retried = JSON.parse(decryptPush(service.received[5].body, keys.ecdh, keys.auth))
      assert.equal(retried.body, '')
      assert.equal(retried.title, 'Garage AP is offline')
    } finally {
      await service.close()
    }
  })

  test('test button: gone subscription 409; delivery log row; gone on 410', async ({
    client,
    assert,
  }) => {
    const { admin, adminToken } = await seed()
    const service = await fakePushService([{ status: 410 }])
    try {
      const sub = await localSubscription(admin.id, service.endpoint('c'), browserKeys())
      const { delivery, result } = await sendTestDelivery('push', sub)
      assert.equal(result.outcome, 'failed')
      assert.equal(delivery.status, 'failed')
      await sub.refresh()
      assert.equal(sub.state, 'gone')
      const again = await apiLoose(client)
        .post(`${BASE}/subscriptions/${sub.id}/test`)
        .bearerToken(adminToken)
      again.assertStatus(409)
      again.assertBodyContains({ error: 'subscription_gone' })
    } finally {
      await service.close()
    }
  })
})
