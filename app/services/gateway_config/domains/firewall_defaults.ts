import type { ConfigDomain } from '#services/gateway_config/domain'

/**
 * Gateway sync: the firewall `defaults` section (domains.md 5).
 *
 * Skeleton (B8): registered in claim order (domains.md 11) but claims
 * nothing until work package B3 builds it, so its sections stay what they
 * are today (unmodeled mirrors). `requires` already names what the agent
 * must announce: a domain whose requirement is missing claims nothing
 * (domains.md 1.2).
 */
export const firewallDefaultsDomain: ConfigDomain = {
  key: 'firewall_defaults',
  configs: ['firewall'],
  types: ['defaults'],
  claims: () => false,
  parse: () => [],
  render: () => [],
  validate: () => [],
}
