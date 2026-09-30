import AlertDelivery from '#models/alert_delivery'
import AlertWebhook from '#models/alert_webhook'
import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import { fakeAlertClock } from '#services/alerts/clock'
import { _resetDeliveryTests, runDeliveryPass } from '#services/alerts/delivery_worker'
import { flushAlertQueue } from '#services/alerts/engine'
import { _resetRoutingState } from '#services/alerts/routing'
import { _setSenders } from '#services/alerts/senders'
import type { RenderedMessage } from '#services/alerts/senders'
import { webhookUrlDisplay } from '#services/alerts/webhooks/destinations'
import { buildWebhookRequest, cutBytes, ntfyTarget } from '#services/alerts/webhooks/formats'
import { retryAfter } from '#services/alerts/webhooks/http'
import { mapWebhookAnswer, webhookSender } from '#services/alerts/webhooks/webhook_sender'
import { apiLoose, resetAlertEngineState, truncateAllTables } from '#tests/helpers/alerts'
import type { ApiResponse } from '@japa/api-client'
import { test } from '@japa/runner'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DateTime } from 'luxon'
import { Webhook } from 'standardwebhooks'

/**
 * WP-A4 (docs/design/alerts/api.md §3.6, delivery.md §2): webhook CRUD with
 * write-only secrets, each format's request, answer mapping, signing checked
 * with the Standard Webhooks library a receiver would use, and one alert from
 * the settings test button to a local receiver through the whole pipeline.
 */

const BASE = '/api/v1/settings/alerts/webhooks'

/** Awaits a request and checks its status (no member access on an await expression). */
async function expectStatus(request: PromiseLike<ApiResponse>, status: number) {
  const response = await request
  response.assertStatus(status)
  return response
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
    adminToken: adminAccess.value!.release(),
    operatorToken: operatorAccess.value!.release(),
  }
}

type Received = { method: string; path: string; headers: Record<string, string>; body: string }

/** A local receiver answering from a script (default 204). */
async function receiver(
  answers: Array<{ status: number; headers?: Record<string, string>; body?: string }> = []
) {
  const received: Received[] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      received.push({
        method: req.method ?? '',
        path: req.url ?? '',
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [
            k,
            Array.isArray(v) ? v.join(',') : (v ?? ''),
          ])
        ),
        body,
      })
      const answer = answers.shift() ?? { status: 204 }
      res.writeHead(answer.status, answer.headers ?? {})
      res.end(answer.body ?? '')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    received,
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function message(overrides: Partial<RenderedMessage> = {}): RenderedMessage {
  return {
    deliveryId: 3,
    transition: 'opened',
    severity: 'critical',
    title: 'WAN <down> & out',
    body: 'wan0 lost carrier at 14:02.',
    path: '/alerts/9',
    url: 'https://perch.example.com/alerts/9',
    alert: null,
    items: null,
    event: 'wan.down',
    badge: 1,
    redacted: false,
    instance: { name: 'Home', url: 'https://perch.example.com', controllerVersion: '1.1.0' },
    ...overrides,
  }
}

const now = new Date('2026-10-01T06:00:00Z')
const build = (
  format: Parameters<typeof buildWebhookRequest>[0]['format'],
  extra: Partial<Parameters<typeof buildWebhookRequest>[0]> = {}
) =>
  buildWebhookRequest({
    format,
    url: 'https://hooks.example.com/services/T0/B0/xyz',
    auth: { type: 'none' },
    options: {},
    secret: null,
    message: message(),
    messageId: 'msg_TEST',
    now,
    ...extra,
  })

