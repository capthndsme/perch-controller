import { generateKeyPairSync, randomBytes } from 'node:crypto'

/**
 * WireGuard keys the controller makes (docs/design/gateway-sync/rest.md 4):
 * a client's key pair for a one-time client config, and preshared keys.
 * Curve25519 through Node's X25519, raw 32-byte keys exported via JWK
 * (`d`, `x`: base64url) as WireGuard's base64. A client's private key goes
 * only into the config text returned once: never logged, stored or sent to
 * the router.
 */

function b64(base64url: string): string {
  return Buffer.from(base64url, 'base64url').toString('base64')
}

export function wgKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync('x25519')
  const jwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string }
  return { privateKey: b64(jwk.d), publicKey: b64(jwk.x) }
}

/** A preshared key: 32 random bytes, base64. */
export function wgPresharedKey(): string {
  return randomBytes(32).toString('base64')
}

export type ClientConfigInput = {
  privateKey: string
  addresses: string[]
  dns: string[]
  serverPublicKey: string
  presharedKey: string | null
  endpoint: string
  allowedIps: string[]
  keepalive: number | null
}

/** A wg-quick client config. */
export function clientConfigText(c: ClientConfigInput): string {
  const lines = [
    '[Interface]',
    `PrivateKey = ${c.privateKey}`,
    `Address = ${c.addresses.join(', ')}`,
  ]
  if (c.dns.length > 0) lines.push(`DNS = ${c.dns.join(', ')}`)
  lines.push('', '[Peer]', `PublicKey = ${c.serverPublicKey}`)
  if (c.presharedKey) lines.push(`PresharedKey = ${c.presharedKey}`)
  lines.push(`Endpoint = ${c.endpoint}`, `AllowedIPs = ${c.allowedIps.join(', ')}`)
  if (c.keepalive) lines.push(`PersistentKeepalive = ${c.keepalive}`)
  return `${lines.join('\n')}\n`
}
