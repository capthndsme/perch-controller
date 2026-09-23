import {
  _resetRollupPass,
  bucketLabel,
  denseBuckets,
  denseSlots,
  noteRollupPass,
  parseBucketLabel,
  planSeries,
  protocolSeriesTiers,
  trafficSeriesTiers,
  withFreshness,
  type SeriesTierCandidate,
} from '#services/series_buckets'
import { test } from '@japa/runner'

function tiers(covers: { native: boolean; fiveMin: boolean }, nativeGrain = 5) {
  return [
    {
      source: 'native',
      grainSeconds: nativeGrain,
      table: 'n',
      timeColumn: 'bucket_start',
      maxBucketSeconds: 299,
      covers: covers.native,
    },
    {
      source: '5m',
      grainSeconds: 300,
      table: 'f',
      timeColumn: 'slot_start',
      covers: covers.fiveMin,
    },
    { source: '1h', grainSeconds: 3600, table: 'h', timeColumn: 'hour_start', covers: true },
  ] satisfies SeriesTierCandidate[]
}

const NOW = 1_800_000_000 // a multiple of 3600

test.group('series_buckets | planSeries', () => {
  test('the floor applies where per-poll rows cover the window', ({ assert }) => {
    const plan = planSeries({
      sinceSec: NOW - 3600,
      untilSec: NOW,
      nowSec: NOW,
      floorSeconds: 15,
      maxPoints: 1500,
      tiers: tiers({ native: true, fiveMin: true }),
    })
    assert.equal(plan.tier.source, 'native')
    assert.equal(plan.bucketSeconds, 15)
    assert.equal(plan.lastIndex - plan.firstIndex + 1, 240)
  })

  test('without per-poll rows the 5-minute tier sets the grain', ({ assert }) => {
    const plan = planSeries({
      sinceSec: NOW - 3600,
      untilSec: NOW,
      nowSec: NOW,
      floorSeconds: 15,
      maxPoints: 1500,
      tiers: tiers({ native: false, fiveMin: true }),
    })
    assert.equal(plan.tier.source, '5m')
    assert.equal(plan.bucketSeconds, 300)
  })

  test('without either, hourly', ({ assert }) => {
    const plan = planSeries({
      sinceSec: NOW - 6 * 3600,
      untilSec: NOW,
      nowSec: NOW,
      floorSeconds: 15,
      maxPoints: 1500,
      tiers: tiers({ native: false, fiveMin: false }),
    })
    assert.equal(plan.tier.source, '1h')
    assert.equal(plan.bucketSeconds, 3600)
  })

  test('a width that is a multiple of 5 minutes reads the 5-minute tier, not the per-poll one', ({
    assert,
  }) => {
    const plan = planSeries({
      sinceSec: NOW - 3 * 86400,
      untilSec: NOW,
      nowSec: NOW,
      floorSeconds: 15,
      maxPoints: 1500,
      tiers: tiers({ native: true, fiveMin: true }),
    })
    assert.equal(plan.bucketSeconds, 300)
    assert.equal(plan.tier.source, '5m')
  })

  test('per-poll rows never serve 5-minute or wider buckets', ({ assert }) => {
    const plan = planSeries({
      sinceSec: NOW - 5 * 86400,
      untilSec: NOW,
      nowSec: NOW,
      floorSeconds: 15,
      maxPoints: 1500,
      tiers: tiers({ native: true, fiveMin: false }),
    })
    assert.equal(plan.tier.source, '1h')
    assert.equal(plan.bucketSeconds, 3600)
  })

  test('buckets are whole multiples of the collector poll interval', ({ assert }) => {
    const plan = planSeries({
      sinceSec: NOW - 3600,
      untilSec: NOW,
      nowSec: NOW,
      floorSeconds: 15,
      maxPoints: 1500,
      tiers: tiers({ native: true, fiveMin: true }, 10),
    })
    assert.equal(plan.bucketSeconds, 20)
    assert.equal(plan.tier.source, 'native')
  })

  test('an off-ladder floor is used as is', ({ assert }) => {
    const plan = planSeries({
      sinceSec: NOW - 3600,
      untilSec: NOW,
      nowSec: NOW,
      floorSeconds: 25,
      maxPoints: 1500,
      tiers: tiers({ native: true, fiveMin: true }),
    })
    assert.equal(plan.bucketSeconds, 25)
  })

  test('the point cap holds for any window', ({ assert }) => {
    for (const span of [3600, 86400, 30 * 86400, 400 * 86400, 100 * 365 * 86400]) {
      const plan = planSeries({
        sinceSec: NOW - span,
        untilSec: NOW,
        nowSec: NOW,
        floorSeconds: 15,
        maxPoints: 1500,
        tiers: tiers({ native: true, fiveMin: true }),
      })
      assert.isAtMost(plan.lastIndex - plan.firstIndex + 1, 1500, `span ${span}`)
      assert.equal(plan.bucketSeconds % plan.tier.grainSeconds, 0)
    }
  })

  test('a window in the future has no buckets', ({ assert }) => {
    const plan = planSeries({
      sinceSec: NOW + 60,
      untilSec: NOW + 3600,
      nowSec: NOW,
      floorSeconds: 15,
      maxPoints: 1500,
      tiers: tiers({ native: true, fiveMin: true }),
    })
    assert.lengthOf(denseBuckets(plan, new Map()), 0)
  })
})

