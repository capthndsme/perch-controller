import { classRateKey, type QosLiveEntry } from '#services/qos_live'
import { bucketLive, policyLive } from '#services/qos_views'
import { test } from '@japa/runner'

/** A live entry whose report carries the classes given, with the measured rates given. */
function entry(
  classes: Array<{ key: string; id: string; dir: 'down' | 'up' }>,
  rates: Record<string, number | null>
): QosLiveEntry {
  return {
    collectorId: 1,
    gatewayId: 1,
    gatewayCheckedAt: 0,
    report: { classes } as unknown as QosLiveEntry['report'],
    receivedAt: 0,
    classRates: new Map(
      Object.entries(rates).map(([key, kbit]) => [key, { kbit, dropPct: null }])
    ) as unknown as QosLiveEntry['classRates'],
    wanRates: new Map(),
    events: [],
    lastResendAt: null,
  }
}

const BUCKET = [
  { key: 'b:7', id: '1:7', dir: 'down' as const },
  { key: 'b:7', id: '1:7', dir: 'up' as const },
]

test.group('qos views | a bucket policy live rates', () => {
  test('an unmeasured direction is unknown (null), never a 0 drop', ({ assert }) => {
    // First report after a restart: the class is there, no rate yet.
    assert.deepEqual(policyLive(bucketLive(entry(BUCKET, {}), 7), 2), {
      downloadKbit: null,
      uploadKbit: null,
      activeMembers: 2,
    })
    // Download measured, upload not.
    const half = entry(BUCKET, { [classRateKey('1:7', 'down')]: 5000 })
    assert.deepEqual(policyLive(bucketLive(half, 7), 1), {
      downloadKbit: 5000,
      uploadKbit: null,
      activeMembers: 1,
    })
  })

  test('measured rates add up; a report without the class is 0; no report is null', ({
    assert,
  }) => {
    const both = entry([...BUCKET, { key: 'b:7', id: '1:8', dir: 'down' }], {
      [classRateKey('1:7', 'down')]: 3000,
      [classRateKey('1:8', 'down')]: 1000,
      [classRateKey('1:7', 'up')]: 0,
    })
    assert.deepEqual(policyLive(bucketLive(both, 7), 3), {
      downloadKbit: 4000,
      uploadKbit: 0,
      activeMembers: 3,
    })
    assert.deepEqual(policyLive(bucketLive(entry([], {}), 7), 0), {
      downloadKbit: 0,
      uploadKbit: 0,
      activeMembers: 0,
    })
    assert.isNull(policyLive(bucketLive(null, 7), 0))
  })
})
