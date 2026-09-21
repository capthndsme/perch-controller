import {
  QUERY_CACHE_MAX_ENTRIES,
  _queryCacheSize,
  _queryCacheSweepDue,
  _resetQueryCache,
  cacheKey,
  cacheTtlForResolution,
  cachedQuery,
  windowCache,
  windowSegment,
} from '#services/query_cache'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

test.group('query_cache | cacheTtlForResolution', () => {
  test('maps known resolutions to the agreed TTLs', ({ assert }) => {
    assert.equal(cacheTtlForResolution('15s'), 10_000)
    assert.equal(cacheTtlForResolution('1m'), 15_000)
    assert.equal(cacheTtlForResolution('5m'), 20_000)
  })

  test('falls back to 30s for other resolutions', ({ assert }) => {
    assert.equal(cacheTtlForResolution('5s'), 30_000)
    assert.equal(cacheTtlForResolution('15m'), 30_000)
    assert.equal(cacheTtlForResolution('1h'), 30_000)
    assert.equal(cacheTtlForResolution(undefined), 30_000)
  })
})

test.group('query_cache | cachedQuery', (group) => {
  group.each.setup(() => {
    _resetQueryCache()
  })

  test('returns cached value within TTL without re-running fn', async ({ assert }) => {
    let runs = 0
    const fn = async () => {
      runs++
      return { n: runs }
    }

    const first = await cachedQuery('k', 5_000, fn)
    const second = await cachedQuery('k', 5_000, fn)

    assert.deepEqual(first, { n: 1 })
    assert.deepEqual(second, { n: 1 })
    assert.equal(runs, 1)
  })

  test('deduplicates concurrent callers for the same key', async ({ assert }) => {
    let runs = 0
    const fn = async () => {
      runs++
      await new Promise((resolve) => setTimeout(resolve, 20))
      return runs
    }

    const [a, b] = await Promise.all([cachedQuery('k', 5_000, fn), cachedQuery('k', 5_000, fn)])

    assert.equal(a, 1)
    assert.equal(b, 1)
    assert.equal(runs, 1)
  })

  test('does not cache rejected promises', async ({ assert }) => {
    let runs = 0
    const fn = async () => {
      runs++
      throw new Error('boom')
    }

    await assert.rejects(() => cachedQuery('k', 5_000, fn))
    await assert.rejects(() => cachedQuery('k', 5_000, fn))
    assert.equal(runs, 2)
  })
})

test.group('query_cache | bounds', (group) => {
  group.each.setup(() => {
    _resetQueryCache()
  })

  // An open dashboard asks for a new key every refresh (the window moves), so
  // entries are rarely hit again after their TTL: the cache must not keep them.
  test('never holds more than the cap; the least recently used entry goes first', async ({
    assert,
  }) => {
    await cachedQuery('keep', 60_000, async () => 'kept')
    for (let i = 0; i < QUERY_CACHE_MAX_ENTRIES + 25; i++) {
      await cachedQuery(`k${i}`, 60_000, async () => i)
      // A hit moves 'keep' to the young end, so the cap evicts others first.
      await cachedQuery('keep', 60_000, async () => 'recomputed')
    }
    assert.equal(_queryCacheSize(), QUERY_CACHE_MAX_ENTRIES)
    assert.equal(await cachedQuery('keep', 60_000, async () => 'recomputed'), 'kept')
    let reran = false
    await cachedQuery('k0', 60_000, async () => {
      reran = true
      return 0
    })
    assert.isTrue(reran, 'the oldest entry was evicted')
  })

  test('expired entries are swept, not only replaced on their next hit', async ({ assert }) => {
    for (let i = 0; i < 20; i++) await cachedQuery(`old${i}`, 1, async () => i)
    assert.equal(_queryCacheSize(), 20)
    await new Promise((resolve) => setTimeout(resolve, 5))
    _queryCacheSweepDue()
    await cachedQuery('fresh', 60_000, async () => 'x')
    assert.equal(_queryCacheSize(), 1, 'only the fresh entry is left')
  })
})

test.group('query_cache | windowSegment', () => {
  test('buckets relative windows by TTL', ({ assert }) => {
    const ttlMs = 10_000
    const until = DateTime.fromISO('2026-05-28T12:00:05.000Z', { zone: 'utc' })
    const since = until.minus({ hours: 1 })

    const a = windowSegment(since, until, ttlMs)
    // A poll two seconds later asks for the same relative range.
    const b = windowSegment(since.plus({ seconds: 2 }), until.plus({ seconds: 2 }), ttlMs)

    assert.equal(a, b)
    assert.equal(a, `${Math.floor(until.toMillis() / ttlMs)}:3600`)
  })

  test('cacheKey joins parts with colons', ({ assert }) => {
    assert.equal(cacheKey(['devices', 'index', 1, null]), 'devices:index:1:')
  })
})

test.group('query_cache | windowCache', () => {
  const now = DateTime.fromISO('2026-05-28T12:00:05.000Z', { zone: 'utc' })

  test('live window gets the resolution TTL and a TTL-bucketed segment', ({ assert }) => {
    const until = now
    const since = until.minus({ hours: 1 })
    const { ttlMs, segment } = windowCache('15s', since, until, now.toMillis())
    assert.equal(ttlMs, 10_000)
    assert.equal(segment, windowSegment(since, until, 10_000))
  })

  test('live polls a few seconds apart coalesce onto one key', ({ assert }) => {
    const since = now.minus({ hours: 1 })
    const a = windowCache('15s', since, now, now.toMillis())
    const b = windowCache(
      '15s',
      since.plus({ seconds: 2 }),
      now.plus({ seconds: 2 }),
      now.plus({ seconds: 2 }).toMillis()
    )
    assert.equal(a.segment, b.segment)
  })

  test('immutable (past) window gets the long 6h TTL', ({ assert }) => {
    const until = now.minus({ hours: 2 })
    const since = until.minus({ days: 7 })
    const { ttlMs } = windowCache('1h', since, until, now.toMillis())
    assert.equal(ttlMs, 6 * 60 * 60_000)
  })

  test('distinct historical windows do not collide on one key', ({ assert }) => {
    // Two 1-day windows ending an hour apart, both well in the past. The TTL
    // is 6h, so TTL-bucketing would alias them; the 1s grain keeps them apart.
    const untilA = now.minus({ hours: 5 })
    const untilB = untilA.plus({ hours: 1 })
    const a = windowCache('1h', untilA.minus({ days: 1 }), untilA, now.toMillis())
    const b = windowCache('1h', untilB.minus({ days: 1 }), untilB, now.toMillis())
    assert.equal(a.ttlMs, b.ttlMs)
    assert.notEqual(a.segment, b.segment)
  })
})
