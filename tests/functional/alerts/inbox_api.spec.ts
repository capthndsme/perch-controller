import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import { _registerTestAlertType } from '#services/alerts/catalogue/index'
import { fakeAlertClock } from '#services/alerts/clock'
import { emitAlertEvent } from '#services/alerts/emit'
import { flushAlertQueue } from '#services/alerts/engine'
import type { AlertTypeDef, Category, EmitInput } from '#services/alerts/model'
import { apiLoose, resetAlertEngineState, truncateAllTables } from '#tests/helpers/alerts'
import app from '@adonisjs/core/services/app'
import { test } from '@japa/runner'
import { access } from 'node:fs/promises'

/**
 * WP-A1 functional acceptance (docs/design/alerts/api.md §3.1–3.2, §4): the
 * inbox endpoints, per-user unread state, admin-only actions, mutes and
 * watches, and the routes file next to the SPA catch-all.
 */

function type(
  name: string,
  category: Category,
  kind: 'condition' | 'notice' = 'condition'
): AlertTypeDef {
  return {
    type: name,
    category,
    kind,
    severity: 'warning',
    subjects: ['ap', 'controller', 'device'],
    owner: 'alerts',
    label: name,
    description: 'test',
    defaults: { holdSeconds: kind === 'condition' ? 0 : 0, flapThreshold: 0 },
    render: (a) => ({ title: `${name} on ${a.label}`, body: a.state }),
  }
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
  await SystemSetting.set('site_name', 'Perch @ test')
  await SystemSetting.set('timezone', 'UTC')
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
  const adminToken = adminAccess.value!.release()
  const operatorToken = operatorAccess.value!.release()
  return { admin, operator, adminToken, operatorToken }
}

/** POST /alerts/mutes shares its pattern with GET, so the typed client unions both bodies. */
type MuteBody = {
  id: number
  type: string | null
  subject: { kind: string; ref: string; label: string | null } | null
  until: string | null
  reason: string
  createdBy: { name: string } | null
}

async function emit(input: EmitInput) {
  emitAlertEvent(input)
  await flushAlertQueue()
}

