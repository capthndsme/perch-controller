import Alert from '#models/alert'
import AlertWebhook from '#models/alert_webhook'
import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import { fakeAlertClock } from '#services/alerts/clock'
import { runDeliveryPass } from '#services/alerts/delivery_worker'
import { _resetHeartbeat } from '#services/alerts/detectors/heartbeat'
import { emitAlertEvent } from '#services/alerts/emit'
import { flushAlertQueue } from '#services/alerts/engine'
import { _resetRoutingState } from '#services/alerts/routing'
import { _setSenders } from '#services/alerts/senders'
import { ALERTS_DEFAULTS, getAlertsSettings, RULE_LIMITS } from '#services/alerts/settings'
import { apiLoose, resetAlertEngineState, truncateAllTables } from '#tests/helpers/alerts'
import { test } from '@japa/runner'

/**
 * WP-A2 functional acceptance (docs/design/alerts/api.md §3.3, §3.5): Settings
 * → Alerts read/patch (partial rules, null resets, 422 field paths, a rule
 * turned off resolves its alerts quietly), the test alert, the delivery log.
 */

const ENDPOINT = '/api/v1/settings/alerts'

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
  await SystemSetting.set('site_name', 'Perch @ test')
  await SystemSetting.set('timezone', 'Asia/Manila')
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

