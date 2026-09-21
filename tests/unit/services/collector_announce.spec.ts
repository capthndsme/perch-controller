import {
  _resetAnnounceState,
  announceSourceAddress,
  announcedPollUrl,
  apiKeyFingerprint,
  consumeAnnounceBudget,
} from '#services/collector_announce'
import { createHash } from 'node:crypto'
import { test } from '@japa/runner'

/**
 * `POST /api/v1/collectors/announce` is the one unauthenticated endpoint on
 * the server, so its bounds are load-bearing rather than cosmetic. They are
 * pure functions over module state, which makes them cheap to pin down here
 * instead of through 60+ HTTP round trips.
 */
test.group('collector_announce | rate limiting', (group) => {
  group.each.setup(() => {
    _resetAnnounceState()
    return () => _resetAnnounceState()
  })

  const NOW = 1_700_000_000_000

  test('an address gets 12 announces a minute, and the 13th is refused', ({ assert }) => {
    for (let i = 0; i < 12; i++) {
      assert.deepEqual(
        consumeAnnounceBudget('192.168.1.1', NOW),
        { allowed: true },
        `announce ${i + 1} should be allowed`
      )
    }

    const denied = consumeAnnounceBudget('192.168.1.1', NOW)
    assert.deepEqual(denied, { allowed: false, retryAfterSeconds: 60, scope: 'address' })
  })

  test('one noisy address does not spend another address budget', ({ assert }) => {
    for (let i = 0; i < 13; i++) consumeAnnounceBudget('192.168.1.1', NOW)
    assert.isFalse(consumeAnnounceBudget('192.168.1.1', NOW).allowed)

    // A different collector on the same LAN is unaffected.
    for (let i = 0; i < 12; i++) {
      assert.isTrue(
        consumeAnnounceBudget('192.168.1.2', NOW).allowed,
        'a second address keeps its own full budget'
      )
    }
  })

  test('the per-minute window rolls over', ({ assert }) => {
    for (let i = 0; i < 12; i++) consumeAnnounceBudget('192.168.1.1', NOW)
    assert.isFalse(consumeAnnounceBudget('192.168.1.1', NOW).allowed)

    assert.isFalse(consumeAnnounceBudget('192.168.1.1', NOW + 59_999).allowed)
    assert.isTrue(consumeAnnounceBudget('192.168.1.1', NOW + 60_000).allowed)
  })

  test('the global budget is 60 a minute across every address', ({ assert }) => {
    // Five addresses spending their full per-address allowance is exactly
    // the global ceiling.
    for (let a = 1; a <= 5; a++) {
      for (let i = 0; i < 12; i++) {
        assert.isTrue(
          consumeAnnounceBudget(`10.0.0.${a}`, NOW).allowed,
          `address ${a}, announce ${i + 1}`
        )
      }
    }

    // A sixth, previously unseen address still has its own budget, but the
    // stack as a whole has none left.
    const denied = consumeAnnounceBudget('10.0.0.6', NOW)
    assert.deepEqual(denied, { allowed: false, retryAfterSeconds: 60, scope: 'global' })

    // And it recovers with the window, not before.
    assert.isFalse(consumeAnnounceBudget('10.0.0.6', NOW + 59_999).allowed)
    assert.isTrue(consumeAnnounceBudget('10.0.0.6', NOW + 60_000).allowed)
  })

  test('a refused announce does not spend global budget', ({ assert }) => {
    for (let i = 0; i < 12; i++) consumeAnnounceBudget('10.0.0.1', NOW)
    // 20 refusals for that one address must not eat into the other 48.
    for (let i = 0; i < 20; i++) consumeAnnounceBudget('10.0.0.1', NOW)

    for (let a = 2; a <= 5; a++) {
      for (let i = 0; i < 12; i++) {
        assert.isTrue(consumeAnnounceBudget(`10.0.0.${a}`, NOW).allowed)
      }
    }
    assert.isFalse(consumeAnnounceBudget('10.0.0.9', NOW).allowed)
  })
})

test.group('collector_announce | address and key helpers', () => {
  test('IPv4-mapped IPv6 source addresses are normalised', ({ assert }) => {
    assert.equal(announceSourceAddress('::ffff:192.168.1.1'), '192.168.1.1')
    assert.equal(announceSourceAddress('::FFFF:127.0.0.1'), '127.0.0.1')
    assert.equal(announceSourceAddress('192.168.1.1'), '192.168.1.1')
    assert.equal(announceSourceAddress('2001:db8::1'), '2001:db8::1')
  })

  test('the poll URL is built from the source address, bracketing IPv6', ({ assert }) => {
    assert.equal(announcedPollUrl('192.168.1.1', 9800, false), 'http://192.168.1.1:9800')
    assert.equal(announcedPollUrl('192.168.1.1', 9443, true), 'https://192.168.1.1:9443')
    assert.equal(announcedPollUrl('2001:db8::1', 9800, false), 'http://[2001:db8::1]:9800')
    assert.equal(announcedPollUrl('::1', 9800, true), 'https://[::1]:9800')
  })

  test('the fingerprint is the first 8 hex chars of sha256(key)', ({ assert }) => {
    const key = 'the-real-collector-key'
    const expected = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 8)
    assert.equal(apiKeyFingerprint(key), expected)
    assert.lengthOf(apiKeyFingerprint(key), 8)
    assert.notEqual(apiKeyFingerprint(key), apiKeyFingerprint(`${key}x`))
  })
})