test.group('alerts inbox API', (group) => {
  let clock: ReturnType<typeof fakeAlertClock>

  group.each.setup(async () => {
    await truncateAllTables()
    await resetAlertEngineState()
    clock = fakeAlertClock('2026-10-01T06:00:00Z')
    _registerTestAlertType(type('test.agents', 'agents'))
    _registerTestAlertType(type('test.wan', 'wan'))
    _registerTestAlertType(type('test.info', 'system', 'notice'))
    _registerTestAlertType({
      ...type('test.held', 'network'),
      defaults: { holdSeconds: 60, flapThreshold: 0 },
    })
    return () => resetAlertEngineState()
  })

  /** Four visible alerts (2 active, 1 resolved, 1 posted) + one pending + one blip. */
  async function seedAlerts() {
    await emit({ type: 'test.agents', subject: { kind: 'ap', id: 4 }, severity: 'warning' })
    clock.advance({ seconds: 5 })
    await emit({ type: 'test.wan', subject: { kind: 'ap', id: 5 }, severity: 'critical' })
    clock.advance({ seconds: 5 })
    await emit({ type: 'test.agents', subject: { kind: 'ap', id: 6 } })
    await emit({ type: 'test.agents', subject: { kind: 'ap', id: 6 }, phase: 'clear' })
    clock.advance({ seconds: 5 })
    await emit({ type: 'test.info', subject: { kind: 'controller' }, severity: 'info' })
    clock.advance({ seconds: 5 })
    await emit({ type: 'test.held', subject: { kind: 'ap', id: 7 } }) // pending
    await emit({ type: 'test.held', subject: { kind: 'ap', id: 8 } })
    await emit({ type: 'test.held', subject: { kind: 'ap', id: 8 }, phase: 'clear' }) // blip
    clock.advance({ seconds: 5 })
  }

  test('needs a token; reads are open to every user', async ({ client }) => {
    const { operatorToken } = await seed()
    const r1 = await apiLoose(client).get('/api/v1/alerts')
    r1.assertStatus(401)
    const r2 = await apiLoose(client).get('/api/v1/alerts').bearerToken(operatorToken)
    r2.assertStatus(200)
    const r3 = await apiLoose(client).get('/api/v1/alerts/summary').bearerToken(operatorToken)
    r3.assertStatus(200)
  })

  test('list: default view hides pending alerts and blips; filters narrow it', async ({
    client,
    assert,
  }) => {
    const { operatorToken: token } = await seed()
    await seedAlerts()

    const all = await apiLoose(client).get('/api/v1/alerts').bearerToken(token)
    all.assertStatus(200)
    const titles = (all.body().data.alerts as Array<{ title: string; state: string }>).map(
      (a) => `${a.title}|${a.state}`
    )
    assert.deepEqual(titles, [
      'test.info on Perch|posted',
      'test.agents on 6|resolved',
      'test.wan on 5|active',
      'test.agents on 4|active',
    ])
    assert.isNull(all.body().data.nextCursor)
    assert.equal(all.body().data.alerts[0].bumpedAt, '2026-10-01T06:00:15Z')

    const blips = await apiLoose(client).get('/api/v1/alerts').qs({ blips: '1' }).bearerToken(token)
    assert.lengthOf(blips.body().data.alerts, 6)

    const active = await apiLoose(client)
      .get('/api/v1/alerts')
      .qs({ view: 'active' })
      .bearerToken(token)
    assert.deepEqual(
      active.body().data.alerts.map((a: { subject: { ref: string } }) => a.subject.ref),
      ['5', '4']
    )
    const critical = await apiLoose(client)
      .get('/api/v1/alerts')
      .qs({ minSeverity: 'critical' })
      .bearerToken(token)
    assert.lengthOf(critical.body().data.alerts, 1)
    const wan = await apiLoose(client)
      .get('/api/v1/alerts')
      .qs({ category: 'wan,system' })
      .bearerToken(token)
    assert.lengthOf(wan.body().data.alerts, 2)
    const byType = await apiLoose(client)
      .get('/api/v1/alerts')
      .qs({ type: 'test.agents' })
      .bearerToken(token)
    assert.lengthOf(byType.body().data.alerts, 2)
    const bySubject = await apiLoose(client)
      .get('/api/v1/alerts')
      .qs({ subject: 'ap:4' })
      .bearerToken(token)
    assert.lengthOf(bySubject.body().data.alerts, 1)
    assert.equal(bySubject.body().data.alerts[0].subject.kind, 'ap')

    for (const qs of [{ category: 'bogus' }, { subject: 'nope' }, { before: 'x:y' }]) {
      const bad = await apiLoose(client).get('/api/v1/alerts').qs(qs).bearerToken(token)
      bad.assertStatus(422)
    }
  })

  test('list: the cursor pages through bumped_at, id', async ({ client, assert }) => {
    const { operatorToken: token } = await seed()
    await seedAlerts()
    const first = await apiLoose(client).get('/api/v1/alerts').qs({ limit: 3 }).bearerToken(token)
    assert.lengthOf(first.body().data.alerts, 3)
    const cursor = first.body().data.nextCursor
    assert.match(String(cursor), /^\d+:\d+$/)
    const second = await apiLoose(client)
      .get('/api/v1/alerts')
      .qs({ limit: 3, before: cursor })
      .bearerToken(token)
    assert.lengthOf(second.body().data.alerts, 1)
    assert.isNull(second.body().data.nextCursor)
    assert.equal(second.body().data.alerts[0].subject.ref, '4')
  })

  test('summary: active counts, latest, and unread per user', async ({ client, assert }) => {
    const { adminToken, operatorToken } = await seed()
    await seedAlerts()
    const summary = await apiLoose(client).get('/api/v1/alerts/summary').bearerToken(adminToken)
    summary.assertStatus(200)
    assert.deepEqual(summary.body().data.active, { critical: 1, warning: 1, info: 0 })
    assert.equal(summary.body().data.unread, 4)
    assert.lengthOf(summary.body().data.latest, 4)
    assert.isTrue(summary.body().data.latest[0].unread)

    const read = await apiLoose(client).post('/api/v1/alerts/read').bearerToken(adminToken).json({})
    read.assertStatus(200)
    assert.equal(read.body().data.unread, 0)
    assert.equal(read.body().data.readAt, '2026-10-01T06:00:25Z')

    const adminAfter = await apiLoose(client).get('/api/v1/alerts/summary').bearerToken(adminToken)
    assert.equal(adminAfter.body().data.unread, 0)
    const operatorAfter = await apiLoose(client)
      .get('/api/v1/alerts/summary')
      .bearerToken(operatorToken)
    assert.equal(operatorAfter.body().data.unread, 4, 'read state is per user')

    // Something new after the read marker is unread again.
    clock.advance({ seconds: 5 })
    await emit({ type: 'test.agents', subject: { kind: 'ap', id: 9 } })
    const again = await apiLoose(client).get('/api/v1/alerts/summary').bearerToken(adminToken)
    assert.equal(again.body().data.unread, 1)
    // `through` in the future is clamped to now.
    const clamped = await apiLoose(client)
      .post('/api/v1/alerts/read')
      .bearerToken(adminToken)
      .json({ through: '2030-01-01T00:00:00Z' })
    assert.equal(clamped.body().data.readAt, '2026-10-01T06:00:30Z')
  })

  test('detail: events, deliveries and the effective rule; 404 for a missing id', async ({
    client,
    assert,
  }) => {
    const { operatorToken: token } = await seed()
    await seedAlerts()
    const list = await apiLoose(client)
      .get('/api/v1/alerts')
      .qs({ subject: 'ap:6' })
      .bearerToken(token)
    const id = list.body().data.alerts[0].id
    const detail = await apiLoose(client).get(`/api/v1/alerts/${id}`).bearerToken(token)
    detail.assertStatus(200)
    const data = detail.body().data
    assert.equal(data.state, 'resolved')
    assert.deepEqual(
      data.events.map((e: { outcome: string }) => e.outcome),
      ['resolved', 'opened']
    )
    assert.deepEqual(data.deliveries, [])
    assert.equal(data.rule.holdSeconds, 0)
    assert.isNull(data.mutedBy)
    const missing = await apiLoose(client).get('/api/v1/alerts/999999').bearerToken(token)
    missing.assertStatus(404)
    missing.assertBodyContains({ error: 'alert_not_found' })
  })

  test('acknowledge and resolve are admin-only, with 404 and 409s', async ({ client, assert }) => {
    const { adminToken, operatorToken } = await seed()
    await seedAlerts()
    const list = await apiLoose(client)
      .get('/api/v1/alerts')
      .qs({ subject: 'ap:4' })
      .bearerToken(adminToken)
    const id = list.body().data.alerts[0].id
    const notice = await apiLoose(client)
      .get('/api/v1/alerts')
      .qs({ type: 'test.info' })
      .bearerToken(adminToken)
    const noticeId = notice.body().data.alerts[0].id

    const denied = await apiLoose(client)
      .post(`/api/v1/alerts/${id}/acknowledge`)
      .bearerToken(operatorToken)
    denied.assertStatus(403)
    denied.assertBodyContains({ error: 'admin_required' })
    const r4 = await apiLoose(client)
      .post(`/api/v1/alerts/${id}/resolve`)
      .bearerToken(operatorToken)
    r4.assertStatus(403)

    const ack = await apiLoose(client)
      .post(`/api/v1/alerts/${id}/acknowledge`)
      .bearerToken(adminToken)
      .json({ note: 'on it' })
    ack.assertStatus(200)
    assert.equal(ack.body().data.acknowledged.note, 'on it')
    assert.equal(ack.body().data.acknowledged.by.name, 'Admin')

    const resolved = await apiLoose(client)
      .post(`/api/v1/alerts/${id}/resolve`)
      .bearerToken(adminToken)
    resolved.assertStatus(200)
    assert.equal(resolved.body().data.state, 'resolved')
    assert.equal(resolved.body().data.resolvedBy.name, 'Admin')
    const twice = await apiLoose(client)
      .post(`/api/v1/alerts/${id}/resolve`)
      .bearerToken(adminToken)
    twice.assertStatus(409)
    twice.assertBodyContains({ error: 'alert_not_active' })
    const notCondition = await apiLoose(client)
      .post(`/api/v1/alerts/${noticeId}/resolve`)
      .bearerToken(adminToken)
    notCondition.assertStatus(409)
    notCondition.assertBodyContains({ error: 'alert_not_condition' })
    const missing = await apiLoose(client)
      .post('/api/v1/alerts/424242/acknowledge')
      .bearerToken(adminToken)
    missing.assertStatus(404)
  })

  test('mutes: list for users, create and delete for admins, validation errors', async ({
    client,
    assert,
  }) => {
    const { adminToken, operatorToken } = await seed()
    const r5 = await apiLoose(client)
      .post('/api/v1/alerts/mutes')
      .bearerToken(operatorToken)
      .json({ type: 'ap.offline' })
    r5.assertStatus(403)

    const created = await apiLoose(client)
      .post('/api/v1/alerts/mutes')
      .bearerToken(adminToken)
      .json({
        type: 'ap.offline',
        subject: { kind: 'ap', ref: '4' },
        minutes: 60,
        note: 'moving it',
      })
    created.assertStatus(201)
    const mute = created.body().data as MuteBody
    assert.equal(mute.type, 'ap.offline')
    assert.deepEqual(mute.subject, { kind: 'ap', ref: '4', label: null })
    assert.equal(mute.until, '2026-10-01T07:00:00Z')
    assert.equal(mute.reason, 'manual')
    assert.equal(mute.createdBy?.name, 'Admin')

    const list = await apiLoose(client).get('/api/v1/alerts/mutes').bearerToken(operatorToken)
    list.assertStatus(200)
    assert.lengthOf(list.body().data as unknown[], 1)

    const scope = await apiLoose(client)
      .post('/api/v1/alerts/mutes')
      .bearerToken(adminToken)
      .json({ minutes: 5 })
    scope.assertStatus(422)
    scope.assertBodyContains({ error: 'mute_scope_required' })
    const unknown = await apiLoose(client)
      .post('/api/v1/alerts/mutes')
      .bearerToken(adminToken)
      .json({ type: 'nope.nope' })
    unknown.assertStatus(422)
    unknown.assertBodyContains({ error: 'unknown_alert_type' })
    const both = await apiLoose(client)
      .post('/api/v1/alerts/mutes')
      .bearerToken(adminToken)
      .json({ type: 'ap.offline', minutes: 5, until: '2026-10-02T00:00:00Z' })
    both.assertStatus(422)

    const r6 = await apiLoose(client)
      .delete(`/api/v1/alerts/mutes/${mute.id}`)
      .bearerToken(adminToken)
    r6.assertStatus(204)
    const gone = await apiLoose(client)
      .delete(`/api/v1/alerts/mutes/${mute.id}`)
      .bearerToken(adminToken)
    gone.assertStatus(404)
    gone.assertBodyContains({ error: 'mute_not_found' })
    // An expired mute is not listed.
    await apiLoose(client)
      .post('/api/v1/alerts/mutes')
      .bearerToken(adminToken)
      .json({ type: 'ap.offline', minutes: 1 })
    clock.advance({ minutes: 2 })
    const expired = await apiLoose(client).get('/api/v1/alerts/mutes').bearerToken(adminToken)
    assert.lengthOf(expired.body().data as unknown[], 0)
  })

  test('watches: set, list and remove a device watch', async ({ client, assert }) => {
    const { adminToken, operatorToken } = await seed()
    const mac = '02:00:00:5e:10:22'
    const r7 = await apiLoose(client)
      .put('/api/v1/alerts/watches/devices/nope')
      .bearerToken(adminToken)
      .json({ offline: true, arrival: false })
    r7.assertStatus(422)
    const r8 = await apiLoose(client)
      .put(`/api/v1/alerts/watches/devices/${mac}`)
      .bearerToken(operatorToken)
      .json({ offline: true, arrival: false })
    r8.assertStatus(403)

    const set = await apiLoose(client)
      .put(`/api/v1/alerts/watches/devices/${mac.toUpperCase()}`)
      .bearerToken(adminToken)
      .json({ offline: true, arrival: true })
    set.assertStatus(200)
    assert.deepEqual(set.body().data, { mac, label: null, offline: true, arrival: true })

    const list = await apiLoose(client).get('/api/v1/alerts/watches').bearerToken(operatorToken)
    assert.deepEqual(list.body().data, [{ mac, label: null, offline: true, arrival: true }])
    const one = await apiLoose(client)
      .get('/api/v1/alerts/watches')
      .qs({ mac })
      .bearerToken(operatorToken)
    assert.lengthOf(one.body().data, 1)

    await apiLoose(client)
      .put(`/api/v1/alerts/watches/devices/${mac}`)
      .bearerToken(adminToken)
      .json({ offline: false, arrival: false })
    const empty = await apiLoose(client).get('/api/v1/alerts/watches').bearerToken(adminToken)
    assert.deepEqual(empty.body().data, [])
  })

  test('catalogue: categories and every type with its default rule', async ({ client, assert }) => {
    const { operatorToken: token } = await seed()
    const r = await apiLoose(client).get('/api/v1/alerts/catalogue').bearerToken(token)
    r.assertStatus(200)
    const { categories, types } = r.body().data
    assert.lengthOf(categories, 8)
    const ap = types.find((t: { type: string }) => t.type === 'ap.offline')!
    assert.include(ap, {
      category: 'agents',
      kind: 'condition',
      severity: 'warning',
      available: true,
    })
    assert.equal(ap.defaults.groupSeconds, 30)
    const flap = types.find((t: { type: string }) => t.type === 'port.flapping')!
    assert.isFalse(flap.available, 'no agent port reports carrier changes')
    assert.match(String(flap.unavailableReason), /perch-apd/)
  })
})

test.group('alerts routes next to the SPA catch-all', (group) => {
  group.each.setup(() => truncateAllTables())

  test('/api/v1/alerts is behind the setup gate', async ({ client }) => {
    const r = await apiLoose(client).get('/api/v1/alerts')
    r.assertStatus(503)
    r.assertBodyContains({ error: 'setup_required' })
  })

  test('unknown alerts API paths stay JSON 404s; /alerts is the dashboard', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seed()
    const api = await apiLoose(client).get('/api/v1/alerts/nope').bearerToken(adminToken)
    api.assertStatus(404)
    assert.match(String(api.header('content-type')), /application\/json/)

    const built = await access(app.publicPath('index.html')).then(
      () => true,
      () => false
    )
    for (const path of ['/alerts', '/alerts/12', '/settings/alerts']) {
      const page = await apiLoose(client).get(path)
      if (built) {
        page.assertStatus(200)
        assert.match(String(page.header('content-type')), /text\/html/)
      } else {
        page.assertStatus(404)
        assert.match(String((page.body() as { error?: string }).error), /Dashboard not built/)
      }
    }
  })
})
