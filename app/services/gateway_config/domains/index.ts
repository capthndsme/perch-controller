import { DomainRegistry, type ConfigDomain } from '#services/gateway_config/domain'
import { dhcpHostsDomain } from '#services/gateway_config/domains/dhcp_hosts'
import { dhcpPoolsDomain } from '#services/gateway_config/domains/dhcp_pools'
import { sqmDomain } from '#services/sqm_domain'
import { perchQosDomain } from '#services/perch_qos_domain'
import { dnsRecordsDomain } from '#services/gateway_config/domains/dns_records'
import { networksDomain } from '#services/gateway_config/domains/networks'
import { firewallDomain } from '#services/gateway_config/domains/firewall'
import { systemDomain } from '#services/gateway_config/domains/system'
import { routesDomain } from '#services/gateway_config/domains/routes'
import { dnsSettingsDomain } from '#services/gateway_config/domains/dns_settings'
import { dhcpTagsDomain } from '#services/gateway_config/domains/dhcp_tags'
import { wanDomain } from '#services/gateway_config/domains/wan'
import { wireguardDomain } from '#services/gateway_config/domains/wireguard'
import { networkGlobalsDomain } from '#services/gateway_config/domains/network_globals'
import { firewallDefaultsDomain } from '#services/gateway_config/domains/firewall_defaults'
import { upnpDomain } from '#services/gateway_config/domains/upnp'
import { ddnsDomain } from '#services/gateway_config/domains/ddns'

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
 *
 * Gateway sync (docs/design/gateway-sync/domains.md 11) adds `wan`,
 * `wireguard`, `network_globals`, `firewall_defaults`, `upnp` and `ddns`.
 * `networks` and `wan` both take `interface`/`device` sections, disjoint by
 * the side rule and by device type; `wan` and `dhcp_pools` both take `dhcp`,
 * disjoint by side. `mwan3` is not registered: owner decision 12 stands
 * (multi-WAN stays read only, `multiwan_view.ts`).
 */
export const DOMAINS: readonly ConfigDomain[] = Object.freeze([
  systemDomain as ConfigDomain,
  networksDomain as ConfigDomain,
  wanDomain,
  wireguardDomain,
  networkGlobalsDomain,
  routesDomain as ConfigDomain,
  dhcpPoolsDomain as ConfigDomain,
  dhcpHostsDomain as ConfigDomain,
  dnsRecordsDomain as ConfigDomain,
  dnsSettingsDomain as ConfigDomain,
  dhcpTagsDomain as ConfigDomain,
  firewallDomain as ConfigDomain,
  firewallDefaultsDomain as ConfigDomain,
  sqmDomain as ConfigDomain,
  perchQosDomain as ConfigDomain,
  upnpDomain,
  ddnsDomain,
])

let registry: DomainRegistry | null = null

/** The process-wide registry (built once; domains are code, not data). */
export function domainRegistry(): DomainRegistry {
  registry ??= new DomainRegistry([...DOMAINS])
  return registry
}
