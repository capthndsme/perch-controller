import type { ConfigDomain, FeatureSyncIssue, SyncedSection } from '#services/gateway_config/domain'
import {
  flagOf,
  flagValue,
  isDnsName,
  parseVerbatim,
  renderVerbatim,
  scalarOption,
  type VerbatimSection,
} from '#services/gateway_config/domains/verbatim'
import { configAllowed, type GatewayCapabilities, type Issue } from '#services/gateway_config/types'

/**
 * Gateway sync: ddns-scripts services (docs/design/gateway-sync/domains.md 9).
 *
 * The `ddns 'global'` section is claimed with `upd_privateip` alone (the run
 * and log directories, date format and log lines stay the router's); each
 * `service` section is Perch's whole, its `password` a secret (the router's,
 * or one the controller set over TLS). Objects are the sections verbatim, so
 * the round trip is exact; the REST layer (`ddns_service.ts`) edits the
 * options it models. Joined only when the router lets the agent write `ddns`
 * (the sibling join of ddns-scripts, protocol.md 5).
 */

export const DDNS_KEY = 'ddns'
export const DDNS_PACKAGES = ['ddns-scripts']

export const IP_SOURCES = ['network', 'interface', 'web', 'script'] as const
export type IpSource = (typeof IP_SOURCES)[number]

export const INTERVAL_UNITS = ['seconds', 'minutes', 'hours', 'days'] as const

const FLAG_OPTIONS = new Set([
  'enabled',
  'use_ipv6',
  'use_https',
  'force_ipversion',
  'force_dnstcp',
  'is_glue',
  'use_syslog',
  'upd_privateip',
])

/** A service as the API reads it (the secret is never here). */
export interface DdnsService {
  name: string
  enabled: boolean
  provider: string | null
  updateUrl: string | null
  domain: string | null
  lookupHost: string | null
  username: string | null
  ipSource: IpSource
  ipNetwork: string | null
  ipInterface: string | null
  /** The network whose ifup event triggers an update (`interface`). */
  interface: string | null
  useIpv6: boolean
  useHttps: boolean
  checkIntervalMinutes: number | null
  forceIntervalHours: number | null
}

const UNIT_SECONDS: Record<string, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86_400 }

/** `<interval> <unit>` in `unitSeconds`, rounded; null when absent or invalid. */
function intervalIn(
  options: SyncedSection['options'],
  key: string,
  unitKey: string,
  defaultUnit: string,
  unitSeconds: number
): number | null {
  const raw = scalarOption(options, key)
  if (raw === null || !/^\d+$/.test(raw.trim())) return null
  const unit = scalarOption(options, unitKey)?.trim().toLowerCase() || defaultUnit
  const per = UNIT_SECONDS[unit]
  if (!per) return null
  return Math.round((Number(raw) * per) / unitSeconds)
}

export function serviceOf(name: string, options: SyncedSection['options']): DdnsService {
  const source = scalarOption(options, 'ip_source')?.trim().toLowerCase() ?? 'network'
  return {
    name,
    enabled: flagOf(options, 'enabled', false),
    provider: scalarOption(options, 'service_name'),
    updateUrl: scalarOption(options, 'update_url'),
    domain: scalarOption(options, 'domain'),
    lookupHost: scalarOption(options, 'lookup_host'),
    username: scalarOption(options, 'username'),
    ipSource: (IP_SOURCES as readonly string[]).includes(source) ? (source as IpSource) : 'network',
    ipNetwork: scalarOption(options, 'ip_network'),
    ipInterface: scalarOption(options, 'ip_interface'),
    interface: scalarOption(options, 'interface'),
    useIpv6: flagOf(options, 'use_ipv6', false),
    useHttps: flagOf(options, 'use_https', false),
    // ddns-scripts' defaults: check every 10 minutes, force every 72 hours.
    checkIntervalMinutes: intervalIn(options, 'check_interval', 'check_unit', 'minutes', 60),
    forceIntervalHours: intervalIn(options, 'force_interval', 'force_unit', 'hours', 3600),
  }
}

/** What a DDNS domain name may be: a host name, or ddns-scripts' `host@zone` form (Cloudflare). */
export function isDdnsDomain(value: string): boolean {
  const text = value.trim()
  if (!text || text.length > 253 || /\s/.test(text)) return false
  const parts = text.split('@')
  if (parts.length > 2) return false
  return parts.every((p) => p === '' || p === '*' || isDnsName(p.replace(/^\*\./, '')))
}

