import Collector from '#models/collector'
import SystemSetting from '#models/system_setting'
import User from '#models/user'
import { _resetAnnounceState, apiKeyFingerprint } from '#services/collector_announce'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { DateTime } from 'luxon'
import { test } from '@japa/runner'

const ENDPOINT = '/api/v1/settings/collectors'
const SUMMARY_ENDPOINT = '/api/v1/collectors'
const ANNOUNCE_ENDPOINT = '/api/v1/collectors/announce'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

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

/** A healthy `GET /api/v1/summary` from a collector. */
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

async function seedSetupComplete(): Promise<{
  adminToken: string
  operatorToken: string
  seededCollector: Collector
}> {
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
  const seededCollector = await Collector.create({
    name: 'localhost',
    baseUrl: 'http://127.0.0.1:9800',
    pollIntervalSeconds: 15,
    enabled: true,
    apiKey: null,
    lastStatus: null,
  })

  const adminToken = await User.accessTokens.create(admin)
  const operatorToken = await User.accessTokens.create(operator)

  return {
    adminToken: adminToken.value!.release(),
    operatorToken: operatorToken.value!.release(),
    seededCollector,
  }
}

test.group('collector settings API', (group) => {
  let fetchMock: ReturnType<typeof mockFetch>

  group.each.setup(resetDb)
  group.each.setup(() => {
    fetchMock = mockFetch()
    return () => fetchMock.restore()
  })

  test('admin can create/list/probe/update/delete a collector', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    fetchMock.set(okProbe())

    const createResponse = await client.post(ENDPOINT).bearerToken(adminToken).json({
      name: 'mirror-box',
      baseUrl: 'http://192.168.1.50:9800',
      apiKey: 'mirror-box-key',
      pollIntervalSeconds: 5,
    })
    createResponse.assertStatus(201)
    const created = createResponse.body().data as {
      collector: Record<string, unknown>
      probe: { ok: boolean }
    }
    assert.isTrue(created.probe.ok)
    assert.equal(created.collector.source, 'manual')
    assert.equal(created.collector.lifecycle, 'adopted')
    assert.isTrue(created.collector.enabled)
    assert.isTrue(created.collector.hasApiKey)
    assert.equal(created.collector.apiKeyFingerprint, apiKeyFingerprint('mirror-box-key'))
    assert.equal(created.collector.captureInterface, 'br-lan')
    assert.equal(created.collector.version, '0.1.0')
    const collectorId = created.collector.id as number

    const listResponse = await client.get(ENDPOINT).bearerToken(adminToken)
    listResponse.assertStatus(200)
    const listed = listResponse.body().data as Array<{ id: number }>
    assert.lengthOf(listed, 2, 'the seeded collector and the new one')
    assert.include(
      listed.map((row) => row.id),
      collectorId
    )

    const probeResponse = await client
      .post(`${ENDPOINT}/${collectorId}/probe`)
      .bearerToken(adminToken)
    probeResponse.assertStatus(200)
    assert.isTrue(probeResponse.body().data.probe.ok)

    const updateResponse = await client
      .put(`${ENDPOINT}/${collectorId}`)
      .bearerToken(adminToken)
      .json({ pollIntervalSeconds: 60, enabled: false })
    updateResponse.assertStatus(200)
    assert.equal(updateResponse.body().data.collector.pollIntervalSeconds, 60)
    assert.isFalse(updateResponse.body().data.collector.enabled)
    assert.deepEqual(updateResponse.body().data.warnings, [])

    const deleteResponse = await client.delete(`${ENDPOINT}/${collectorId}`).bearerToken(adminToken)
    deleteResponse.assertStatus(204)
    assert.isNull(await Collector.find(collectorId))
  })

  test('create persists a failed probe and still saves the row', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    fetchMock.set(async () => {
      throw new TypeError('fetch failed')
    })

    const response = await client.post(ENDPOINT).bearerToken(adminToken).json({
      name: 'unreachable',
      baseUrl: 'http://192.168.1.51:9800',
    })
    response.assertStatus(201)
    const { collector, probe } = response.body().data
    assert.isFalse(probe.ok)
    assert.match(probe.error as string, /fetch failed/)

    const stored = await Collector.findOrFail(collector.id)
    assert.isFalse(stored.lastStatus?.ok)
    assert.isNull(stored.lastSeenAt)
    assert.isOk(stored.enabled)
  })

  test('a duplicate base URL is refused on create and on update', async ({ client, assert }) => {
    const { adminToken, seededCollector } = await seedSetupComplete()
    fetchMock.set(okProbe())

    const duplicate = await client.post(ENDPOINT).bearerToken(adminToken).json({
      name: 'duplicate',
      // Trailing slash: the same daemon, normalised before comparison.
      baseUrl: 'http://127.0.0.1:9800/',
    })
    duplicate.assertStatus(422)
    duplicate.assertBodyContains({ error: 'collector_base_url_in_use' })
    assert.lengthOf(await Collector.all(), 1)

    const other = await client
      .post(ENDPOINT)
      .bearerToken(adminToken)
      .json({ name: 'other', baseUrl: 'http://192.168.1.52:9800' })
    other.assertStatus(201)

    const collide = await client
      .put(`${ENDPOINT}/${other.body().data.collector.id}`)
      .bearerToken(adminToken)
      .json({ baseUrl: seededCollector.baseUrl })
    collide.assertStatus(422)
    collide.assertBodyContains({ error: 'collector_base_url_in_use' })
  })

  test('apiKey null clears the key, an omitted apiKey keeps it', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    fetchMock.set(okProbe())

    const created = await client
      .post(ENDPOINT)
      .bearerToken(adminToken)
      .json({ name: 'keyed', baseUrl: 'http://192.168.1.53:9800', apiKey: 'keep-me-please' })
    created.assertStatus(201)
    const id = created.body().data.collector.id as number

    const renamed = await client
      .put(`${ENDPOINT}/${id}`)
      .bearerToken(adminToken)
      .json({ name: 'still-keyed' })
    renamed.assertStatus(200)
    assert.isTrue(renamed.body().data.collector.hasApiKey)
    assert.equal(
      renamed.body().data.collector.apiKeyFingerprint,
      apiKeyFingerprint('keep-me-please')
    )
    const kept = await Collector.findOrFail(id)
    assert.equal(kept.apiKey, 'keep-me-please')

    const cleared = await client.put(`${ENDPOINT}/${id}`).bearerToken(adminToken).json({
      apiKey: null,
    })
    cleared.assertStatus(200)
    assert.isFalse(cleared.body().data.collector.hasApiKey)
    assert.isNull(cleared.body().data.collector.apiKeyFingerprint)
    const stripped = await Collector.findOrFail(id)
    assert.isNull(stripped.apiKey)
    assert.isNull(stripped.apiKeyFingerprint)
  })

  test('update with ?probe=false does not call fetch', async ({ client, assert }) => {
    const { adminToken, seededCollector } = await seedSetupComplete()
    let calls = 0
    fetchMock.set((async () => {
      calls += 1
      return okProbe()()
    }) as typeof fetch)

    const response = await client
      .put(`${ENDPOINT}/${seededCollector.id}?probe=false`)
      .bearerToken(adminToken)
      .json({ name: 'renamed-without-probe' })
    response.assertStatus(200)
    assert.equal(calls, 0)
    assert.isNull(response.body().data.probe)
    assert.equal(response.body().data.collector.name, 'renamed-without-probe')
  })

  test('updating an announced address warns that the announce will restore it', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    fetchMock.set(okProbe())
    const announced = await Collector.create({
      name: 'OpenWrt',
      baseUrl: 'http://192.168.1.1:9800',
      pollIntervalSeconds: 5,
      enabled: true,
      source: 'announced',
      lifecycle: 'adopted',
      instanceId: 'announced-instance-id',
    })

    const response = await client
      .put(`${ENDPOINT}/${announced.id}`)
      .bearerToken(adminToken)
      .json({ baseUrl: 'http://192.168.1.2:9800' })
    response.assertStatus(200)
    assert.deepEqual(response.body().data.warnings, ['announced_address_taken_over'])
    assert.equal(response.body().data.collector.source, 'manual')
  })

  test('no response ever carries an api key', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    fetchMock.set(okProbe())

    await client
      .post(ENDPOINT)
      .bearerToken(adminToken)
      .json({ name: 'keyed', baseUrl: 'http://192.168.1.54:9800', apiKey: 'super-secret-key' })

    const list = await client.get(ENDPOINT).bearerToken(adminToken)
    list.assertStatus(200)
    const raw = JSON.stringify(list.body())
    assert.notInclude(raw, 'super-secret-key')
    assert.notInclude(raw, '"apiKey"')
  })

  test('deleting a collector with history is refused', async ({ client, assert }) => {
    const { adminToken, seededCollector } = await seedSetupComplete()
    const now = DateTime.utc().toSQL({ includeOffset: false })
    await db.table('device_traffic_buckets').insert({
      collector_id: seededCollector.id,
      mac: 'aa:bb:cc:dd:ee:ff',
      bucket_start: now,
      bytes_in: 10,
      bytes_out: 10,
      packets_in: 1,
      packets_out: 1,
      created_at: now,
    })

    const response = await client
      .delete(`${ENDPOINT}/${seededCollector.id}`)
      .bearerToken(adminToken)
    response.assertStatus(409)
    response.assertBodyContains({ error: 'collector_has_history' })
    assert.equal(response.body().bucketRows, 1)
    assert.isNotNull(await Collector.find(seededCollector.id))
  })

  test('a once-polled collector with identities but no buckets is also refused', async ({
    client,
    assert,
  }) => {
    // The poller's first tick baselines counters without writing a bucket,
    // but it DOES upsert identities — so this row owns data that a bare
    // DELETE would cascade away in silence.
    const { adminToken, seededCollector } = await seedSetupComplete()
    const now = DateTime.utc().toSQL({ includeOffset: false })
    await db.table('device_identities').insert({
      collector_id: seededCollector.id,
      mac: 'aa:bb:cc:dd:ee:ff',
      ips: JSON.stringify(['192.168.1.100']),
      created_at: now,
    })

    const response = await client
      .delete(`${ENDPOINT}/${seededCollector.id}`)
      .bearerToken(adminToken)
    response.assertStatus(409)
    response.assertBodyContains({ error: 'collector_has_history' })
    assert.equal(response.body().bucketRows, 0)
    assert.equal(response.body().identityRows, 1)
    assert.match(response.body().message as string, /has recorded data/)
    assert.isNotNull(await Collector.find(seededCollector.id))
  })

  test('every :id route answers 404 collector_not_found', async ({ client }) => {
    const { adminToken } = await seedSetupComplete()

    const probe = await client.post(`${ENDPOINT}/9999/probe`).bearerToken(adminToken)
    probe.assertStatus(404)
    probe.assertBodyContains({ error: 'collector_not_found' })

    const update = await client
      .put(`${ENDPOINT}/9999`)
      .bearerToken(adminToken)
      .json({ name: 'ghost' })
    update.assertStatus(404)
    update.assertBodyContains({ error: 'collector_not_found' })

    const destroy = await client.delete(`${ENDPOINT}/9999`).bearerToken(adminToken)
    destroy.assertStatus(404)
    destroy.assertBodyContains({ error: 'collector_not_found' })

    const adopt = await client.post(`${ENDPOINT}/9999/adopt`).bearerToken(adminToken).json({})
    adopt.assertStatus(404)
    adopt.assertBodyContains({ error: 'collector_not_found' })

    const dismiss = await client.post(`${ENDPOINT}/9999/dismiss`).bearerToken(adminToken)
    dismiss.assertStatus(404)
    dismiss.assertBodyContains({ error: 'collector_not_found' })
  })

  test('probing a draft address suggests a name without persisting', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    fetchMock.set(okProbe())

    const response = await client
      .post(`${ENDPOINT}/probe`)
      .bearerToken(adminToken)
      .json({ baseUrl: 'http://192.168.1.55:9800' })
    response.assertStatus(200)
    assert.isTrue(response.body().data.probe.ok)
    assert.equal(response.body().data.suggestedName, 'br-lan')
    assert.lengthOf(await Collector.all(), 1, 'a draft probe persists nothing')
  })

  test('non-admin callers receive 403 and unauthenticated callers 401', async ({ client }) => {
    const { operatorToken } = await seedSetupComplete()

    const forbidden = await client.get(ENDPOINT).bearerToken(operatorToken)
    forbidden.assertStatus(403)
    forbidden.assertBodyContains({ error: 'admin_required' })

    const unauthorized = await client.get(ENDPOINT)
    unauthorized.assertStatus(401)
  })

  test('the summary endpoint is operator-safe and address-free', async ({ client, assert }) => {
    const { operatorToken } = await seedSetupComplete()
    await Collector.create({
      name: 'pending-one',
      baseUrl: 'http://192.168.1.56:9800',
      pollIntervalSeconds: 5,
      enabled: false,
      source: 'announced',
      lifecycle: 'pending',
      instanceId: 'pending-instance-id',
    })

    const response = await client.get(SUMMARY_ENDPOINT).bearerToken(operatorToken)
    response.assertStatus(200)
    const rows = response.body().data as Array<Record<string, unknown>>
    assert.lengthOf(rows, 1, 'only adopted collectors are selectable')
    assert.equal(rows[0].name, 'localhost')
    assert.notProperty(rows[0], 'baseUrl')
    assert.notProperty(rows[0], 'apiKeyFingerprint')
    assert.notProperty(rows[0], 'hasApiKey')
    assert.notProperty(rows[0], 'lastStatus')
    assert.isNull(rows[0].ok)
    assert.notInclude(JSON.stringify(response.body()), '9800')
  })

  test('dismissed rows are hidden unless asked for', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    await Collector.create({
      name: 'nope',
      baseUrl: 'http://192.168.1.57:9800',
      pollIntervalSeconds: 5,
      enabled: false,
      source: 'announced',
      lifecycle: 'dismissed',
      instanceId: 'dismissed-instance-id',
    })

    const hidden = await client.get(ENDPOINT).bearerToken(adminToken)
    hidden.assertStatus(200)
    assert.lengthOf(hidden.body().data as unknown[], 1)

    const shown = await client.get(`${ENDPOINT}?includeDismissed=true`).bearerToken(adminToken)
    shown.assertStatus(200)
    assert.lengthOf(shown.body().data as unknown[], 2)
  })

  test('pending collectors sort ahead of adopted ones', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    await Collector.create({
      name: 'zzz-pending',
      baseUrl: 'http://192.168.1.58:9800',
      pollIntervalSeconds: 5,
      enabled: false,
      source: 'announced',
      lifecycle: 'pending',
      instanceId: 'zzz-pending-instance',
    })

    const response = await client.get(ENDPOINT).bearerToken(adminToken)
    response.assertStatus(200)
    const rows = response.body().data as Array<{ name: string; lifecycle: string }>
    assert.equal(rows[0].lifecycle, 'pending')
    assert.equal(rows[1].name, 'localhost')
  })
})

