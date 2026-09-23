import type {
  ConfigDomain,
  FeatureSyncIssue,
  SyncedSection,
  ValidationCtx,
} from '#services/gateway_config/domain'
import {
  flagOf,
  flagValue,
  isDnsName,
  isIpAddress,
  parseVerbatim,
  renderVerbatim,
  scalarOption,
  scalarsOnly,
  type VerbatimSection,
} from '#services/gateway_config/domains/verbatim'
import { ZONEINFO } from '#services/gateway_config/domains/zoneinfo'
import type { Issue, UciOptions } from '#services/gateway_config/types'

/**
 * The router's `system` config (plan 2 section 4.5: "manage, two-way"):
 *
 * | UCI | Perch owns | Router-owned (carried verbatim) |
 * |---|---|---|
 * | `config system` (LuCI: `@system[0]`) | `hostname`, `timezone`, `zonename` | `log_size`, `ttylogin`, `urandom_seed`, `cronloglevel`, `compat_version`, anything newer |
 * | `config timeserver 'ntp'` | `enabled`, `enable_server`, `server` (list) | `interface`, `use_dhcp`, anything newer |
 *
 * Other `system` sections (`led`, `button`, `rngd`, …) are not claimed:
 * LEDs and locate are "later" in the inventory (and container gateways
 * have none), so they stay unmodeled, mirrored and never written.
 *
 * The time zone pair follows LuCI: `zonename` is the IANA name
 * (`Asia/Manila`), `timezone` the POSIX TZ string procd applies (`PST-8`).
 * The REST layer writes both from a zone name (`ZONEINFO`); validation warns
 * when an imported pair disagrees. A host name change also renames the
 * agent's hello on its next connect (nothing to do here).
 */

export const SYSTEM_DOMAIN_KEY = 'system'

export const SYSTEM_OWNED = ['hostname', 'timezone', 'zonename'] as const
export const NTP_OWNED = ['enabled', 'enable_server', 'server'] as const

/** The NTP client/server section LuCI and sysntpd use. */
export const NTP_SECTION = 'ntp'

/** One host label, like LuCI's `hostname` datatype without dots: letters, digits, dashes. */
export const SYSTEM_HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i

/** A POSIX TZ string (`UTC0`, `PST-8`, `EST5EDT,M3.2.0,M11.1.0`, `<+08>-8`), loosely. */
const POSIX_TZ = /^(?:[A-Za-z]{3,}|<[A-Za-z0-9+-]{1,10}>)[-+0-9:.,A-Za-z<>/]{0,60}$/

export function isValidTimezone(value: string): boolean {
  return POSIX_TZ.test(value)
}

/** The POSIX TZ string of a zone name, or null for an unknown zone. */
export function tzForZone(zonename: string): string | null {
  return ZONEINFO[zonename] ?? null
}

/** Zone names the controller knows (the REST picker). */
export function zoneNames(): string[] {
  return Object.keys(ZONEINFO)
}

export const systemDomain: ConfigDomain<VerbatimSection> = {
  key: SYSTEM_DOMAIN_KEY,
  configs: ['system'],
  types: ['system', 'timeserver'],

  claims(section) {
    if (section.config !== 'system') return false
    if (section.type === 'system') return scalarsOnly(section.options, SYSTEM_OWNED)
    if (section.type === 'timeserver') {
      return (
        section.name === NTP_SECTION && scalarsOnly(section.options, ['enabled', 'enable_server'])
      )
    }
    return false
  },

  ownership(section) {
    return {
      kind: 'options',
      options: section.type === 'system' ? [...SYSTEM_OWNED] : [...NTP_OWNED],
    }
  },

  listSemantics: { 'timeserver.server': 'set' },

  normalize(type, option, value) {
    if (typeof value !== 'string') return value
    if (type === 'timeserver' && (option === 'enabled' || option === 'enable_server')) {
      return flagValue(value)
    }
    return value
  },

  identityKeys(section) {
    // One `system` section per router: a second one makes both ambiguous.
    return section.type === 'system' ? ['system:main'] : []
  },

  parse(sections) {
    return parseVerbatim(sections, 'system', ['system', 'timeserver'])
  },

  render(obj, current) {
    return renderVerbatim(obj, current, 'system')
  },

  validate(desired, ctx) {
    return validateSystem(desired, ctx)
  },

  inSync(sections, observed) {
    const issues: FeatureSyncIssue[] = []
    const main = sections.find((s) => s.type === 'system' && s.scope === 'synced')
    const wanted = main ? scalarOption(main.options, 'hostname') : null
    if (main && wanted && observed.hostname && observed.hostname !== wanted) {
      issues.push({
        feature: SYSTEM_DOMAIN_KEY,
        objectId: main.perchId,
        code: 'system_hostname_not_live',
        message: `The router runs as "${observed.hostname}", the configuration says "${wanted}".`,
      })
    }
    return issues
  },
}

