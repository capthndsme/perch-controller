import type { IncomingMessage } from 'node:http'
import type { TLSSocket } from 'node:tls'
import type { TrustProxyPredicate } from '#services/trust_proxy'

/**
 * Whether a raw Node request reached the controller over TLS, as far as it
 * can tell (for the WebSocket `upgrade` path, which the Adonis request object
 * never sees; the settings pages show it next to each agent):
 *
 *   - the socket itself is TLS: true;
 *   - the socket comes from a trusted proxy (TRUST_PROXY, as for the client
 *     address): the first value of its `X-Forwarded-Proto` (the scheme the
 *     client used), true for "https" and false otherwise; null without the
 *     header, since such a proxy may terminate TLS without saying so (Apache
 *     only sends it when told to: `RequestHeader set X-Forwarded-Proto "https"`);
 *   - otherwise a direct connection to this plain HTTP server: false. The
 *     header is ignored there, so a client cannot claim TLS it does not use.
 */
export function transportSecurity(
  request: Pick<IncomingMessage, 'headers' | 'socket'>,
  trust: TrustProxyPredicate
): boolean | null {
  const socket = request.socket as Partial<TLSSocket> | undefined
  if (socket?.encrypted) return true
  const peer = socket?.remoteAddress
  if (!peer) return null
  if (!trust(peer, 0)) return false
  const header = request.headers['x-forwarded-proto']
  const first = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.trim().toLowerCase()
  if (!first) return null
  return first === 'https'
}
