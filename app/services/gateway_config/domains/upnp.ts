import type { ConfigDomain, FeatureSyncIssue, SyncedSection } from '#services/gateway_config/domain'
import {
  flagOf,
  flagValue,
  isIpv4Address,
  parsePrefix,
  parseVerbatim,
  renderVerbatim,
  scalarOption,
  type VerbatimSection,
} from '#services/gateway_config/domains/verbatim'
import { configAllowed, type GatewayCapabilities, type Issue } from '#services/gateway_config/types'

/**
 * Gateway sync: miniupnpd's settings and ACL (docs/design/gateway-sync/
 * domains.md 8). The settings section (type `upnpd`, named `config` on 23.05
 * and 24.10; claimed by type, never by name) is Perch's for the switches and
 * interfaces only; the lease file, UUID, port and presentation URL stay the
 * router's (Perch never moves the lease file the observation reads). Each
 * `perm_rule` is Perch's whole and the rules are ordered: miniupnpd applies
 * the first that matches. Joined only when the router lets the agent write
 * `upnpd` (the sibling join of miniupnpd, protocol.md 5).
 */

export const UPNP_KEY = 'upnp'
export const UPNP_PACKAGES = ['miniupnpd']

/** Options Perch owns on the settings section. */
export const UPNP_OWNED = [
  'enabled',
  'enable_upnp',
  'enable_natpmp',
  'secure_mode',
  'log_output',
  'internal_iface',
  'external_iface',
  'igdv1',
] as const

const FLAG_OPTIONS = new Set([
  'enabled',
  'enable_upnp',
  'enable_natpmp',
  'secure_mode',
  'log_output',
  'igdv1',
  'use_stun',
  'ipv6_disable',
  'system_uptime',
])

export type UpnpAction = 'allow' | 'deny'

/** A port or range as miniupnpd reads it (`a-b`; `a:b` is the same). */
export function portRange(value: string | null): { from: number; to: number } | null {
  if (value === null) return null
  const m = /^\s*(\d{1,5})(?:\s*[-:]\s*(\d{1,5}))?\s*$/.exec(value)
  if (!m) return null
  const from = Number(m[1])
  const to = m[2] === undefined ? from : Number(m[2])
  if (from > 65535 || to > 65535 || from > to) return null
  return { from, to }
}

export function normalizePorts(value: string): string {
  const r = portRange(value)
  if (!r) return value.trim()
  return r.from === r.to ? String(r.from) : `${r.from}-${r.to}`
}

/** `int_addr`: an IPv4 address or CIDR (`0.0.0.0/0` = everyone). */
export function addrRange(value: string | null): { base: bigint; bits: number } | null {
  if (value === null) return null
  const text = value.trim()
  const withBits = text.includes('/') ? text : `${text}/32`
  const [ip] = withBits.split('/')
  if (!isIpv4Address(ip)) return null
  const p = parsePrefix(withBits)
  if (!p || p.family !== 4) return null
  const base = p.address.split('.').reduce((acc, part) => acc * 256n + BigInt(Number(part)), 0n)
  return { base, bits: p.prefix }
}

function covers(
  outer: { base: bigint; bits: number },
  inner: { base: bigint; bits: number }
): boolean {
  if (outer.bits > inner.bits) return false
  const shift = BigInt(32 - outer.bits)
  return outer.base >> shift === inner.base >> shift
}

/** Rule `a` matches everything rule `b` matches (the addresses and both port ranges). */
export function ruleCovers(a: UciOptionsLike, b: UciOptionsLike): boolean {
  const aa = addrRange(scalarOption(a, 'int_addr'))
  const ba = addrRange(scalarOption(b, 'int_addr'))
  const aext = portRange(scalarOption(a, 'ext_ports'))
  const bext = portRange(scalarOption(b, 'ext_ports'))
  const aint = portRange(scalarOption(a, 'int_ports'))
  const bint = portRange(scalarOption(b, 'int_ports'))
  if (!aa || !ba || !aext || !bext || !aint || !bint) return false
  return (
    covers(aa, ba) &&
    aext.from <= bext.from &&
    aext.to >= bext.to &&
    aint.from <= bint.from &&
    aint.to >= bint.to
  )
}

type UciOptionsLike = SyncedSection['options']

function actionOf(options: UciOptionsLike): string | null {
  return scalarOption(options, 'action')?.trim().toLowerCase() ?? null
}

/** For each rule, the first earlier rule with the other action that covers it. */
export function shadowedRules(rules: Array<{ id: string; options: UciOptionsLike }>) {
  const out = new Map<string, string>()
  rules.forEach((rule, i) => {
    const action = actionOf(rule.options)
    for (const earlier of rules.slice(0, i)) {
      const other = actionOf(earlier.options)
      if (other && action && other !== action && ruleCovers(earlier.options, rule.options)) {
        out.set(rule.id, earlier.id)
        break
      }
    }
  })
  return out
}