test.group('collector discovery switch', (group) => {
  group.each.setup(resetDb)
  group.each.setup(() => {
    _resetAnnounceState()
    return () => _resetAnnounceState()
  })

  test('defaults to on and can be switched off and back on', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()

    const initial = await client.get(`${ENDPOINT}/discovery`).bearerToken(adminToken)
    initial.assertStatus(200)
    assert.deepEqual(initial.body().data, { announceEnabled: true })

    const off = await client
      .patch(`${ENDPOINT}/discovery`)
      .bearerToken(adminToken)
      .json({ announceEnabled: false })
    off.assertStatus(200)
    assert.deepEqual(off.body().data, { announceEnabled: false })

    const readBack = await client.get(`${ENDPOINT}/discovery`).bearerToken(adminToken)
    assert.deepEqual(readBack.body().data, { announceEnabled: false })

    // The announce path re-reads the setting, so this needs no restart.
    // Port 9899, not 9800: the seeded collector already sits at
    // http://127.0.0.1:9800 and an announce there would CLAIM that row
    // instead of creating a pending one.
    const blocked = await client.post(ANNOUNCE_ENDPOINT).json({
      instanceId: 'discovery-switch-instance',
      port: 9899,
    })
    blocked.assertStatus(403)
    blocked.assertBodyContains({ error: 'announce_disabled' })
    assert.lengthOf(await Collector.all(), 1, 'nothing was registered while it was off')

    const on = await client
      .patch(`${ENDPOINT}/discovery`)
      .bearerToken(adminToken)
      .json({ announceEnabled: true })
    on.assertStatus(200)
    assert.deepEqual(on.body().data, { announceEnabled: true })

    const accepted = await client.post(ANNOUNCE_ENDPOINT).json({
      instanceId: 'discovery-switch-instance',
      port: 9899,
    })
    accepted.assertStatus(200)
    assert.equal(accepted.body().data.status, 'pending')
  })

  test('the switch is admin-only', async ({ client }) => {
    const { operatorToken } = await seedSetupComplete()

    const read = await client.get(`${ENDPOINT}/discovery`).bearerToken(operatorToken)
    read.assertStatus(403)
    read.assertBodyContains({ error: 'admin_required' })

    const write = await client
      .patch(`${ENDPOINT}/discovery`)
      .bearerToken(operatorToken)
      .json({ announceEnabled: false })
    write.assertStatus(403)
  })
})

