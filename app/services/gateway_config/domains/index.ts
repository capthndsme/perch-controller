import { DomainRegistry, type ConfigDomain } from '#services/gateway_config/domain'
import { dhcpHostsDomain } from '#services/gateway_config/domains/dhcp_hosts'
import { dhcpPoolsDomain } from '#services/gateway_config/domains/dhcp_pools'
import { sqmDomain } from '#services/sqm_domain'
import { dnsRecordsDomain } from '#services/gateway_config/domains/dns_records'
import { networksDomain } from '#services/gateway_config/domains/networks'
import { firewallDomain } from '#services/gateway_config/domains/firewall'
import { systemDomain } from '#services/gateway_config/domains/system'
import { routesDomain } from '#services/gateway_config/domains/routes'
import { dnsSettingsDomain } from '#services/gateway_config/domains/dns_settings'
import { dhcpTagsDomain } from '#services/gateway_config/domains/dhcp_tags'

/**
 * The domains this controller models, in claim order (the first domain
 * that claims a section wins). Sibling plans add theirs here (firewall,
 * qos, portal, …).
 *
 * Apply planning does not depend on this order: jobs, revisions and the
 * sync walk sort by config (`compareConfigs`, README 3.5). No two domains
 * claim the same config + type today, so the order only matters for a
 * future overlap; it follows the apply order anyway (system → network →
 * dhcp → firewall → sqm / perch-qos) so the list reads like a job. The
 * plan 2 phase 4 domains (docs/gateway/native-sync.md): `system`, `routes`
 * (network), `dns_settings` and `dhcp_tags` (dhcp).
 */
export const DOMAINS: readonly ConfigDomain[] = Object.freeze([
  systemDomain as ConfigDomain,
  networksDomain as ConfigDomain,
  routesDomain as ConfigDomain,
  dhcpPoolsDomain as ConfigDomain,
  dhcpHostsDomain as ConfigDomain,
  dnsRecordsDomain as ConfigDomain,
  dnsSettingsDomain as ConfigDomain,
  dhcpTagsDomain as ConfigDomain,
  firewallDomain as ConfigDomain,
  sqmDomain as ConfigDomain,
])

let registry: DomainRegistry | null = null

/** The process-wide registry (built once; domains are code, not data). */
export function domainRegistry(): DomainRegistry {
  registry ??= new DomainRegistry([...DOMAINS])
  return registry
}
