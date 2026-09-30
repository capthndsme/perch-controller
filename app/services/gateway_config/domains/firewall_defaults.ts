import type { ConfigDomain, SyncedSection } from '#services/gateway_config/domain'
import {
  flagOf,
  flagValue,
  parseVerbatim,
  renderVerbatim,
  scalarOption,
  type VerbatimSection,
} from '#services/gateway_config/domains/verbatim'
import type { Issue } from '#services/gateway_config/types'

/**
 * The firewall's `defaults` section (docs/design/gateway-sync/domains.md 5,
 * owner decision D7): the zone-less policies, SYN flood protection, invalid
 * packet drop and flow offloading. Perch owns those options; everything else
 * on the section (`tcp_syncookies`, `custom_chains`, fw3's `syn_flood`, …)
 * stays the router's. Objects are the section verbatim, so the round trip is
 * exact.
 *
 * Always a protected job: the planner's built-in management-path rule
 * already puts firewall `defaults` there (`touchesManagementPath`), so a
 * change applies with the longer confirm window and the fresh-session
 * confirm. Two `defaults` sections share the identity key `defaults` and are
 * both ambiguous until one is removed or excluded.
 */

export const FIREWALL_DEFAULTS_KEY = 'firewall_defaults'

/** Options Perch owns on `defaults`. */
export const FIREWALL_DEFAULTS_OWNED = [
  'input',
  'output',
  'forward',
  'synflood_protect',
  'drop_invalid',
  'flow_offloading',
  'flow_offloading_hw',
] as const

export const DEFAULT_POLICIES = ['ACCEPT', 'REJECT', 'DROP'] as const
export type DefaultPolicy = (typeof DEFAULT_POLICIES)[number]

const POLICY_OPTIONS = new Set(['input', 'output', 'forward'])
const FLAG_OPTIONS = new Set([
  'synflood_protect',
  'syn_flood',
  'drop_invalid',
  'flow_offloading',
  'flow_offloading_hw',
])

/** The warning of D7: hardware offloading hides flows from the collector's capture. */
export const OFFLOADING_WARNING =
  'Hardware flow offloading is on: offloaded traffic bypasses the CPU, so Perch cannot count it.'

/** The defaults as the API shows them. */
export interface FirewallDefaults {
  input: string | null
  output: string | null
  forward: string | null
  synfloodProtect: boolean
  dropInvalid: boolean
  flowOffloading: boolean
  flowOffloadingHw: boolean
}

export function defaultsOf(options: VerbatimSection['options']): FirewallDefaults {
  const policy = (key: string) => scalarOption(options, key)?.trim().toUpperCase() ?? null
  return {
    input: policy('input'),
    output: policy('output'),
    forward: policy('forward'),
    // fw3 spelled it `syn_flood`; fw4 reads both.
    synfloodProtect: flagOf(options, 'synflood_protect', flagOf(options, 'syn_flood', false)),
    dropInvalid: flagOf(options, 'drop_invalid', false),
    flowOffloading: flagOf(options, 'flow_offloading', false),
    flowOffloadingHw: flagOf(options, 'flow_offloading_hw', false),
  }
}

export const firewallDefaultsDomain: ConfigDomain<VerbatimSection> = {
  key: FIREWALL_DEFAULTS_KEY,
  configs: ['firewall'],
  types: ['defaults'],

  claims(section) {
    return section.config === 'firewall' && section.type === 'defaults'
  },

  ownership() {
    return { kind: 'options', options: [...FIREWALL_DEFAULTS_OWNED] }
  },

  normalize(type, option, value) {
    if (type !== 'defaults' || typeof value !== 'string') return value
    if (POLICY_OPTIONS.has(option)) return value.trim().toUpperCase()
    if (FLAG_OPTIONS.has(option)) return flagValue(value)
    return value
  },

  identityKeys(section) {
    return section.type === 'defaults' ? ['defaults'] : []
  },

  parse(sections) {
    return parseVerbatim(sections, 'firewall', ['defaults'])
  },

  render(obj, current) {
    return renderVerbatim(obj, current, 'firewall')
  },

  validate(desired, _ctx) {
    return validateDefaults(desired)
  },

  inSync(sections, observed) {
    const live = observed.offloading
    if (!live) return []
    const out = []
    for (const s of sections) {
      if (s.scope !== 'synced' || s.type !== 'defaults') continue
      const want = defaultsOf(s.options)
      const differs =
        (live.flowOffloading !== null && live.flowOffloading !== want.flowOffloading) ||
        (live.flowOffloadingHw !== null && live.flowOffloadingHw !== want.flowOffloadingHw)
      if (differs) {
        out.push({
          feature: FIREWALL_DEFAULTS_KEY,
          objectId: s.perchId,
          code: 'firewall_offloading_not_live',
          message: 'The router runs another flow offloading setting than its firewall config.',
        })
      }
    }
    return out
  },
}

function validateDefaults(desired: SyncedSection[]): Issue[] {
  const issues: Issue[] = []
  for (const s of desired) {
    if (s.config !== 'firewall' || s.type !== 'defaults') continue
    const at = { perchId: s.perchId, config: 'firewall', section: s.name }
    for (const option of POLICY_OPTIONS) {
      const value = s.options[option]
      if (value === undefined) continue
      const text = typeof value === 'string' ? value.trim().toUpperCase() : null
      if (text === null || !(DEFAULT_POLICIES as readonly string[]).includes(text)) {
        issues.push({
          severity: 'error',
          code: 'firewall_policy_invalid',
          message: `The ${option} policy must be ACCEPT, REJECT or DROP.`,
          ...at,
          option,
        })
      }
    }
    if (defaultsOf(s.options).flowOffloadingHw) {
      issues.push({
        severity: 'warning',
        code: 'firewall_offloading_blinds_collector',
        message: OFFLOADING_WARNING,
        ...at,
        option: 'flow_offloading_hw',
      })
    }
  }
  return issues
}
