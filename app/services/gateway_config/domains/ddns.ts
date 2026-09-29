import type { ConfigDomain } from '#services/gateway_config/domain'
import { configAllowed, type GatewayCapabilities } from '#services/gateway_config/types'

/**
 * Gateway sync: ddns-scripts services (domains.md 9).
 *
 * Skeleton (B8): registered in claim order (domains.md 11) but claims
 * nothing until work package B6 builds it, so its sections stay what they
 * are today (unmodeled mirrors). `requires` already names what the agent
 * must announce: a domain whose requirement is missing claims nothing
 * (domains.md 1.2).
 */
export const ddnsDomain: ConfigDomain = {
  key: 'ddns',
  configs: ['ddns'],
  types: ['ddns', 'service'],
  requires(caps: GatewayCapabilities): string | null {
    return configAllowed(caps, 'ddns') ? null : 'ddns is not writable on the router'
  },
  claims: () => false,
  parse: () => [],
  render: () => [],
  validate: () => [],
}