test.group('series_buckets | denseBuckets', () => {
  test('fills gaps with zero and gives edge buckets their real seconds', ({ assert }) => {
    const plan = planSeries({
      sinceSec: NOW - 3600 + 7,
      untilSec: NOW - 3600 + 67,
      nowSec: NOW,
      floorSeconds: 15,
      maxPoints: 1500,
      tiers: tiers({ native: true, fiveMin: true }),
    })
    const idx = (NOW - 3600) / 15
    const buckets = denseBuckets(plan, new Map([[idx + 4, [30, 0] as [number, number]]]))
    assert.deepEqual(
      buckets.map((b) => [b.seconds, b.a]),
      [
        [5, 0],
        [15, 0],
        [15, 0],
        [15, 0],
        [10, 30],
      ]
    )
    assert.equal(
      buckets.reduce((sum, b) => sum + b.seconds, 0),
      60,
      'the seconds add up to the covered span'
    )
  })

  test('the live bucket stops at now', ({ assert }) => {
    const plan = planSeries({
      sinceSec: NOW - 3600,
      untilSec: NOW + 1,
      nowSec: NOW - 100,
      floorSeconds: 15,
      maxPoints: 1500,
      tiers: tiers({ native: true, fiveMin: true }),
    })
    const buckets = denseBuckets(plan, new Map())
    assert.equal(buckets[buckets.length - 1].seconds, 5)
  })
})

test.group('series_buckets | labels', () => {
  test('labels round-trip', ({ assert }) => {
    for (const s of [5, 15, 60, 120, 300, 3600, 7200, 86400, 604800]) {
      assert.equal(parseBucketLabel(bucketLabel(s)), s)
    }
    assert.equal(bucketLabel(15), '15s')
    assert.equal(bucketLabel(600), '10m')
    assert.equal(bucketLabel(86400), '1d')
  })
})

