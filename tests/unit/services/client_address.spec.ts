import { deriveClientAddress } from '#services/client_address'
import { compileTrustProxy } from '#services/trust_proxy'
import { test } from '@japa/runner'

test.group('deriveClientAddress', () => {
  const loopback = compileTrustProxy('loopback')
  const stack = compileTrustProxy('loopback,172.28.0.1')

  test('a direct connection is its own address; X-Forwarded-For is ignored', ({ assert }) => {
    assert.equal(deriveClientAddress('192.168.1.20', '203.0.113.9', loopback), '192.168.1.20')
    assert.equal(deriveClientAddress('192.168.1.20', undefined, loopback), '192.168.1.20')
  })

  test('a trusted proxy speaks for its client', ({ assert }) => {
    assert.equal(deriveClientAddress('127.0.0.1', '192.168.1.20', loopback), '192.168.1.20')
    assert.equal(deriveClientAddress('::1', '192.168.1.20', loopback), '192.168.1.20')
  })

  test('walks right to left and stops at the first untrusted hop', ({ assert }) => {
    // client → spoofed entry → Apache (loopback) → stack gateway → server
    assert.equal(
      deriveClientAddress('172.28.0.1', '10.9.9.9, 192.168.1.20, 127.0.0.1', stack),
      '192.168.1.20'
    )
  })

  test('when every hop is trusted the left-most wins', ({ assert }) => {
    assert.equal(deriveClientAddress('127.0.0.1', '127.0.0.2', loopback), '127.0.0.2')
  })

  test('trusted proxy without a header is the address itself', ({ assert }) => {
    assert.equal(deriveClientAddress('127.0.0.1', undefined, loopback), '127.0.0.1')
    assert.equal(deriveClientAddress('127.0.0.1', ['192.168.1.20'], loopback), '192.168.1.20')
  })

  test('IPv4-mapped IPv6 is reported as IPv4', ({ assert }) => {
    assert.equal(deriveClientAddress('::ffff:192.168.1.20', undefined, loopback), '192.168.1.20')
  })

  test('no socket address, no answer', ({ assert }) => {
    assert.isNull(deriveClientAddress(undefined, '192.168.1.20', loopback))
  })
})