test.group('alerts settings API', (group) => {
  group.each.setup(async () => {
    await truncateAllTables()
    await resetAlertEngineState()
    _resetRoutingState()
    _resetHeartbeat()
    const clock = fakeAlertClock('2026-10-01T06:00:00Z')
    return async () => {
      clock.restore()
      _setSenders(null)
      await resetAlertEngineState()
    }
  })

  test('admin only', async ({ client }) => {
    const { operatorToken } = await seed()
    const read = await apiLoose(client).get(ENDPOINT).bearerToken(operatorToken)
    read.assertStatus(403)
    read.assertBodyContains({ error: 'admin_required' })
    const deliveries = await apiLoose(client)
      .get('/api/v1/alerts/deliveries')
      .bearerToken(operatorToken)
    deliveries.assertStatus(403)
  })

  test('GET: settings, effective rules, defaults, limits, catalogue, zone', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seed()
    const r = await apiLoose(client).get(ENDPOINT).bearerToken(adminToken)
    r.assertStatus(200)
    const data = r.body().data
    assert.deepEqual(data.settings.quietHours, ALERTS_DEFAULTS.quietHours)
    assert.deepEqual(data.settings.heartbeat, {
      configured: false,
      urlDisplay: null,
      intervalSeconds: 60,
    })
    assert.notProperty(data.settings, 'rules')
    assert.equal(data.rules['ap.offline'].groupSeconds, 30)
    assert.deepEqual(data.overrides, {})
    assert.deepEqual(data.limits.rule.holdSeconds, RULE_LIMITS.holdSeconds)
    assert.equal(data.limits.bootGraceSeconds.min, 30)
    assert.deepEqual(data.limits.rule.repeatMinutes, { min: 15, max: 1440, allowZero: true })
    assert.deepEqual(data.limits.pushTtlMinutes.critical, { min: 5, max: 2880 })
    assert.isAbove(data.catalogue.length, 40)
    assert.equal(data.timezone, 'Asia/Manila')
    assert.isNull(data.vapid)
    assert.isTrue(data.deliveryEnabled)
    assert.deepEqual(data.heartbeat, { lastPingAt: null, lastStatus: null, lastError: null })
  })

  test('PATCH: nested partials, rules partial, null resets, origin captured, heartbeat masked', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seed()
    const first = await apiLoose(client)
      .patch(ENDPOINT)
      .bearerToken(adminToken)
      .json({
        quietHours: { enabled: true },
        heartbeat: { url: 'https://hc-ping.example.com/5f1e0b1c-token' },
        rules: {
          'device.new': { severity: 'warning', params: { minPresenceMinutes: 5 } },
          'wan.failover': { holdSeconds: 90 },
        },
      })
    first.assertStatus(200)
    const data = first.body().data
    assert.deepEqual(data.settings.quietHours, { ...ALERTS_DEFAULTS.quietHours, enabled: true })
    assert.match(String(data.settings.capturedOrigin), /^http:\/\/(127\.0\.0\.1|localhost):\d+$/)
    assert.deepEqual(data.settings.heartbeat, {
      configured: true,
      urlDisplay: 'https://hc-ping.example.com/••••',
      intervalSeconds: 60,
    })
    assert.notInclude(JSON.stringify(data), '5f1e0b1c-token')
    assert.equal(data.rules['device.new'].severity, 'warning')
    assert.equal(data.rules['device.new'].params.minPresenceMinutes, 5)
    assert.isTrue(data.rules['device.new'].params.excludePortalNetworks)
    assert.deepEqual(data.overrides['wan.failover'], { holdSeconds: 90 })

    const second = await apiLoose(client)
      .patch(ENDPOINT)
      .bearerToken(adminToken)
      .json({ rules: { 'wan.failover': null, 'device.new': { notify: false } } })
    second.assertStatus(200)
    assert.notProperty(second.body().data.overrides, 'wan.failover')
    assert.deepEqual(second.body().data.overrides['device.new'], {
      severity: 'warning',
      notify: false,
      params: { minPresenceMinutes: 5 },
    })
    const stored = await getAlertsSettings()
    assert.isTrue(stored.quietHours.enabled)
  })

  test('PATCH: 422 with field paths for unknown types, bad rule values, params and URLs', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seed()
    const r = await apiLoose(client)
      .patch(ENDPOINT)
      .bearerToken(adminToken)
      .json({
        dashboardUrl: 'https://perch.example.com/some/path',
        vapidSubject: 'https://localhost',
        rules: {
          'foo.bar': { enabled: false },
          'ap.offline': { holdSeconds: 99999, repeatMinutes: 5, bogus: 1 },
          'device.new': { params: { minPresenceMinutes: 'ten', nope: 1 } },
        },
      })
    r.assertStatus(422)
    const fields = (
      r.body() as unknown as { errors: Array<{ field: string; rule: string }> }
    ).errors.map((e) => `${e.field}:${e.rule}`)
    assert.includeMembers(fields, [
      'dashboardUrl:origin',
      'vapidSubject:not_localhost',
      'rules.foo.bar:alert_type',
      'rules.ap.offline.holdSeconds:range',
      'rules.ap.offline.repeatMinutes:range',
      'rules.ap.offline.bogus:unknown',
      'rules.device.new.params.minPresenceMinutes:param_value',
      'rules.device.new.params.nope:param',
    ])
    const vine = await apiLoose(client)
      .patch(ENDPOINT)
      .bearerToken(adminToken)
      .json({ bootGraceSeconds: 5 })
    vine.assertStatus(422)
    assert.deepEqual(await getAlertsSettings(), { ...ALERTS_DEFAULTS, rules: {} })
  })

  test('turning a rule off resolves its live alerts quietly', async ({ client, assert }) => {
    const { adminToken } = await seed()
    emitAlertEvent({ type: 'system.rollup_stalled', subject: { kind: 'controller' } })
    await flushAlertQueue()
    const before = await Alert.query().where('type', 'system.rollup_stalled').firstOrFail()
    assert.equal(before.state, 'active')

    const r = await apiLoose(client)
      .patch(ENDPOINT)
      .bearerToken(adminToken)
      .json({ rules: { 'system.rollup_stalled': { enabled: false } } })
    r.assertStatus(200)
    const after = await Alert.findOrFail(before.id)
    assert.equal(after.state, 'resolved')
    assert.isNull(after.recoveryDueAt)
  })

  test('POST test: a system.test notice through the pipeline, 202 with its id', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seed()
    const r = await apiLoose(client)
      .post(`${ENDPOINT}/test`)
      .bearerToken(adminToken)
      .json({ severity: 'warning', title: 'Hello from the test' })
    r.assertStatus(202)
    const alert = await Alert.findOrFail(r.body().data.alertId)
    assert.equal(alert.type, 'system.test')
    assert.equal(alert.severity, 'warning')
    assert.equal(alert.title, 'Hello from the test')
    const invalid = await apiLoose(client)
      .post(`${ENDPOINT}/test`)
      .bearerToken(adminToken)
      .json({ severity: 'loud' } as never)
    invalid.assertStatus(422)
  })

  test('delivery log: list with filters and cursor, detail with attempts, 404', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seed()
    const hook = await AlertWebhook.create({
      name: 'Log hook',
      format: 'standard',
      preset: null,
      urlEncrypted: 'x',
      urlDisplay: 'https://hooks.example.com/••••',
      secretEncrypted: null,
      authEncrypted: null,
      options: null,
      filters: { minSeverity: 'info', categories: null, types: null, quietHours: 'ignore' },
      detail: 'full',
      respectQuietHours: false,
      enabled: true,
      state: 'active',
      consecutiveFailures: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      createdByUserId: null,
    })
    _setSenders({
      webhook: {
        kind: 'webhook',
        send: async () => ({
          outcome: 'sent',
          statusCode: 204,
          durationMs: 7,
          responseExcerpt: '',
        }),
      },
    })
    for (let i = 0; i < 3; i++) {
      emitAlertEvent({
        type: 'system.test',
        subject: { kind: 'controller' },
        dedupeKey: `system.test:log-${i}`,
        severity: 'info',
      })
    }
    await flushAlertQueue()
    await runDeliveryPass()

    const page = await apiLoose(client)
      .get('/api/v1/alerts/deliveries')
      .qs({ destination: `webhook:${hook.id}`, limit: 2 })
      .bearerToken(adminToken)
    page.assertStatus(200)
    const { deliveries, nextCursor } = page.body().data
    assert.lengthOf(deliveries, 2)
    assert.equal(deliveries[0].status, 'sent')
    assert.deepEqual(deliveries[0].destination, {
      kind: 'webhook',
      id: hook.id,
      name: 'Log hook',
      format: 'standard',
    })
    assert.isNull(deliveries[0].nextAttemptAt)
    const rest = await apiLoose(client)
      .get('/api/v1/alerts/deliveries')
      .qs({ before: nextCursor })
      .bearerToken(adminToken)
    assert.lengthOf(rest.body().data.deliveries, 1)
    assert.isNull(rest.body().data.nextCursor)

    const byStatus = await apiLoose(client)
      .get('/api/v1/alerts/deliveries')
      .qs({ status: 'failed,expired' })
      .bearerToken(adminToken)
    assert.lengthOf(byStatus.body().data.deliveries, 0)
    const bad = await apiLoose(client)
      .get('/api/v1/alerts/deliveries')
      .qs({ status: 'nope' })
      .bearerToken(adminToken)
    bad.assertStatus(422)

    const detail = await apiLoose(client)
      .get(`/api/v1/alerts/deliveries/${deliveries[0].id}`)
      .bearerToken(adminToken)
    detail.assertStatus(200)
    assert.deepEqual(detail.body().data.attempts, [
      {
        attemptedAt: '2026-10-01T06:00:00Z',
        durationMs: 7,
        statusCode: 204,
        outcome: 'sent',
        error: null,
        responseExcerpt: null,
      },
    ])
    const missing = await apiLoose(client)
      .get('/api/v1/alerts/deliveries/999999')
      .bearerToken(adminToken)
    missing.assertStatus(404)
    missing.assertBodyContains({ error: 'delivery_not_found' })
  })
})
