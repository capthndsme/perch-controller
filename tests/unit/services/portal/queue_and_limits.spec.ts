import {
  PORTAL_API_FAILURE_LIMIT,
  _resetPortalApiRateLimits,
  consumePortalApiRequest,
  portalApiAuthBudget,
  recordPortalApiAuthFailure,
} from '#services/portal_api_rate_limit'
import { outboxDedupeKey } from '#services/portal_agent_sender'
import { _portalQueueSize, runInPortalQueue } from '#services/portal_queue'
import { test } from '@japa/runner'

const tick = () => new Promise((resolve) => setImmediate(resolve))

test.group('portal queue', () => {
  test('one gateway runs its tasks one at a time, in order', async ({ assert }) => {
    const log: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const first = runInPortalQueue(1, async () => {
      log.push('a:start')
      await gate
      log.push('a:end')
      return 'a'
    })
    const second = runInPortalQueue(1, async () => {
      log.push('b')
      return 'b'
    })
    const other = runInPortalQueue(2, async () => {
      log.push('other')
      return 'other'
    })
    await other
    await tick()
    assert.deepEqual(log, ['a:start', 'other'])
    release()
    assert.equal(await first, 'a')
    assert.equal(await second, 'b')
    assert.deepEqual(log, ['a:start', 'other', 'a:end', 'b'])
  })

  test('a failing task rejects alone; the queue moves on and empties', async ({ assert }) => {
    const failing = runInPortalQueue(3, async () => {
      throw new Error('boom')
    })
    const next = runInPortalQueue(3, async () => 'next')
    await assert.rejects(() => failing, 'boom')
    assert.equal(await next, 'next')
    await tick()
    await tick()
    assert.equal(_portalQueueSize(), 0)
  })
})

test.group('portal API rate limits', (group) => {
  group.each.setup(() => _resetPortalApiRateLimits())

  test('per principal per minute', ({ assert }) => {
    const now = 1_000_000
    for (let i = 0; i < 10; i++) assert.isTrue(consumePortalApiRequest('c:1', 10, now).allowed)
    const refused = consumePortalApiRequest('c:1', 10, now + 30_000)
    assert.deepEqual(refused, { allowed: false, retryAfterSeconds: 30 })
    // Another principal has its own window; the next minute starts over.
    assert.isTrue(consumePortalApiRequest('c:2', 10, now).allowed)
    assert.isTrue(consumePortalApiRequest('c:1', 10, now + 60_000).allowed)
  })

  test('failed tokens per address', ({ assert }) => {
    const now = 5_000_000
    for (let i = 0; i < PORTAL_API_FAILURE_LIMIT; i++) {
      assert.isTrue(portalApiAuthBudget('192.168.1.9', now).allowed)
      recordPortalApiAuthFailure('192.168.1.9', now)
    }
    const budget = portalApiAuthBudget('192.168.1.9', now + 1000)
    assert.isFalse(budget.allowed)
    assert.isTrue(portalApiAuthBudget('192.168.1.10', now).allowed)
    assert.isTrue(portalApiAuthBudget('192.168.1.9', now + 15 * 60_000).allowed)
  })
})

test.group('portal outbox keys', () => {
  test('one pending row per gateway and kind (per portal for configure/template)', ({ assert }) => {
    assert.equal(outboxDedupeKey({ kind: 'authorize', grantIds: [1] }), 'authorize')
    assert.equal(outboxDedupeKey({ kind: 'deauthorize', grantIds: [1] }), 'deauthorize')
    assert.equal(outboxDedupeKey({ kind: 'configure', portalId: 4 }), 'configure:4')
    assert.equal(outboxDedupeKey({ kind: 'template', portalId: 4 }), 'template:4')
    assert.equal(outboxDedupeKey({ kind: 'vouchers' }), 'vouchers')
    assert.equal(outboxDedupeKey({ kind: 'sync' }), 'sync')
  })
})
