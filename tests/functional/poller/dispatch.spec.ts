import Collector from '#models/collector'
import { _resetPollerState, nextAttemptAtFor, pollOnce } from '#services/collector_poller'
import PollCollectorsTask from '#tasks/poll_collectors.task'
import testUtils from '@adonisjs/core/services/test_utils'
import { DateTime } from 'luxon'
import { test } from '@japa/runner'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

const NOW = DateTime.fromISO('2026-09-21T12:00:00.000Z', { zone: 'utc' })
/**
 * 5 s, so the FAILURE_BACKOFF_MS ladder (10 s, 20 s, 40 s, 60 s) dominates
 * the `max(interval, backoff)` floor and the growth is observable.
 */
const POLL_INTERVAL_SECONDS = 5

/** Every fetch rejects, the way an unplugged collector behaves. */
const downFetcher = (async () => {
  throw new TypeError('fetch failed')
}) as unknown as typeof fetch

/** A minimal but complete pair of collector responses. */
function upFetcher(startedAt = '2026-09-21T10:00:00.000Z'): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0]) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '')
    if (path === '/api/v1/summary') {
      return new Response(
        JSON.stringify({
          summary: { started_at: startedAt, total_devices: 0 },
          meta: { capture_interface: 'br-lan' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    if (path === '/api/v1/devices') {
      return new Response(JSON.stringify({ devices: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    // /api/v1/protocols and anything else: not found is fine, the poller
    // treats the category sync as best-effort.
    return new Response('{}', { status: 404 })
  }) as typeof fetch
}

async function makeCollector(overrides: Partial<Record<string, unknown>> = {}) {
  return Collector.create({
    name: 'dispatch-test',
    baseUrl: 'http://127.0.0.1:9800',
    pollIntervalSeconds: POLL_INTERVAL_SECONDS,
    enabled: true,
    apiKey: null,
    lastStatus: null,
    ...overrides,
  })
}

test.group('poller dispatch scheduling', (group) => {
  group.each.setup(resetDb)
  group.each.setup(() => {
    _resetPollerState()
    return () => _resetPollerState()
  })

  test('a failing poll backs off, and the backoff grows', async ({ assert }) => {
    const collector = await makeCollector()

    const first = await pollOnce(collector, { fetcher: downFetcher, now: () => NOW })
    assert.equal(first.status, 'failed')
    const afterOne = nextAttemptAtFor(collector.id)
    assert.isAbove(afterOne, NOW.toMillis(), 'a dead collector must not be due again immediately')

    await pollOnce(collector, { fetcher: downFetcher, now: () => NOW })
    const afterTwo = nextAttemptAtFor(collector.id)
    await pollOnce(collector, { fetcher: downFetcher, now: () => NOW })
    const afterThree = nextAttemptAtFor(collector.id)

    assert.isAbove(afterTwo, afterOne)
    assert.isAbove(afterThree, afterTwo)
    // Never shorter than the collector's own interval, and capped at 60 s.
    assert.isAtLeast(afterOne - NOW.toMillis(), POLL_INTERVAL_SECONDS * 1000)
    assert.isAtMost(afterThree - NOW.toMillis(), 60_000)
    assert.equal(afterOne - NOW.toMillis(), 10_000)
    assert.equal(afterTwo - NOW.toMillis(), 20_000)
    assert.equal(afterThree - NOW.toMillis(), 40_000)
  })

  test('a success resets the streak and schedules one interval ahead', async ({ assert }) => {
    const collector = await makeCollector()

    await pollOnce(collector, { fetcher: downFetcher, now: () => NOW })
    await pollOnce(collector, { fetcher: downFetcher, now: () => NOW })
    assert.isAbove(nextAttemptAtFor(collector.id), NOW.toMillis() + POLL_INTERVAL_SECONDS * 1000)

    const outcome = await pollOnce(collector, { fetcher: upFetcher(), now: () => NOW })
    assert.notEqual(outcome.status, 'failed')
    assert.equal(
      nextAttemptAtFor(collector.id),
      NOW.toMillis() + POLL_INTERVAL_SECONDS * 1000 - 1500
    )

    // And the streak really is reset: the next failure starts from one again.
    await pollOnce(collector, { fetcher: downFetcher, now: () => NOW })
    const reloaded = await Collector.findOrFail(collector.id)
    assert.equal(reloaded.lastStatus?.failures, 1)
  })

  test('last_status.failures counts up and disappears on success', async ({ assert }) => {
    const collector = await makeCollector()

    await pollOnce(collector, { fetcher: downFetcher, now: () => NOW })
    let row = await Collector.findOrFail(collector.id)
    assert.isFalse(row.lastStatus?.ok)
    assert.equal(row.lastStatus?.failures, 1)

    await pollOnce(collector, { fetcher: downFetcher, now: () => NOW })
    row = await Collector.findOrFail(collector.id)
    assert.equal(row.lastStatus?.failures, 2)

    await pollOnce(collector, { fetcher: upFetcher(), now: () => NOW })
    row = await Collector.findOrFail(collector.id)
    assert.isTrue(row.lastStatus?.ok)
    assert.isUndefined(row.lastStatus?.failures)
    // A successful poll mirrors the interface into its own column.
    assert.equal(row.captureInterface, 'br-lan')
  })

  test('pending and dismissed rows are never dispatched', async ({ assert }) => {
    const pending = await makeCollector({
      name: 'pending',
      baseUrl: 'http://127.0.0.1:9801',
      // Deliberately enabled: the lifecycle filter is what must stop it.
      enabled: true,
      source: 'announced',
      lifecycle: 'pending',
      instanceId: 'pending-instance',
    })
    const dismissed = await makeCollector({
      name: 'dismissed',
      baseUrl: 'http://127.0.0.1:9802',
      enabled: true,
      source: 'announced',
      lifecycle: 'dismissed',
      instanceId: 'dismissed-instance',
    })
    const adopted = await makeCollector({
      name: 'adopted',
      baseUrl: 'http://127.0.0.1:9803',
      enabled: true,
    })

    const original = globalThis.fetch
    globalThis.fetch = downFetcher
    try {
      await new PollCollectorsTask().run()
    } finally {
      globalThis.fetch = original
    }

    // Only the adopted row was attempted, so only it has a status.
    const pendingRow = await Collector.findOrFail(pending.id)
    const dismissedRow = await Collector.findOrFail(dismissed.id)
    const adoptedRow = await Collector.findOrFail(adopted.id)
    assert.isNull(pendingRow.lastStatus)
    assert.isNull(dismissedRow.lastStatus)
    assert.isNotNull(adoptedRow.lastStatus)
    assert.equal(nextAttemptAtFor(pending.id), 0)
    assert.equal(nextAttemptAtFor(dismissed.id), 0)
    assert.isAbove(nextAttemptAtFor(adopted.id), 0)
  })
})
