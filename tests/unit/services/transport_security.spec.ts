import { transportSecurity } from '#services/transport_security'
import { compileTrustProxy } from '#services/trust_proxy'
import { test } from '@japa/runner'
import type { IncomingMessage } from 'node:http'

type Request = Pick<IncomingMessage, 'headers' | 'socket'>

function request(
  remoteAddress: string | undefined,
  headers: Record<string, string | string[]> = {},
  encrypted = false
): Request {
  return { socket: { remoteAddress, encrypted }, headers } as unknown as Request
}

test.group('transportSecurity', () => {
  // Loopback plus the stack's gateway, as docker-compose.yml sets TRUST_PROXY.
  const trust = compileTrustProxy('loopback,172.28.0.1')

  test('a TLS socket is secure', ({ assert }) => {
    assert.isTrue(transportSecurity(request('192.168.1.20', {}, true), trust))
  })

  test('a direct plain connection is not, whatever it claims', ({ assert }) => {
    assert.isFalse(transportSecurity(request('192.168.1.20'), trust))
    assert.isFalse(
      transportSecurity(request('192.168.1.20', { 'x-forwarded-proto': 'https' }), trust)
    )
  })

  test("a trusted proxy's X-Forwarded-Proto decides", ({ assert }) => {
    assert.isTrue(transportSecurity(request('172.28.0.1', { 'x-forwarded-proto': 'https' }), trust))
    assert.isTrue(
      transportSecurity(request('::ffff:127.0.0.1', { 'x-forwarded-proto': 'HTTPS' }), trust)
    )
    assert.isFalse(transportSecurity(request('172.28.0.1', { 'x-forwarded-proto': 'http' }), trust))
    // A chain of proxies: the first value is the scheme the client used.
    assert.isTrue(
      transportSecurity(request('127.0.0.1', { 'x-forwarded-proto': 'https, http' }), trust)
    )
    assert.isTrue(
      transportSecurity(request('127.0.0.1', { 'x-forwarded-proto': ['https'] }), trust)
    )
  })

  test('a trusted proxy that does not say, or no peer at all, is unknown', ({ assert }) => {
    assert.isNull(transportSecurity(request('172.28.0.1'), trust))
    assert.isNull(transportSecurity(request('127.0.0.1', { 'x-forwarded-proto': '' }), trust))
    assert.isNull(transportSecurity(request(undefined), trust))
  })
})