test.group('alerts webhooks API', (group) => {
  let clock: ReturnType<typeof fakeAlertClock>

  group.each.setup(async () => {
    await truncateAllTables()
    await resetAlertEngineState()
    _resetRoutingState()
    _resetDeliveryTests()
    // Near real time: receivers (standardwebhooks) refuse timestamps over 5 min off.
    clock = fakeAlertClock(DateTime.utc())
    _setSenders({ webhook: webhookSender })
    return async () => {
      clock.restore()
      _setSenders(null)
      await resetAlertEngineState()
    }
  })

  test('admin only', async ({ client }) => {
    const { operatorToken } = await seed()
    await expectStatus(apiLoose(client).get(BASE).bearerToken(operatorToken), 403)
  })

  test('create standard: the secret once, nothing secret in the view', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seed()
    const r = await apiLoose(client)
      .post(BASE)
      .bearerToken(adminToken)
      .json({
        name: 'Home Assistant',
        format: 'standard',
        preset: 'homeassistant',
        url: 'http://homeassistant.local:8123/api/webhook/perch-3k9s0d2m5q7x1v4b',
        auth: { type: 'bearer', token: 's3cret-token' },
      })
    r.assertStatus(201)
    const { webhook, secret } = r.body().data
    assert.match(secret, /^whsec_[A-Za-z0-9+/]{32}$/)
    assert.deepInclude(webhook, {
      name: 'Home Assistant',
      format: 'standard',
      preset: 'homeassistant',
      signed: true,
      state: 'active',
      detail: 'full',
      enabled: true,
      respectQuietHours: false,
    })
    assert.equal(webhook.urlDisplay, 'http://homeassistant.local:8123/api/webhook/••••')
    assert.deepEqual(webhook.auth, { type: 'bearer' })
    assert.equal(webhook.filters.quietHours, 'ignore')
    const text = JSON.stringify(r.body())
    assert.notInclude(text, 'perch-3k9s0d2m5q7x1v4b')
    assert.notInclude(text, 's3cret-token')
    const row = await AlertWebhook.findOrFail(webhook.id)
    assert.notInclude(row.urlEncrypted, 'perch-3k9s')

    const list = await apiLoose(client).get(BASE).bearerToken(adminToken)
    assert.lengthOf(list.body().data, 1)
    assert.notInclude(JSON.stringify(list.body()), secret)
  })

  test('create: format rules for url, auth and options', async ({ client, assert }) => {
    const { adminToken } = await seed()
    const post = (body: Record<string, unknown>) =>
      apiLoose(client)
        .post(BASE)
        .bearerToken(adminToken)
        .json({ name: 'x', ...body })
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        {
          format: 'telegram',
          auth: { type: 'telegram', botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
        },
        'webhook_options_invalid',
      ],
      [{ format: 'telegram', options: { chatId: '42' } }, 'webhook_auth_invalid'],
      [{ format: 'gotify', url: 'https://gotify.example.com' }, 'webhook_auth_invalid'],
      [
        {
          format: 'discord',
          url: 'https://discord.com/api/webhooks/1/x',
          auth: { type: 'bearer', token: 't' },
        },
        'webhook_auth_invalid',
      ],
      [{ format: 'standard', url: 'https://u:p@example.com/hook' }, 'webhook_url_invalid'],
      [{ format: 'standard', url: 'ftp://example.com/hook' }, 'webhook_url_invalid'],
      [{ format: 'standard' }, 'webhook_url_invalid'],
      [{ format: 'ntfy', url: 'https://ntfy.sh/' }, 'webhook_url_invalid'],
      [
        {
          format: 'standard',
          url: 'https://example.com/h',
          auth: { type: 'header', name: 'Host', value: 'x' },
        },
        'webhook_auth_invalid',
      ],
      [
        {
          format: 'standard',
          url: 'https://example.com/h',
          auth: { type: 'basic', username: 'u' },
        },
        'webhook_auth_invalid',
      ],
      [
        { format: 'discord', preset: 'homeassistant', url: 'https://discord.com/api/webhooks/1/x' },
        'webhook_options_invalid',
      ],
    ]
    for (const [body, code] of cases) {
      const r = await post(body)
      assert.equal(r.status(), 422, JSON.stringify(body))
      assert.equal(r.body().error, code, JSON.stringify(body))
    }
    const telegram = await post({
      format: 'telegram',
      auth: { type: 'telegram', botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
      options: { chatId: '-1001234567890', messageThreadId: 7 },
    })
    telegram.assertStatus(201)
    const view = telegram.body().data.webhook
    assert.equal(view.urlDisplay, 'telegram · chat -1001234567890')
    assert.deepEqual(view.options, { chatId: '-1001234567890', messageThreadId: 7 })
    assert.isNull(telegram.body().data.secret)
    assert.isFalse(view.signed)
    assert.equal(view.filters.quietHours, 'inherit')

    const ntfy = await post({ format: 'ntfy', url: 'https://ntfy.sh/perch-x7k2m9q4' })
    ntfy.assertStatus(201)
    assert.equal(ntfy.body().data.webhook.urlDisplay, 'https://ntfy.sh/••••')
    assert.equal(ntfy.body().data.webhook.options.topic, 'perch-x7k2m9q4')
  })

  test('update keeps url and auth unless given; format change needs the url; rotate-secret', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seed()
    const hook = await receiver([{ status: 204 }, { status: 204 }])
    try {
      const created = await apiLoose(client)
        .post(BASE)
        .bearerToken(adminToken)
        .json({
          name: 'Generic',
          format: 'standard',
          url: hook.url('/in'),
          auth: { type: 'basic', username: 'u', password: 'p' },
        })
      const { webhook, secret } = created.body().data
      const renamed = await apiLoose(client)
        .patch(`${BASE}/${webhook.id}`)
        .bearerToken(adminToken)
        .json({ name: 'Renamed', respectQuietHours: true })
      renamed.assertStatus(200)
      assert.equal(renamed.body().data.name, 'Renamed')
      assert.deepEqual(renamed.body().data.auth, { type: 'basic', username: 'u' })
      assert.isTrue(renamed.body().data.respectQuietHours)
      assert.equal(renamed.body().data.filters.quietHours, 'inherit')
      assert.isTrue(renamed.body().data.signed)

      // Still signs with the same secret and sends the same auth.
      const test1 = await apiLoose(client)
        .post(`${BASE}/${webhook.id}/test`)
        .bearerToken(adminToken)
      test1.assertStatus(200)
      assert.equal(test1.body().data.result.outcome, 'sent')
      const got = hook.received[0]
      assert.equal(got.headers.authorization, `Basic ${Buffer.from('u:p').toString('base64')}`)
      assert.doesNotThrow(() => new Webhook(secret).verify(got.body, got.headers))

      const noUrl = await apiLoose(client)
        .patch(`${BASE}/${webhook.id}`)
        .bearerToken(adminToken)
        .json({ format: 'slack' })
      noUrl.assertStatus(422)
      noUrl.assertBodyContains({ error: 'webhook_url_invalid' })

      const notSigned = await apiLoose(client)
        .patch(`${BASE}/${webhook.id}`)
        .bearerToken(adminToken)
        .json({ format: 'slack', url: 'https://hooks.slack.com/services/T0/B0/xyz' })
      notSigned.assertStatus(200)
      assert.isFalse(notSigned.body().data.signed)
      assert.deepEqual(notSigned.body().data.auth, { type: 'none' })
      assert.equal(notSigned.body().data.preset, 'slack')
      const refused = await apiLoose(client)
        .post(`${BASE}/${webhook.id}/rotate-secret`)
        .bearerToken(adminToken)
      refused.assertStatus(409)
      refused.assertBodyContains({ error: 'webhook_not_signed' })

      // Back to standard: unsigned until rotate-secret, which shows the new secret once.
      const back = await apiLoose(client)
        .patch(`${BASE}/${webhook.id}`)
        .bearerToken(adminToken)
        .json({ format: 'standard', url: hook.url('/in') })
      assert.isFalse(back.body().data.signed)
      const rotated = await apiLoose(client)
        .post(`${BASE}/${webhook.id}/rotate-secret`)
        .bearerToken(adminToken)
      rotated.assertStatus(200)
      const fresh = rotated.body().data.secret
      assert.notEqual(fresh, secret)
      assert.isTrue(rotated.body().data.webhook.signed)
      _resetDeliveryTests()
      await expectStatus(
        apiLoose(client).post(`${BASE}/${webhook.id}/test`).bearerToken(adminToken),
        200
      )
      const second = hook.received[1]
      assert.doesNotThrow(() => new Webhook(fresh).verify(second.body, second.headers))
      assert.throws(() => new Webhook(secret).verify(second.body, second.headers))
      await expectStatus(
        apiLoose(client).delete(`${BASE}/${webhook.id}`).bearerToken(adminToken),
        204
      )
      await expectStatus(apiLoose(client).get(`${BASE}/${webhook.id}`).bearerToken(adminToken), 404)
      assert.lengthOf(await AlertDelivery.all(), 0)
    } finally {
      await hook.close()
    }
  })

  test('needs_secret: unreadable ciphertext (APP_KEY changed) is shown and refused', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seed()
    const created = await apiLoose(client)
      .post(BASE)
      .bearerToken(adminToken)
      .json({ name: 'Old', format: 'discord', url: 'https://discord.com/api/webhooks/1/x' })
    const id = created.body().data.webhook.id
    await AlertWebhook.query().where('id', id).update({ url_encrypted: 'not-ciphertext' })
    const view = await apiLoose(client).get(`${BASE}/${id}`).bearerToken(adminToken)
    assert.equal(view.body().data.state, 'needs_secret')
    const t = await apiLoose(client).post(`${BASE}/${id}/test`).bearerToken(adminToken)
    t.assertStatus(409)
    t.assertBodyContains({ error: 'webhook_needs_secret' })
    const fixed = await apiLoose(client)
      .patch(`${BASE}/${id}`)
      .bearerToken(adminToken)
      .json({ url: 'https://discord.com/api/webhooks/1/y' })
    fixed.assertStatus(200)
    assert.equal(fixed.body().data.state, 'active')
  })

  test('formats: standard body and headers', ({ assert }) => {
    const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
    const req = build('standard', {
      secret,
      auth: { type: 'header', name: 'X-Api-Key', value: 'k' },
      message: message({ transition: 'test', event: 'test' }),
    })
    const body = JSON.parse(req.body)
    assert.deepInclude(body, {
      version: 1,
      id: 'msg_TEST',
      transition: 'test',
      sentAt: now.toISOString(),
    })
    assert.deepEqual(body.message, {
      title: 'WAN <down> & out',
      body: 'wan0 lost carrier at 14:02.',
      url: 'https://perch.example.com/alerts/9',
      severity: 'critical',
    })
    assert.isNull(body.alert)
    assert.equal(req.headers['webhook-id'], 'msg_TEST')
    assert.equal(req.headers['webhook-timestamp'], String(now.getTime() / 1000))
    assert.equal(req.headers['X-Perch-Event'], 'test')
    assert.equal(req.headers['X-Api-Key'], 'k')
    assert.equal(
      req.headers['webhook-signature'],
      new Webhook(secret).sign('msg_TEST', now, req.body)
    )
    assert.match(req.headers['webhook-signature'], /^v1,[A-Za-z0-9+/]+=*$/)
    assert.notProperty(build('standard').headers, 'webhook-signature')
  })

  test('formats: ntfy, gotify, discord, slack, telegram', ({ assert }) => {
    assert.deepEqual(ntfyTarget('https://ntfy.example.com/sub/perch-x7'), {
      root: 'https://ntfy.example.com/sub/',
      topic: 'perch-x7',
    })
    const ntfy = build('ntfy', {
      url: 'https://ntfy.sh/perch-x7',
      auth: { type: 'bearer', token: 'tk_1' },
    })
    assert.equal(ntfy.url, 'https://ntfy.sh/')
    assert.equal(ntfy.headers.Authorization, 'Bearer tk_1')
    assert.deepEqual(JSON.parse(ntfy.body), {
      topic: 'perch-x7',
      title: 'WAN <down> & out',
      message: 'wan0 lost carrier at 14:02.',
      priority: 5,
      tags: ['rotating_light'],
      click: 'https://perch.example.com/alerts/9',
    })
    const resolvedNtfy = JSON.parse(
      build('ntfy', { url: 'https://ntfy.sh/t', message: message({ transition: 'resolved' }) }).body
    )
    assert.equal(resolvedNtfy.priority, 3)
    assert.deepEqual(resolvedNtfy.tags, ['white_check_mark'])

    const gotify = build('gotify', {
      url: 'https://gotify.example.com/',
      auth: { type: 'gotify', token: 'A1' },
    })
    assert.equal(gotify.url, 'https://gotify.example.com/message')
    assert.equal(gotify.headers['X-Gotify-Key'], 'A1')
    assert.equal(JSON.parse(gotify.body).priority, 8)
    assert.equal(
      JSON.parse(gotify.body).extras['client::notification'].click.url,
      'https://perch.example.com/alerts/9'
    )

    const discord = build('discord', { url: 'https://discord.com/api/webhooks/1/x?thread_id=5' })
    const discordUrl = new URL(discord.url)
    assert.equal(discordUrl.searchParams.get('wait'), 'true')
    assert.equal(discordUrl.searchParams.get('thread_id'), '5')
    const embed = JSON.parse(discord.body).embeds[0]
    assert.deepInclude(embed, { color: 14427686, url: 'https://perch.example.com/alerts/9' })
    assert.deepEqual(JSON.parse(discord.body).allowed_mentions, { parse: [] })
    assert.equal(embed.footer.text, 'Home · critical')

    const slack = JSON.parse(build('slack').body)
    assert.equal(slack.text, 'WAN &lt;down&gt; &amp; out: wan0 lost carrier at 14:02.')
    assert.equal(
      slack.blocks[0].text.text,
      '*<https://perch.example.com/alerts/9|WAN &lt;down&gt; &amp; out>*\nwan0 lost carrier at 14:02.'
    )

    const telegram = build('telegram', {
      auth: { type: 'telegram', botToken: '123:ABC' },
      options: { chatId: '42', messageThreadId: 3 },
    })
    assert.equal(telegram.url, 'https://api.telegram.org/bot123:ABC/sendMessage')
    const tg = JSON.parse(telegram.body)
    assert.deepInclude(tg, {
      chat_id: '42',
      parse_mode: 'HTML',
      disable_notification: false,
      message_thread_id: 3,
    })
    assert.equal(
      tg.text,
      '<b>WAN &lt;down&gt; &amp; out</b>\nwan0 lost carrier at 14:02.\n<a href="https://perch.example.com/alerts/9">Open in Perch</a>'
    )
    const quiet = JSON.parse(
      build('telegram', {
        auth: { type: 'telegram', botToken: '123:ABC' },
        options: { chatId: '42' },
        message: message({ severity: 'info' }),
      }).body
    )
    assert.isTrue(quiet.disable_notification)
    const long = JSON.parse(
      build('telegram', {
        auth: { type: 'telegram', botToken: '123:ABC' },
        options: { chatId: '42' },
        message: message({ body: '<'.repeat(5000) }),
      }).body
    )
    assert.isAtMost(long.text.length, 4096)
    assert.match(long.text, /Open in Perch<\/a>$/)
    assert.notMatch(long.text, /&l…|&lt…$/)

    assert.equal(cutBytes('ééé', 5), 'é…')
    assert.equal(
      webhookUrlDisplay('discord', 'https://discord.com/api/webhooks/1234/tok', {}),
      'https://discord.com/api/webhooks/1234/••••'
    )
  })

  test('answers: redirects fail, 429/5xx retry with Retry-After, 4xx fail, service-specific', ({
    assert,
  }) => {
    const answer = (status: number, headers: Record<string, string> = {}, text = '') => ({
      status,
      headers: new Headers(headers),
      text,
      durationMs: 5,
    })
    assert.deepInclude(mapWebhookAnswer('standard', answer(204)), {
      outcome: 'sent',
      statusCode: 204,
    })
    const redirect = mapWebhookAnswer(
      'standard',
      answer(301, { location: 'https://new.example.com/h' })
    )
    assert.equal(redirect.outcome, 'failed')
    assert.match((redirect as { error: string }).error, /redirects are not followed/)
    assert.deepInclude(mapWebhookAnswer('standard', answer(429, { 'retry-after': '30' })), {
      outcome: 'retry',
      retryAfterSeconds: 30,
    })
    assert.deepInclude(mapWebhookAnswer('standard', answer(425)), { outcome: 'retry' })
    assert.deepInclude(mapWebhookAnswer('standard', answer(502)), { outcome: 'retry' })
    assert.deepInclude(mapWebhookAnswer('standard', answer(404, {}, 'no such hook')), {
      outcome: 'failed',
      responseExcerpt: 'no such hook',
    })
    assert.deepInclude(
      mapWebhookAnswer('discord', answer(429, {}, JSON.stringify({ retry_after: 2.5 }))),
      { outcome: 'retry', retryAfterSeconds: 3 }
    )
    assert.deepInclude(mapWebhookAnswer('telegram', answer(200, {}, '{"ok":true,"result":{}}')), {
      outcome: 'sent',
    })
    assert.deepInclude(
      mapWebhookAnswer(
        'telegram',
        answer(
          429,
          {},
          JSON.stringify({
            ok: false,
            description: 'Too Many Requests',
            parameters: { retry_after: 9 },
          })
        )
      ),
      { outcome: 'retry', retryAfterSeconds: 9 }
    )
    const kicked = mapWebhookAnswer(
      'telegram',
      answer(403, {}, JSON.stringify({ ok: false, description: 'Forbidden: bot was kicked' }))
    )
    assert.deepInclude(kicked, { outcome: 'failed', error: 'Telegram: Forbidden: bot was kicked' })
    assert.equal(
      retryAfter('Thu, 01 Oct 2026 06:01:00 GMT', Date.parse('2026-10-01T06:00:00Z')),
      60
    )
    assert.equal(retryAfter('99999'), 3600)
  })

  test('a real request: redirect not followed, connection refused retried', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seed()
    const hook = await receiver([{ status: 302, headers: { location: '/elsewhere' } }])
    try {
      const created = await apiLoose(client)
        .post(BASE)
        .bearerToken(adminToken)
        .json({ name: 'Redirects', format: 'slack', url: hook.url('/services/x') })
      const t = await apiLoose(client)
        .post(`${BASE}/${created.body().data.webhook.id}/test`)
        .bearerToken(adminToken)
      assert.equal(t.body().data.result.outcome, 'failed')
      assert.equal(t.body().data.result.statusCode, 302)
      assert.lengthOf(hook.received, 1)
      assert.equal(hook.received[0].headers['user-agent'].split('/')[0], 'Perch-Controller')
    } finally {
      await hook.close()
    }
    // A port nothing listens on (fetch refuses the "bad ports" such as 1 outright).
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const closedPort = (probe.address() as AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    const refused = await apiLoose(client)
      .post(BASE)
      .bearerToken(adminToken)
      .json({ name: 'Nobody', format: 'standard', url: `http://127.0.0.1:${closedPort}/hook` })
    const t2 = await apiLoose(client)
      .post(`${BASE}/${refused.body().data.webhook.id}/test`)
      .bearerToken(adminToken)
    assert.equal(t2.body().data.result.outcome, 'retry')
    assert.match(t2.body().data.result.error, /ECONNREFUSED/)
    assert.equal(t2.body().data.delivery.status, 'failed')
  })

  test('pipeline: the settings test alert reaches a signed standard webhook', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seed()
    const hook = await receiver()
    try {
      const created = await apiLoose(client)
        .post(BASE)
        .bearerToken(adminToken)
        .json({ name: 'Automation', format: 'standard', url: hook.url('/perch') })
      const { secret } = created.body().data
      const emitted = await apiLoose(client)
        .post('/api/v1/settings/alerts/test')
        .bearerToken(adminToken)
        .json({ severity: 'warning', title: 'Pipeline check' })
      emitted.assertStatus(202)
      await flushAlertQueue()
      await runDeliveryPass()
      assert.lengthOf(hook.received, 1)
      const got = hook.received[0]
      assert.doesNotThrow(() => new Webhook(secret).verify(got.body, got.headers))
      const body = JSON.parse(got.body)
      assert.equal(body.transition, 'opened')
      assert.equal(body.alert.type, 'system.test')
      assert.equal(body.alert.id, emitted.body().data.alertId)
      assert.equal(got.headers['x-perch-event'], 'system.test')
      assert.equal(body.instance.name, 'Home')
      const delivery = await AlertDelivery.query().firstOrFail()
      assert.equal(delivery.status, 'sent')
      assert.equal(got.headers['webhook-id'], delivery.messageId)
    } finally {
      await hook.close()
    }
  })
})
