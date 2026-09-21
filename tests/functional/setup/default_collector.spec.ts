import { test } from '@japa/runner'
import Collector from '#models/collector'
import { ensureDefaultCollector } from '#services/default_collector'

const okFetcher: typeof fetch = async () =>
  new Response(JSON.stringify({ total_devices: 3, interface: 'eth0' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const downFetcher: typeof fetch = async () => {
  throw new Error('connect ECONNREFUSED')
}

test.group('Default collector registration', (group) => {
  group.each.setup(async () => {
    await Collector.query().delete()
    return async () => {
      await Collector.query().delete()
    }
  })

  test('creates the collector once and reports the probe result', async ({ assert }) => {
    const first = await ensureDefaultCollector({
      baseUrl: 'http://collector.test:9800/',
      apiKey: 'secret',
      fetcher: okFetcher,
    })
    assert.equal(first.action, 'created')
    if (first.action === 'created') assert.isOk(first.ok)

    const rows = await Collector.all()
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].baseUrl, 'http://collector.test:9800')
    assert.equal(rows[0].apiKey, 'secret')
    assert.isOk(rows[0].enabled)

    const same = await ensureDefaultCollector({
      baseUrl: 'http://collector.test:9800',
      fetcher: okFetcher,
    })
    assert.deepEqual(same, { action: 'skipped', reason: 'exists' })
    assert.lengthOf(await Collector.all(), 1)
  })

  test('moves a single existing collector to the configured address', async ({ assert }) => {
    await ensureDefaultCollector({ baseUrl: 'http://old.test:9800', fetcher: okFetcher })

    const moved = await ensureDefaultCollector({
      baseUrl: 'http://172.28.0.1:9800/',
      apiKey: 'new-key',
      fetcher: okFetcher,
    })
    assert.equal(moved.action, 'updated')
    if (moved.action === 'updated') assert.equal(moved.previousBaseUrl, 'http://old.test:9800')

    const rows = await Collector.all()
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].baseUrl, 'http://172.28.0.1:9800')
    assert.equal(rows[0].apiKey, 'new-key')
  })

  test('leaves several collectors alone', async ({ assert }) => {
    await Collector.create({
      name: 'a',
      baseUrl: 'http://a.test:9800',
      pollIntervalSeconds: 5,
      enabled: true,
    })
    await Collector.create({
      name: 'b',
      baseUrl: 'http://b.test:9800',
      pollIntervalSeconds: 5,
      enabled: true,
    })

    const result = await ensureDefaultCollector({
      baseUrl: 'http://c.test:9800',
      fetcher: okFetcher,
    })
    assert.deepEqual(result, { action: 'skipped', reason: 'ambiguous' })
    const rows = await Collector.all()
    assert.sameMembers(
      rows.map((row) => row.baseUrl),
      ['http://a.test:9800', 'http://b.test:9800']
    )
  })

  test('still saves an unreachable collector so the poller keeps retrying', async ({ assert }) => {
    const result = await ensureDefaultCollector({
      baseUrl: 'http://collector.test:9800',
      fetcher: downFetcher,
    })
    assert.equal(result.action, 'created')
    if (result.action === 'created') {
      assert.isFalse(result.ok)
      assert.isString(result.error)
    }
    const row = await Collector.firstOrFail()
    assert.isNull(row.lastSeenAt)
    assert.isFalse(row.lastStatus?.ok)
  })
})