/** A time server entry: a host name or an address. */
export function isValidNtpServer(value: string): boolean {
  return isIpAddress(value) || (isDnsName(value) && !value.endsWith('.'))
}

function validateSystem(desired: SyncedSection[], _ctx: ValidationCtx): Issue[] {
  const issues: Issue[] = []
  const issue = (
    s: SyncedSection,
    severity: Issue['severity'],
    code: string,
    message: string,
    option?: string
  ) =>
    issues.push({
      severity,
      code,
      message,
      perchId: s.perchId,
      config: 'system',
      section: s.name,
      ...(option ? { option } : {}),
    })
  for (const s of desired) {
    if (s.config !== 'system') continue
    if (s.type === 'system') validateMain(s, issue)
    if (s.type === 'timeserver') validateNtp(s, issue)
  }
  return issues
}

type IssueFn = (
  s: SyncedSection,
  severity: Issue['severity'],
  code: string,
  message: string,
  option?: string
) => void

function validateMain(s: SyncedSection, issue: IssueFn) {
  const hostname = scalarOption(s.options, 'hostname')
  if (hostname !== null && !SYSTEM_HOSTNAME.test(hostname)) {
    issue(s, 'error', 'system_hostname_invalid', `"${hostname}" is not a host name`, 'hostname')
  }
  const timezone = scalarOption(s.options, 'timezone')
  if (timezone !== null && !isValidTimezone(timezone)) {
    issue(s, 'error', 'system_timezone_invalid', `"${timezone}" is not a POSIX TZ`, 'timezone')
  }
  const zonename = scalarOption(s.options, 'zonename')
  if (zonename !== null) {
    const tz = tzForZone(zonename)
    if (tz === null) {
      issue(s, 'warning', 'system_zone_unknown', `Zone "${zonename}" is not known`, 'zonename')
    } else if (timezone !== null && timezone !== tz) {
      issue(
        s,
        'warning',
        'system_timezone_mismatch',
        `${zonename} is "${tz}", the router has "${timezone}"`,
        'timezone'
      )
    }
  }
}

function validateNtp(s: SyncedSection, issue: IssueFn) {
  const servers = listOf(s.options, 'server')
  for (const server of servers) {
    if (!isValidNtpServer(server)) {
      issue(s, 'error', 'system_ntp_server_invalid', `"${server}" is not a time server`, 'server')
    }
  }
  const enabled = flagOf(s.options, 'enabled', true)
  if (enabled && servers.length === 0 && flagOf(s.options, 'use_dhcp', true) === false) {
    issue(s, 'warning', 'system_ntp_no_server', 'The NTP client has no server', 'server')
  }
  if (!enabled && flagOf(s.options, 'enable_server', false)) {
    issue(
      s,
      'warning',
      'system_ntp_server_unsynced',
      'The NTP server is on while the client is off: it serves an unsynchronised clock',
      'enable_server'
    )
  }
}

function listOf(options: UciOptions, key: string): string[] {
  const value = options[key]
  if (value === undefined) return []
  return (Array.isArray(value) ? value : [value]).flatMap((v) =>
    v.split(/\s+/).filter((x) => x.length > 0)
  )
}
