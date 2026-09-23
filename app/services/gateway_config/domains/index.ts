import { DomainRegistry, type ConfigDomain } from '#services/gateway_config/domain'
import { dhcpHostsDomain } from '#services/gateway_config/domains/dhcp_hosts'
import { dhcpPoolsDomain } from '#services/gateway_config/domains/dhcp_pools'
import { dnsRecordsDomain } from '#services/gateway_config/domains/dns_records'
import { networksDomain } from '#services/gateway_config/domains/networks'

/**
 * The domains this controller models, in claim order (the first domain
 * that claims a section wins). Sibling plans add theirs here (firewall,
 * qos, portal, …).
 */
export const DOMAINS: readonly ConfigDomain[] = Object.freeze([
  dhcpHostsDomain as ConfigDomain,
  dnsRecordsDomain as ConfigDomain,
  dhcpPoolsDomain as ConfigDomain,
  networksDomain as ConfigDomain,
])

let registry: DomainRegistry | null = null

/** The process-wide registry (built once; domains are code, not data). */
export function domainRegistry(): DomainRegistry {
  registry ??= new DomainRegistry([...DOMAINS])
  return registry
}