export const ddnsDomain: ConfigDomain<VerbatimSection> = {
  key: DDNS_KEY,
  configs: ['ddns'],
  types: ['ddns', 'service'],

  requires(caps: GatewayCapabilities): string | null {
    return configAllowed(caps, 'ddns') ? null : 'ddns is not writable on the router'
  },

  claims(section) {
    return section.config === 'ddns' && (section.type === 'service' || section.type === 'ddns')
  },

  ownership(section) {
    return section.type === 'ddns'
      ? { kind: 'options', options: ['upd_privateip'] }
      : { kind: 'section' }
  },

  secretOptions: ['service.password'],

  normalize(_type, option, value) {
    if (typeof value !== 'string') return value
    if (FLAG_OPTIONS.has(option)) return flagValue(value)
    if (option === 'ip_source' || option === 'check_unit' || option === 'force_unit') {
      return value.trim().toLowerCase()
    }
    return value
  },

  parse(sections) {
    return parseVerbatim(sections, 'ddns', ['ddns', 'service'])
  },

  render(obj, current) {
    return renderVerbatim(obj, current, 'ddns')
  },

  validate(desired, ctx) {
    // Every network the router has, Perch's or not (a WAN is often the router's alone).
    const networks = new Set(
      [...ctx.all, ...(ctx.unmanaged ?? [])]
        .filter((s) => s.config === 'network' && s.type === 'interface')
        .map((s) => s.name)
    )
    return validateServices(desired, networks)
  },

  inSync(sections, observed) {
    const live = observed.ddns
    if (!live) return []
    const out: FeatureSyncIssue[] = []
    for (const s of sections) {
      if (s.scope !== 'synced' || s.type !== 'service') continue
      if (!flagOf(s.options, 'enabled', false)) continue
      const svc = live.services.find((x) => x.name === s.name)
      if (svc && !svc.running) {
        out.push({
          feature: DDNS_KEY,
          objectId: s.perchId,
          code: 'ddns_not_running',
          message: `The DDNS service ${s.name} is enabled but its updater is not running.`,
        })
      }
    }
    return out
  },
}

function validateServices(desired: SyncedSection[], networks: Set<string>): Issue[] {
  const issues: Issue[] = []
  for (const s of desired) {
    if (s.config !== 'ddns' || s.type !== 'service') continue
    const at = { perchId: s.perchId, config: 'ddns', section: s.name }
    const o = s.options
    const domain = scalarOption(o, 'domain') ?? scalarOption(o, 'lookup_host')
    if (domain === null || !isDdnsDomain(domain)) {
      issues.push({
        severity: 'error',
        code: 'ddns_domain_invalid',
        message: 'Enter the host name the provider updates, like home.example.com.',
        ...at,
        option: 'domain',
      })
    }
    const lookup = scalarOption(o, 'lookup_host')
    if (lookup !== null && !isDnsName(lookup.trim())) {
      issues.push({
        severity: 'error',
        code: 'ddns_domain_invalid',
        message: 'The lookup host must be a host name.',
        ...at,
        option: 'lookup_host',
      })
    }
    const url = scalarOption(o, 'update_url')
    if (url !== null) {
      if (!/^https?:\/\/\S+$/i.test(url.trim())) {
        issues.push({
          severity: 'error',
          code: 'ddns_update_url_invalid',
          message: 'The update URL must start with http:// or https://.',
          ...at,
          option: 'update_url',
        })
      } else if (/^http:\/\//i.test(url.trim()) && !flagOf(o, 'use_https', false)) {
        issues.push({
          severity: 'warning',
          code: 'ddns_update_url_plain',
          message: 'The update URL uses http://: the provider credentials travel in clear.',
          ...at,
          option: 'update_url',
        })
      }
    }
    const source = scalarOption(o, 'ip_source')?.trim().toLowerCase() ?? 'network'
    if (!(IP_SOURCES as readonly string[]).includes(source)) {
      issues.push({
        severity: 'error',
        code: 'ddns_ip_source_invalid',
        message: 'The address source must be network, interface, web or script.',
        ...at,
        option: 'ip_source',
      })
    }
    for (const key of ['interface', ...(source === 'network' ? ['ip_network'] : [])]) {
      const net = scalarOption(o, key)
      if (net !== null && networks.size > 0 && !networks.has(net)) {
        issues.push({
          severity: 'error',
          code: 'ddns_interface_unknown',
          message: `The router has no network "${net}".`,
          ...at,
          option: key,
        })
      }
    }
    for (const [key, unitKey] of [
      ['check_interval', 'check_unit'],
      ['force_interval', 'force_unit'],
    ] as const) {
      const raw = scalarOption(o, key)
      const unit = scalarOption(o, unitKey)
      const badNumber = raw !== null && !/^\d{1,6}$/.test(raw.trim())
      const badUnit = unit !== null && !(INTERVAL_UNITS as readonly string[]).includes(unit.trim())
      const zeroCheck = key === 'check_interval' && raw !== null && Number(raw) === 0
      if (badNumber || badUnit || zeroCheck) {
        issues.push({
          severity: 'error',
          code: 'ddns_interval_invalid',
          message:
            'Intervals are whole numbers of seconds, minutes, hours or days (the check above 0).',
          ...at,
          option: badUnit ? unitKey : key,
        })
      }
    }
  }
  return issues
}