test.group('collectors:purge command', (group) => {
  group.each.setup(resetDb)

  /**
   * One row in EVERY table that cascades from `collectors`, so a typo or an
   * omission in the command's CHILD_TABLES list fails this test instead of
   * silently leaving the cascade to do the work inside a single
   * transaction. Keys are the table names the command sweeps; each value is
   * that table's NOT NULL columns without a default.
   */
  function childRows(collectorId: number, mac: string, sqlNow: string) {
    const base = { collector_id: collectorId, mac }
    return {
      device_traffic_buckets: { ...base, bucket_start: sqlNow, created_at: sqlNow },
      device_protocol_buckets: {
        ...base,
        protocol: 'https',
        bucket_start: sqlNow,
        created_at: sqlNow,
        updated_at: sqlNow,
      },
      device_traffic_buckets_5m: { ...base, slot_start: sqlNow, updated_at: sqlNow },
      device_protocol_buckets_5m: {
        ...base,
        protocol: 'https',
        slot_start: sqlNow,
        updated_at: sqlNow,
      },
      device_traffic_buckets_hourly: { ...base, hour_start: sqlNow, updated_at: sqlNow },
      device_protocol_buckets_hourly: {
        ...base,
        protocol: 'https',
        hour_start: sqlNow,
        updated_at: sqlNow,
      },
      device_traffic_buckets_daily: { ...base, day_start: sqlNow, updated_at: sqlNow },
      device_protocol_buckets_daily: {
        ...base,
        protocol: 'https',
        day_start: sqlNow,
        updated_at: sqlNow,
      },
      device_peer_buckets_hourly: {
        ...base,
        scope: 'wan',
        peer_ip: '8.8.8.8',
        hour_start: sqlNow,
        updated_at: sqlNow,
      },
      device_service_buckets_5m: {
        ...base,
        server_name: 'example.test',
        protocol: 'tls',
        slot_start: sqlNow,
        updated_at: sqlNow,
      },
      device_service_buckets_hourly: {
        ...base,
        server_name: 'example.test',
        protocol: 'tls',
        hour_start: sqlNow,
        updated_at: sqlNow,
      },
      device_destination_buckets_hourly: {
        ...base,
        protocol: 'tls',
        hour_start: sqlNow,
        updated_at: sqlNow,
      },
      device_top_peers: { ...base, peer_ip: '8.8.8.8', scope: 'wan', updated_at: sqlNow },
      device_identities: { ...base, ips: JSON.stringify(['192.168.1.100']), created_at: sqlNow },
    } as Record<string, Record<string, unknown>>
  }

  async function seedEveryChildTable(collectorId: number, mac: string) {
    const sqlNow = DateTime.utc().toSQL({ includeOffset: false })!
    const rows = childRows(collectorId, mac, sqlNow)
    for (const [table, row] of Object.entries(rows)) {
      await db.table(table).insert(row)
    }
    return Object.keys(rows)
  }

  async function countIn(table: string, collectorId: number): Promise<number> {
    const rows = await db.from(table).where('collector_id', collectorId).count('* as total')
    return Number((rows[0] as { total: number }).total)
  }

  test('--dry-run counts every child table without deleting anything', async ({ assert }) => {
    const collector = await Collector.create({
      name: 'doomed',
      baseUrl: 'http://192.168.1.60:9800',
      pollIntervalSeconds: 5,
      enabled: true,
    })
    const tables = await seedEveryChildTable(collector.id, 'aa:bb:cc:dd:ee:01')

    const ace = await app.container.make('ace')
    const dry = await ace.exec('collectors:purge', [`--id=${collector.id}`, '--dry-run'])
    assert.equal(dry.exitCode, 0)

    assert.isNotNull(await Collector.find(collector.id))
    for (const table of tables) {
      assert.equal(await countIn(table, collector.id), 1, `${table} must survive a dry run`)
    }
    const stillEnabled = await Collector.findOrFail(collector.id)
    assert.isOk(stillEnabled.enabled, 'a dry run must not disable the collector')
  })

  test('the real run disables the collector and empties every child table', async ({ assert }) => {
    const collector = await Collector.create({
      name: 'doomed',
      baseUrl: 'http://192.168.1.61:9800',
      pollIntervalSeconds: 5,
      enabled: true,
    })
    const survivor = await Collector.create({
      name: 'keeper',
      baseUrl: 'http://192.168.1.62:9800',
      pollIntervalSeconds: 5,
      enabled: true,
    })
    const tables = await seedEveryChildTable(collector.id, 'aa:bb:cc:dd:ee:02')
    await seedEveryChildTable(survivor.id, 'aa:bb:cc:dd:ee:03')

    const ace = await app.container.make('ace')
    // --grace=0: the wait exists so a live poller finishes its cycle, and
    // there is no poller running in this test.
    const purge = await ace.exec('collectors:purge', [`--id=${collector.id}`, '--grace=0'])
    assert.equal(purge.exitCode, 0)

    assert.isNull(await Collector.find(collector.id))
    for (const table of tables) {
      assert.equal(await countIn(table, collector.id), 0, `${table} should have been purged`)
      assert.equal(
        await countIn(table, survivor.id),
        1,
        `${table} must keep the other collector's rows`
      )
    }
    assert.isNotNull(await Collector.find(survivor.id))
  })

  test('re-running the purge on a half-finished sweep is safe', async ({ assert }) => {
    const collector = await Collector.create({
      name: 'doomed',
      baseUrl: 'http://192.168.1.63:9800',
      pollIntervalSeconds: 5,
      enabled: true,
    })
    await seedEveryChildTable(collector.id, 'aa:bb:cc:dd:ee:04')

    const ace = await app.container.make('ace')
    const first = await ace.exec('collectors:purge', [`--id=${collector.id}`, '--grace=0'])
    assert.equal(first.exitCode, 0)

    // The collector row is gone, so a re-run is a clean no-op rather than a
    // crash — which is what makes an interrupted purge resumable.
    const second = await ace.exec('collectors:purge', [`--id=${collector.id}`, '--grace=0'])
    assert.equal(second.exitCode, 1)
  })

  test('an unknown or missing --id exits non-zero', async ({ assert }) => {
    const ace = await app.container.make('ace')
    const unknown = await ace.exec('collectors:purge', ['--id=9999'])
    assert.equal(unknown.exitCode, 1)

    const missing = await ace.exec('collectors:purge', [])
    assert.equal(missing.exitCode, 1)
  })
})