export const upnpDomain: ConfigDomain<VerbatimSection> = {
  key: UPNP_KEY,
  configs: ['upnpd'],
  types: ['upnpd', 'perm_rule'],
  orderedTypes: ['perm_rule'],
  listSemantics: { 'upnpd.internal_iface': 'set' },

  requires(caps: GatewayCapabilities): string | null {
    return configAllowed(caps, 'upnpd') ? null : 'upnpd is not writable on the router'
  },

  claims(section) {
    return section.config === 'upnpd' && (section.type === 'upnpd' || section.type === 'perm_rule')
  },

  ownership(section) {
    return section.type === 'upnpd'
      ? { kind: 'options', options: [...UPNP_OWNED] }
      : { kind: 'section' }
  },

  normalize(type, option, value) {
    if (typeof value !== 'string') return value
    if (FLAG_OPTIONS.has(option)) return flagValue(value)
    if (type === 'perm_rule') {
      if (option === 'action') return value.trim().toLowerCase()
      if (option === 'ext_ports' || option === 'int_ports') return normalizePorts(value)
      if (option === 'int_addr') return value.trim()
    }
    return value
  },

  identityKeys(section) {
    if (section.type !== 'perm_rule') return section.type === 'upnpd' ? ['upnpd'] : []
    const o = section.options
    const parts = [
      actionOf(o),
      scalarOption(o, 'int_addr')?.trim(),
      scalarOption(o, 'ext_ports') ? normalizePorts(scalarOption(o, 'ext_ports')!) : null,
      scalarOption(o, 'int_ports') ? normalizePorts(scalarOption(o, 'int_ports')!) : null,
    ]
    if (parts.some((p) => !p)) return []
    return [`perm:${parts.join(':').toLowerCase()}`]
  },

  parse(sections) {
    return parseVerbatim(sections, 'upnpd', ['upnpd', 'perm_rule'])
  },

  render(obj, current) {
    return renderVerbatim(obj, current, 'upnpd')
  },

  validate(desired, _ctx) {
    return validateUpnp(desired)
  },

  inSync(sections, observed) {
    const running = observed.upnp?.running
    if (running === null || running === undefined) return []
    const out: FeatureSyncIssue[] = []
    for (const s of sections) {
      if (s.scope !== 'synced' || s.type !== 'upnpd') continue
      const enabled = flagOf(s.options, 'enabled', false)
      if (enabled && !running) {
        out.push({
          feature: UPNP_KEY,
          objectId: s.perchId,
          code: 'upnp_not_running',
          message: 'UPnP is enabled but miniupnpd is not running.',
        })
      } else if (!enabled && running) {
        out.push({
          feature: UPNP_KEY,
          objectId: s.perchId,
          code: 'upnp_running_while_disabled',
          message: 'UPnP is off in the config but miniupnpd is running.',
        })
      }
    }
    return out
  },
}

function validateUpnp(desired: SyncedSection[]): Issue[] {
  const issues: Issue[] = []
  const rules = desired
    .filter((s) => s.config === 'upnpd' && s.type === 'perm_rule')
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  for (const s of desired) {
    if (s.config !== 'upnpd') continue
    const at = { perchId: s.perchId, config: 'upnpd', section: s.name }
    if (s.type === 'upnpd') {
      if (flagOf(s.options, 'enabled', false) && !flagOf(s.options, 'secure_mode', false)) {
        issues.push({
          severity: 'warning',
          code: 'upnp_secure_mode_off',
          message:
            'Secure mode is off: any device may open ports toward another device, not only toward itself.',
          ...at,
          option: 'secure_mode',
        })
      }
      continue
    }
    if (s.type !== 'perm_rule') continue
    const action = actionOf(s.options)
    if (action !== 'allow' && action !== 'deny') {
      issues.push({
        severity: 'error',
        code: 'upnp_action_invalid',
        message: 'A UPnP rule allows or denies.',
        ...at,
        option: 'action',
      })
    }
    for (const option of ['ext_ports', 'int_ports']) {
      if (!portRange(scalarOption(s.options, option))) {
        issues.push({
          severity: 'error',
          code: 'upnp_ports_invalid',
          message: 'Ports are a number or a range like 1024-65535.',
          ...at,
          option,
        })
      }
    }
    if (!addrRange(scalarOption(s.options, 'int_addr'))) {
      issues.push({
        severity: 'error',
        code: 'upnp_addr_invalid',
        message: 'The internal address is an IPv4 address or range like 192.168.1.0/24.',
        ...at,
        option: 'int_addr',
      })
    }
  }
  const shadows = shadowedRules(rules.map((r) => ({ id: r.perchId ?? r.name, options: r.options })))
  for (const r of rules) {
    const by = shadows.get(r.perchId ?? r.name)
    if (!by) continue
    issues.push({
      severity: 'warning',
      code: 'upnp_acl_shadowed',
      message: 'An earlier rule with the opposite action already matches everything this one does.',
      perchId: r.perchId,
      config: 'upnpd',
      section: r.name,
    })
  }
  return issues
}