test.group('series_buckets | device tiers', () => {
  const covered = (list: ReturnType<typeof trafficSeriesTiers>) =>
    list.map((t) => ({ ...t, covers: true }))

  test('top talkers: 15 s from per-poll rows for an hour, hourly for a month', ({ assert }) => {
    const hour = planSeries({
      sinceSec: NOW - 3600,
      untilSec: NOW,
      nowSec: NOW,
      floorSeconds: 15,
      maxPoints: 1500,
      tiers: covered(trafficSeriesTiers(5)),
    })
    assert.equal(hour.tier.table, 'device_traffic_buckets')
    assert.equal(hour.bucketSeconds, 15)

    const month = planSeries({
      sinceSec: NOW - 30 * 86400,
      untilSec: NOW,
      nowSec: NOW,
      floorSeconds: 15,
      maxPoints: 1500,
      requestedSeconds: 3600,
      tiers: covered(trafficSeriesTiers(5)),
    })
    assert.equal(month.tier.source, '1h')
    assert.equal(month.bucketSeconds, 3600)

    const year = planSeries({
      sinceSec: NOW - 365 * 86400,
      untilSec: NOW,
      nowSec: NOW,
      floorSeconds: 86400,
      maxPoints: 1500,
      tiers: covered(trafficSeriesTiers(5)),
    })
    assert.equal(year.tier.source, '1d')
  })

  test('protocols: never finer than the per-minute rows', ({ assert }) => {
    const plan = planSeries({
      sinceSec: NOW - 3600,
      untilSec: NOW,
      nowSec: NOW,
      floorSeconds: 15,
      maxPoints: 1500,
      tiers: covered(protocolSeriesTiers(60)),
    })
    assert.equal(plan.tier.source, 'native')
    assert.equal(plan.bucketSeconds, 60)
  })

  test('protocols: more than two days go to the hourly tier, not the 5-minute one', ({
    assert,
  }) => {
    const plan = planSeries({
      sinceSec: NOW - 3 * 86400,
      untilSec: NOW,
      nowSec: NOW,
      floorSeconds: 15,
      maxPoints: 1500,
      tiers: covered(protocolSeriesTiers(60)),
    })
    // 3 d / 1500 points = 173 s; 300 or 600 s would need the 5-minute tier.
    assert.equal(plan.tier.source, '1h')
    assert.equal(plan.bucketSeconds, 3600)

    const oneDay = planSeries({
      sinceSec: NOW - 86400,
      untilSec: NOW,
      nowSec: NOW,
      floorSeconds: 300,
      maxPoints: 1500,
      tiers: covered(protocolSeriesTiers(60)),
    })
    assert.equal(oneDay.tier.source, '5m')
  })
})

test.group('series_buckets | freshness', (group) => {
  group.each.teardown(() => _resetRollupPass())

  test('per-poll tiers end at the previous poll; the live bucket counts only that', ({
    assert,
  }) => {
    const now = NOW + 7 // two seconds into the second poll of the minute
    const tiersFresh = withFreshness(tiers({ native: true, fiveMin: true }), {
      nowSec: now,
      pollSeconds: 5,
    })
    // Every tier here is unmarked except what the helper marks.
    assert.isUndefined(tiersFresh[0].dataUntilSec)
    const marked = withFreshness(
      tiers({ native: true, fiveMin: true }).map((t) => ({ ...t, freshness: 'poll' as const })),
      { nowSec: now, pollSeconds: 5 }
    )
    assert.equal(marked[0].dataUntilSec, NOW)
    const plan = planSeries({
      sinceSec: NOW - 60,
      untilSec: now,
      nowSec: now,
      floorSeconds: 15,
      maxPoints: 1500,
      tiers: marked,
    })
    assert.equal(plan.effUntilSec, NOW)
    const slots = denseSlots(plan)
    assert.equal(slots.at(-1)!.bucketEnd, new Date(NOW * 1000).toISOString())
    assert.equal(
      slots.reduce((sum, b) => sum + b.seconds, 0),
      60,
      'no seconds past the last complete poll'
    )
  })

  test('rollup tiers end at the last rollup pass, now before the first one', ({ assert }) => {
    const rollup = tiers({ native: false, fiveMin: true }).map((t) => ({
      ...t,
      freshness: 'rollup' as const,
    }))
    assert.isUndefined(withFreshness(rollup, { nowSec: NOW, pollSeconds: 5 })[1].dataUntilSec)
    noteRollupPass(NOW - 40)
    const fresh = withFreshness(rollup, { nowSec: NOW, pollSeconds: 5 })
    assert.equal(fresh[1].dataUntilSec, NOW - 40)
    const plan = planSeries({
      sinceSec: NOW - 3 * 86400,
      untilSec: NOW,
      nowSec: NOW,
      floorSeconds: 600,
      maxPoints: 1500,
      tiers: fresh,
    })
    assert.equal(plan.tier.source, '5m')
    assert.equal(plan.effUntilSec, NOW - 40)
    assert.equal(denseSlots(plan).at(-1)!.seconds, 600 - 40)
  })
})
