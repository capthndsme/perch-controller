import type { ConfigDomain } from '#services/gateway_config/domain'
import { hasFeature, type GatewayCapabilities } from '#services/gateway_config/types'

/**
 * Gateway sync: WireGuard interfaces and their peers (domains.md 4).
 *
 * Skeleton (B8): registered in claim order (domains.md 11) but claims
 * nothing until work package B2 builds it, so its sections stay what they
 * are today (unmodeled mirrors). `requires` already names what the agent
 * must announce: a domain whose requirement is missing claims nothing
 * (domains.md 1.2).
 */
export const wireguardDomain: ConfigDomain = {
  key: 'wireguard',
  configs: ['network'],
  types: ['interface', 'wireguard_*'],
  requires(caps: GatewayCapabilities): string | null {
    if (!hasFeature(caps, 'config.plain_public_key')) {
      return 'The gateway agent redacts WireGuard public keys (update it)'
    }
    return null
  },
  claims: () => false,
  parse: () => [],
  render: () => [],
  validate: () => [],
}
