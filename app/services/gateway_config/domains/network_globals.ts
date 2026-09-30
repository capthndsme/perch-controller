import type { ConfigDomain, FeatureSyncIssue } from '#services/gateway_config/domain'
import {
  parsePrefix,
  parseVerbatim,
  prefixContains,
  renderVerbatim,
  scalarOption,
  type VerbatimSection,
} from '#services/gateway_config/domains/verbatim'
import type { Issue } from '#services/gateway_config/types'

/**
 * Gateway sync: the `network` `globals` section (docs/design/gateway-sync/
 * domains.md 7). Perch owns `ula_prefix` alone; `packet_steering`,
 * `steering_flows` and the rest stay the router's. The ULA is the site's
 * private IPv6 prefix (odhcpd hands /64s of it to the LANs with `ip6assign`).
 * A controller reached over an address inside the current ULA makes the
 * section part of the management path (changing the ULA renumbers the path).
 */

export const NETWORK_GLOBALS_KEY = 'network_globals'

/** A ULA as OpenWrt takes it: inside fc00::/7, a /48 to /64. */
export function ulaProblem(value: string): string | null {
  const p = parsePrefix(value.trim())
  if (!p || p.family !== 6 || !value.includes('/'))
    return 'Expected an IPv6 prefix like fd12:3456:789a::/48.'
  if (!prefixContains({ family: 6, address: 'fc00::', prefix: 7 }, p.address)) {
    return 'A ULA prefix is inside fc00::/7 (it starts with fd).'
  }
  if (p.prefix < 48 || p.prefix > 64) return 'A ULA prefix is a /48 to a /64.'
  return null
}

export const networkGlobalsDomain: ConfigDomain<VerbatimSection> = {
  key: NETWORK_GLOBALS_KEY,
  configs: ['network'],
  types: ['globals'],

  claims(section) {
    return section.config === 'network' && section.type === 'globals'
  },

  ownership() {
    return { kind: 'options', options: ['ula_prefix'] }
  },

  identityKeys(section) {
    return section.type === 'globals' ? ['globals'] : []
  },

  touchesManagement(section, path) {
    const ula = scalarOption(section.options, 'ula_prefix')
    if (!ula || !path.controllerAddress) return false
    const p = parsePrefix(ula)
    return p !== null && p.family === 6 && prefixContains(p, path.controllerAddress)
  },

  parse(sections) {
    return parseVerbatim(sections, 'network', ['globals'])
  },

  render(obj, current) {
    return renderVerbatim(obj, current, 'network')
  },

  validate(desired) {
    const issues: Issue[] = []
    for (const s of desired) {
      if (s.config !== 'network' || s.type !== 'globals') continue
      const ula = scalarOption(s.options, 'ula_prefix')
      if (ula === null) continue
      const problem = ulaProblem(ula)
      if (problem) {
        issues.push({
          severity: 'error',
          code: 'ipv6_ula_invalid',
          message: problem,
          perchId: s.perchId,
          config: 'network',
          section: s.name,
          option: 'ula_prefix',
        })
      }
    }
    return issues
  },

  inSync(sections, observed) {
    const out: FeatureSyncIssue[] = []
    const interfaces = observed.interfaces
    if (!interfaces) return out
    for (const s of sections) {
      if (s.scope !== 'synced' || s.type !== 'globals') continue
      if (!scalarOption(s.options, 'ula_prefix')) continue
      const assigned = interfaces.flatMap((i) => i.ipv6Assigned ?? [])
      // Only checkable once the agent reports assignments (feature observe.ipv6_prefixes).
      if (assigned.length > 0 && !assigned.some((a) => /^f[cd]/i.test(a))) {
        out.push({
          feature: NETWORK_GLOBALS_KEY,
          objectId: s.perchId,
          code: 'ipv6_ula_not_live',
          message: 'A ULA is set but no LAN has an address from it: check ip6assign on the LANs.',
        })
      }
    }
    return out
  },
}
