import type { ConfigDomain } from '#services/gateway_config/domain'
import { configAllowed, hasFeature, type GatewayCapabilities } from '#services/gateway_config/types'

/**
 * Gateway sync: WAN-side sections (domains.md 3): uplinks, IPv6 companions, aliases, the WAN device, WAN-side pools.
 *
 * Skeleton (B8): registered in claim order (domains.md 11) but claims
 * nothing until work package B1 builds it, so its sections stay what they
 * are today (unmodeled mirrors). `requires` already names what the agent
 * must announce: a domain whose requirement is missing claims nothing
 * (domains.md 1.2).
 */
export const wanDomain: ConfigDomain = {
  key: 'wan',
  configs: ['network', 'dhcp'],
  types: ['interface', 'device', 'dhcp'],
  secretOptions: ['password', 'pincode', 'pukcode'],
  requires(caps: GatewayCapabilities): string | null {
    if (!hasFeature(caps, 'config.checks.v1')) return 'The gateway agent is too old for WAN changes'
    if (!configAllowed(caps, 'network')) return 'network is not writable on the router'
    return null
  },
  claims: () => false,
  parse: () => [],
  render: () => [],
  validate: () => [],
}
