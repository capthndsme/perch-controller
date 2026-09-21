import { DEFAULT_TRUST_PROXY, compileTrustProxy } from '#services/trust_proxy'
import { test } from '@japa/runner'

/**
 * `TRUST_PROXY` decides whose `X-Forwarded-For` the server believes, and
 * `request.ip()` is what the collector announce endpoint derives a poll
 * address from — so a list that silently compiles to the wrong thing is a
 * security bug, not a logging one.
 */
test.group('trust_proxy | compileTrustProxy', () => {
  test('the default trusts loopback and nothing else', ({ assert }) => {
    const trusts = compileTrustProxy(DEFAULT_TRUST_PROXY)
    assert.isTrue(trusts('127.0.0.1', 0))
    assert.isTrue(trusts('::1', 0))
    assert.isFalse(trusts('172.28.0.1', 0))
    assert.isFalse(trusts('192.168.1.10', 0))
  })

  test('a multi-token list is the union of its tokens', ({ assert }) => {
    const trusts = compileTrustProxy('loopback,172.28.0.1')
    assert.isTrue(trusts('127.0.0.1', 0))
    assert.isTrue(trusts('172.28.0.1', 0))
    // The gateway is trusted; its siblings on the same /24 are not.
    assert.isFalse(trusts('172.28.0.2', 0))
    assert.isFalse(trusts('172.28.0.99', 0))
  })

  test('CIDR ranges and presets mix', ({ assert }) => {
    const trusts = compileTrustProxy('loopback, 10.8.0.0/24 , uniquelocal')
    assert.isTrue(trusts('127.0.0.1', 0))
    assert.isTrue(trusts('10.8.0.7', 0))
    assert.isTrue(trusts('192.168.1.10', 0), 'uniquelocal covers 192.168/16')
    // 172.32/12 is outside uniquelocal's 172.16.0.0/12, and 8.8.8.8 is
    // outside everything — neither may speak for a client.
    assert.isFalse(trusts('172.32.0.1', 0))
    assert.isFalse(trusts('8.8.8.8', 0))
  })

  test('whitespace and empty tokens are ignored', ({ assert }) => {
    const trusts = compileTrustProxy('  , loopback ,, ')
    assert.isTrue(trusts('127.0.0.1', 0))
    assert.isFalse(trusts('10.0.0.1', 0))
  })

  test('an empty list falls back to the default', ({ assert }) => {
    const trusts = compileTrustProxy('   ')
    assert.isTrue(trusts('127.0.0.1', 0))
    assert.isFalse(trusts('172.28.0.1', 0))
  })

  test('a malformed token throws instead of silently trusting nothing', ({ assert }) => {
    assert.throws(() => compileTrustProxy('loopback,not-an-address'))
    assert.throws(() => compileTrustProxy('10.0.0.0/999'))
    // The bug this guards: proxy-addr rejects a comma list, so passing the
    // raw string through would have aborted the process at boot.
    assert.doesNotThrow(() => compileTrustProxy('loopback,172.28.0.1'))
  })
})
