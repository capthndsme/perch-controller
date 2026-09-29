import type { ConfigDomain } from '#services/gateway_config/domain'

/**
 * Gateway sync: the `network` `globals` section's `ula_prefix` (domains.md 7).
 *
 * Skeleton (B8): registered in claim order (domains.md 11) but claims
 * nothing until work package B4 builds it, so its sections stay what they
 * are today (unmodeled mirrors). `requires` already names what the agent
 * must announce: a domain whose requirement is missing claims nothing
 * (domains.md 1.2).
 */
export const networkGlobalsDomain: ConfigDomain = {
  key: 'network_globals',
  configs: ['network'],
  types: ['globals'],
  claims: () => false,
  parse: () => [],
  render: () => [],
  validate: () => [],
}