test.group('Default collector ownership', (group) => {
  group.each.setup(async () => {
    await Collector.query().delete()
    return async () => {
      await Collector.query().delete()
    }
  })

  test('rows it creates are marked source=env, lifecycle=adopted', async ({ assert }) => {
    await ensureDefaultCollector({
      baseUrl: 'http://collector.test:9800',
      apiKey: 'env-key',
      fetcher: okFetcher,
    })

    const row = await Collector.firstOrFail()
    assert.equal(row.source, 'env')
    assert.equal(row.lifecycle, 'adopted')
    assert.isNotNull(row.apiKeyFingerprint)
  })

  test('a wizard-created row is adopted as the env row on first boot', async ({ assert }) => {
    await Collector.create({
      name: 'localhost',
      baseUrl: 'http://127.0.0.1:9800',
      pollIntervalSeconds: 5,
      enabled: true,
    })

    const moved = await ensureDefaultCollector({
      baseUrl: 'http://172.28.0.1:9800',
      fetcher: okFetcher,
    })
    assert.equal(moved.action, 'updated')

    const rows = await Collector.all()
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].baseUrl, 'http://172.28.0.1:9800')
    assert.equal(rows[0].source, 'env')
  })

  test('a row already at the address is taken over rather than duplicated', async ({ assert }) => {
    await Collector.create({
      name: 'localhost',
      baseUrl: 'http://172.28.0.1:9800',
      pollIntervalSeconds: 5,
      enabled: true,
    })

    const result = await ensureDefaultCollector({
      baseUrl: 'http://172.28.0.1:9800/',
      fetcher: okFetcher,
    })
    assert.deepEqual(result, { action: 'skipped', reason: 'exists' })

    const rows = await Collector.all()
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].source, 'env')
  })

  test('a pending row at COLLECTOR_URL is adopted rather than left waiting', async ({ assert }) => {
    // The collector announced itself into the stack before the server
    // finished booting. Configuring COLLECTOR_URL for that exact address IS
    // the operator's decision to poll it, so leaving the row pending would
    // mean the packaged deployment silently collects nothing.
    const pending = await Collector.create({
      name: 'OpenWrt',
      baseUrl: 'http://172.28.0.1:9800',
      pollIntervalSeconds: 5,
      enabled: false,
      source: 'announced',
      lifecycle: 'pending',
      instanceId: 'pending-instance-id',
    })

    const result = await ensureDefaultCollector({
      baseUrl: 'http://172.28.0.1:9800',
      fetcher: okFetcher,
    })
    assert.equal(result.action, 'updated')

    const adopted = await Collector.findOrFail(pending.id)
    assert.equal(adopted.lifecycle, 'adopted')
    assert.isOk(adopted.enabled)
    assert.equal(adopted.source, 'env')
    assert.equal(adopted.baseUrl, 'http://172.28.0.1:9800')
    assert.lengthOf(await Collector.all(), 1, 'no duplicate row is created')
  })

  test('a dismissed row at COLLECTOR_URL is brought back into service', async ({ assert }) => {
    const dismissed = await Collector.create({
      name: 'OpenWrt',
      baseUrl: 'http://172.28.0.1:9800',
      pollIntervalSeconds: 5,
      enabled: false,
      source: 'announced',
      lifecycle: 'dismissed',
      instanceId: 'dismissed-instance-id',
    })

    const result = await ensureDefaultCollector({
      baseUrl: 'http://172.28.0.1:9800/',
      fetcher: okFetcher,
    })
    assert.equal(result.action, 'updated')

    const row = await Collector.findOrFail(dismissed.id)
    assert.equal(row.lifecycle, 'adopted')
    assert.isOk(row.enabled)
    assert.equal(row.source, 'env')
  })

  test('an announced collector is never moved by COLLECTOR_URL', async ({ assert }) => {
    const announced = await Collector.create({
      name: 'OpenWrt',
      baseUrl: 'http://192.168.1.1:9800',
      pollIntervalSeconds: 5,
      enabled: true,
      source: 'announced',
      lifecycle: 'adopted',
      instanceId: 'announced-instance-id',
    })

    const result = await ensureDefaultCollector({
      baseUrl: 'http://172.28.0.1:9800',
      fetcher: okFetcher,
    })
    assert.equal(result.action, 'created')

    const rows = await Collector.all()
    assert.lengthOf(rows, 2, 'a new env row is created beside the announced one')
    const untouched = await Collector.findOrFail(announced.id)
    assert.equal(untouched.baseUrl, 'http://192.168.1.1:9800')
    assert.equal(untouched.source, 'announced')
    const created = rows.find((row) => row.id !== announced.id)!
    assert.equal(created.source, 'env')
    assert.equal(created.baseUrl, 'http://172.28.0.1:9800')
  })

  test('the env row keeps winning once it is marked', async ({ assert }) => {
    await ensureDefaultCollector({ baseUrl: 'http://old.test:9800', fetcher: okFetcher })
    await Collector.create({
      name: 'OpenWrt',
      baseUrl: 'http://192.168.1.1:9800',
      pollIntervalSeconds: 5,
      enabled: true,
      source: 'announced',
      lifecycle: 'adopted',
      instanceId: 'announced-instance-id',
    })

    const moved = await ensureDefaultCollector({
      baseUrl: 'http://172.28.0.1:9800',
      fetcher: okFetcher,
    })
    assert.equal(moved.action, 'updated')
    if (moved.action === 'updated') assert.equal(moved.previousBaseUrl, 'http://old.test:9800')
    assert.lengthOf(await Collector.all(), 2)
  })
})
