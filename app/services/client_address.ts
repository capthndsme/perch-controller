import type { TrustProxyPredicate } from '#services/trust_proxy'

/**
 * The client address of a raw Node request, for code paths the Adonis
 * request object never sees (the WebSocket `upgrade` event).
 *
 * Same algorithm as `proxy-addr` (what `request.ip()` uses): start at the
 * socket's remote address and walk left through `X-Forwarded-For` for as
 * long as the current hop is trusted; the first untrusted hop is the
 * client. When every hop is trusted the left-most one wins. With the
 * default `loopback` trust list an Apache on the same box is skipped and
 * the address it forwarded is returned; a direct connection returns the
 * socket address and the header is ignored.
 *
 * IPv4-mapped IPv6 (`::ffff:192.168.1.10`) is reported as plain IPv4, like
 * the collector announce path does.
 */
export function deriveClientAddress(
  remoteAddress: string | undefined | null,
  forwardedFor: string | string[] | undefined | null,
  trust: TrustProxyPredicate
): string | null {
  if (!remoteAddress) return null

  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor
  const hops = header
    ? header
        .split(',')
        .map((hop) => hop.trim())
        .filter((hop) => hop.length > 0)
        .reverse()
    : []
  const addresses = [remoteAddress, ...hops]

  for (let i = 0; i < addresses.length - 1; i++) {
    if (!trust(addresses[i], i)) return unmapIpv4(addresses[i])
  }
  return unmapIpv4(addresses[addresses.length - 1])
}

function unmapIpv4(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  return mapped ? mapped[1] : address
}
