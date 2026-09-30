import { DomainRegistry, type ConfigDomain } from '#services/gateway_config/domain'
import { apVlansDomain } from '#services/wifi_config/domains/ap_vlans'
import { wifiIfacesDomain } from '#services/wifi_config/domains/wifi_ifaces'
import { wifiRadiosDomain } from '#services/wifi_config/domains/wifi_radios'
import type { ApCapabilities } from '#services/wifi_config/types'

export { AP_VLANS_DOMAIN } from '#services/wifi_config/domains/ap_vlans'
export { WIFI_IFACES_DOMAIN } from '#services/wifi_config/domains/wifi_ifaces'
export { WIFI_RADIOS_DOMAIN } from '#services/wifi_config/domains/wifi_radios'

/**
 * The per-AP domain registry of the Wi-Fi plane (docs/design/wifi
 * controller.md section 3). Claim order = apply-relevant order:
 * `wifi_radios`, `wifi_ifaces`, `ap_vlans` (then `wifi_groups`, phase 4).
 *
 * Built per AP from its capabilities (the ownership of `country`, htmode
 * families, validation limits) and cheap to build: callers make one per
 * read or plan instead of caching it. `ap_vlans` joins with phase 3
 * (`vlans: true`); until then `network` sections stay unmodeled mirrors.
 */
export interface ApRegistryOptions {
  /** Register `ap_vlans` (phase 3: VLAN-bound SSIDs). */
  vlans?: boolean
  /** `ap_configs.trunk_override`: the trunk port the admin set. */
  trunkOverride?: string | null
}

export function apDomains(
  caps: ApCapabilities | null,
  options: ApRegistryOptions = {}
): ConfigDomain[] {
  const domains: ConfigDomain[] = [
    wifiRadiosDomain(caps) as ConfigDomain,
    wifiIfacesDomain(caps) as ConfigDomain,
  ]
  if (options.vlans) {
    domains.push(apVlansDomain(caps, { trunkOverride: options.trunkOverride }) as ConfigDomain)
  }
  return domains
}

export function apRegistry(
  caps: ApCapabilities | null,
  options: ApRegistryOptions = {}
): DomainRegistry {
  return new DomainRegistry(apDomains(caps, options))
}
