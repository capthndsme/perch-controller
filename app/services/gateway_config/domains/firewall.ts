import { canonicalText, itemsOf } from '#services/gateway_config/canonical'
import type {
  ConfigDomain,
  SectionEdit,
  SecretEdit,
  SyncedSection,
  ValidationCtx,
} from '#services/gateway_config/domain'
import type { Issue, ManagementPath, UciOptions, UciValue } from '#services/gateway_config/types'
import { createHash } from 'node:crypto'

/**
 * The firewall (fw4 / nftables, package `firewall`; plan 2 section 4.3,
 * docs/gateway/firewall.md). One domain over `/etc/config/firewall`:
 *
 * | UCI | Claimed | Notes |
 * |---|---|---|
 * | `zone` | yes, with a `name` | created and renamed by the network plan only; synced two-way |
 * | `forwarding` | yes, with `src` and `dest` | synced two-way |
 * | `rule` | yes | ordered; Perch rules via REST, operator rules imported |
 * | `redirect` (DNAT) | yes, `target` absent or `DNAT` | ordered; port forwards |
 * | `ipset` `perch_block_wan` | yes | the per-device WAN block set |
 * | `defaults`, `include`, `nat`, SNAT redirects, other `ipset`s | **never** | observed only: unmodeled, never written, never drift |
 *
 * Includes are never claimed, so a package's include (miniupnpd) is never
 * deleted or reverted, and Perch's own nftables (the portal's `inet
 * perch_portal` table and its fw4 drop-in, decision 27) live outside UCI:
 * the config plane never sees them, so they can never be drift.
 *
 * Objects are the sections themselves: `render(parse(x))` writes every
 * option back verbatim, so the round trip is exact whatever spelling LuCI
 * or `uci` used. Equality is normalised (fw4's aliases: `proto 'tcpudp'` =
 * `list proto 'tcp' 'udp'`, `enabled 'yes'` = `'1'`, port ranges `a:b` =
 * `a-b`, MACs in any case, `family '4'` = `ipv4`). Validation is the
 * pre-flight of plan 2 section 4.3: zones exist, ports and addresses parse,
 * DNAT redirects that overlap (the later one never matches) and rules an
 * earlier rule shadows are reported, and a rule that would cut the path the
 * agent reaches the controller through (README 3.8) is an error.
 */

export const FIREWALL_DOMAIN_KEY = 'firewall'

/** The per-device WAN block set (plan 2 section 4.3): section and nft set name. */
export const BLOCK_SET_NAME = 'perch_block_wan'
/** Section name prefix of the block rules, one per WAN zone: `perch_block_wan_<zone>`. */
export const BLOCK_RULE_PREFIX = 'perch_block_wan_'

export const FIREWALL_TYPES = ['zone', 'forwarding', 'rule', 'redirect', 'ipset'] as const
export const ORDERED_FIREWALL_TYPES = ['rule', 'redirect'] as const

/** Rule targets fw4 knows. */
const RULE_TARGETS = ['ACCEPT', 'REJECT', 'DROP', 'MARK', 'NOTRACK', 'HELPER', 'DSCP']
const ZONE_POLICIES = ['ACCEPT', 'REJECT', 'DROP']
const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const PORT_TOKEN = /^(\d{1,5})(?:[-:](\d{1,5}))?$/
/** The router's own management services (plan 2 section 4.3: never cut on input). */
export const ADMIN_PORTS = [22, 80, 443]

const BOOLEAN_OPTIONS = new Set([
  'enabled',
  'masq',
  'masq6',
  'mtu_fix',
  'reflection',
  'log',
  'conntrack',
  'masq_allow_invalid',
  'auto_helper',
  'syn_flood',
  'synflood_protect',
  'drop_invalid',
  'flow_offloading',
  'flow_offloading_hw',
  'reload',
])
const UPPERCASE_OPTIONS = new Set(['target', 'input', 'output', 'forward'])
const PORT_OPTIONS = new Set(['src_port', 'dest_port', 'src_dport'])
const WORD_LIST_OPTIONS = new Set([
  'network',
  'device',
  'src_ip',
  'dest_ip',
  'src_dip',
  'subnet',
  'icmp_type',
  'match',
  'helper',
])
const MAC_LIST_OPTIONS = new Set(['src_mac', 'entry'])

// ── value helpers (pure, exported for the REST layer and tests) ──────────

function scalar(options: UciOptions, key: string): string | null {
  const v = options[key]
  if (v === undefined) return null
  return Array.isArray(v) ? v.join(' ') : v
}

/** Items of an option: a list, or whitespace-separated words in one string. */
export function wordsOf(value: UciValue | undefined): string[] {
  return itemsOf(value)
    .flatMap((item) => item.split(/\s+/))
    .filter((item) => item.length > 0)
}

export function truthy(value: string | null | undefined, fallback = false): boolean {
  if (value === null || value === undefined) return fallback
  const text = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(text)) return true
  if (['0', 'false', 'no', 'off', 'disabled'].includes(text)) return false
  return fallback
}

function normalBool(value: string): string {
  const text = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(text)) return '1'
  if (['0', 'false', 'no', 'off', 'disabled'].includes(text)) return '0'
  return text
}

/** fw4 protocol names: `tcpudp` is `tcp udp`, `any` is `all`, case-insensitive. */
export function protocolsOf(value: UciValue | undefined): string[] {
  const out = new Set<string>()
  for (const word of wordsOf(value)) {
    const w = word.toLowerCase()
    if (w === 'tcpudp') {
      out.add('tcp')
      out.add('udp')
    } else if (w === 'any' || w === '*') {
      out.add('all')
    } else {
      out.add(w)
    }
  }
  return [...out].sort()
}

export function familyOf(value: string | null): 'ipv4' | 'ipv6' | 'any' {
  const text = (value ?? '').trim().toLowerCase()
  if (text === 'ipv4' || text === '4' || text === 'inet4') return 'ipv4'
  if (text === 'ipv6' || text === '6' || text === 'inet6') return 'ipv6'
  return 'any'
}

export type PortRange = { from: number; to: number }

/**
 * A port option (`22`, `8000-8100`, `8000:8100`, `22 80 443` or a list) as
 * ranges; null when a token does not parse or is outside 1–65535, or a
 * range runs backwards. An absent option is `[]` (every port).
 */
export function parsePorts(value: UciValue | undefined): PortRange[] | null {
  const out: PortRange[] = []
  for (const word of wordsOf(value)) {
    const m = PORT_TOKEN.exec(word)
    if (!m) return null
    const from = Number(m[1])
    const to = m[2] === undefined ? from : Number(m[2])
    if (from < 1 || to > 65535 || to < from) return null
    out.push({ from, to })
  }
  return out
}

/** Whether two port sets share a port ([] = every port). */
export function portsIntersect(a: PortRange[], b: PortRange[]): boolean {
  if (a.length === 0 || b.length === 0) return true
  return a.some((x) => b.some((y) => x.from <= y.to && y.from <= x.to))
}

function portsCover(ports: PortRange[], port: number): boolean {
  return ports.length === 0 || ports.some((r) => r.from <= port && port <= r.to)
}

/** Text form of a port option for the API (`8000-8100`, `22 80`). */
export function portText(value: UciValue | undefined): string | null {
  const words = wordsOf(value).map((w) => w.replace(':', '-'))
  return words.length > 0 ? words.join(' ') : null
}

function macsOf(value: UciValue | undefined): string[] {
  return wordsOf(value).map((w) => w.toLowerCase())
}

function lowerWords(value: UciValue | undefined): string[] {
  return wordsOf(value).map((w) => w.toLowerCase())
}

function isIpOrCidr(value: string): boolean {
  const bare = value.startsWith('!') ? value.slice(1) : value
  const [ip, prefix] = bare.split('/')
  if (IPV4.test(ip)) {
    if (prefix === undefined) return true
    if (/^\d{1,2}$/.test(prefix)) return Number(prefix) <= 32
    return IPV4.test(prefix)
  }
  if (ip.includes(':') && /^[0-9a-f:.]+$/i.test(ip) && ip.length <= 45) {
    return prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= 128)
  }
  return false
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0)
}

/** Whether an IPv4 address falls inside `a.b.c.d[/n]` (a bare address is a /32). */
export function ipInCidr(ip: string, cidr: string): boolean {
  if (!IPV4.test(ip)) return false
  const [address, prefixText] = cidr.split('/')
  if (!IPV4.test(address)) return false
  let prefix = 32
  if (prefixText !== undefined) {
    if (IPV4.test(prefixText)) {
      prefix = prefixText
        .split('.')
        .map((p) => Number(p).toString(2).replaceAll('0', '').length)
        .reduce((a, b) => a + b, 0)
    } else prefix = Number(prefixText)
  }
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (ipv4ToInt(ip) & mask) >>> 0 === (ipv4ToInt(address) & mask) >>> 0
}

// ── claims and identity ──────────────────────────────────────────────────

function isDnat(options: UciOptions): boolean {
  const target = scalar(options, 'target')
  return target === null || target.trim().toUpperCase() === 'DNAT'
}

function claimsSection(type: string, options: UciOptions): boolean {
  switch (type) {
    case 'zone':
      return typeof options.name === 'string' && options.name.trim().length > 0
    case 'forwarding':
      return typeof options.src === 'string' && typeof options.dest === 'string'
    case 'rule':
      return true
    case 'redirect':
      return isDnat(options)
    case 'ipset':
      return scalar(options, 'name') === BLOCK_SET_NAME
    default:
      return false
  }
}

function fingerprint(type: string, options: UciOptions): string {
  return createHash('sha256').update(canonicalText({ type, options })).digest('hex').slice(0, 16)
}

// ── the domain ───────────────────────────────────────────────────────────

/** A firewall section as a domain object: the section, verbatim. */
export interface FirewallObject {
  perchId: string | null
  /** UCI section name (a new section: the name to create it under, or '' for `perch_<id>`). */
  section: string
  type: string
  options: UciOptions
  secretNames: string[]
}

export const firewallDomain: ConfigDomain<FirewallObject> = {
  key: FIREWALL_DOMAIN_KEY,
  configs: ['firewall'],
  types: [...FIREWALL_TYPES],
  orderedTypes: [...ORDERED_FIREWALL_TYPES],
  listSemantics: {
    'zone.network': 'set',
    'zone.device': 'set',
    'zone.subnet': 'set',
    'ipset.entry': 'set',
    'rule.src_mac': 'set',
    'rule.icmp_type': 'set',
  },

  claims(section) {
    return section.config === 'firewall' && claimsSection(section.type, section.options)
  },

  normalize(_type, option, value) {
    if (BOOLEAN_OPTIONS.has(option) && typeof value === 'string') return normalBool(value)
    if (UPPERCASE_OPTIONS.has(option) && typeof value === 'string') {
      return value.trim().toUpperCase()
    }
    if (option === 'proto') return protocolsOf(value)
    if (option === 'family' && typeof value === 'string') return familyOf(value)
    if (PORT_OPTIONS.has(option)) {
      return wordsOf(value)
        .map((w) => w.replace(':', '-'))
        .sort()
    }
    if (MAC_LIST_OPTIONS.has(option)) return [...new Set(macsOf(value))].sort()
    if (WORD_LIST_OPTIONS.has(option)) return [...new Set(lowerWords(value))].sort()
    if (option === 'name' && typeof value === 'string') return value.trim()
    return value
  },

  identityKeys(section) {
    const o = section.options
    switch (section.type) {
      case 'zone': {
        const name = scalar(o, 'name')
        return name ? [`zone:${name.trim()}`] : []
      }
      case 'forwarding':
        return [
          `fwd:${scalar(o, 'src') ?? ''}>${scalar(o, 'dest') ?? ''}:${familyOf(scalar(o, 'family'))}`,
        ]
      case 'ipset': {
        const name = scalar(o, 'name')
        return name ? [`ipset:${name}`] : []
      }
      case 'rule':
      case 'redirect': {
        // Plan 2 section 4.3 (a): the name, else a content fingerprint. Two
        // sections sharing a name are ambiguous until the operator renames one.
        const name = scalar(o, 'name')?.trim()
        return name
          ? [`${section.type}:${name.toLowerCase()}`]
          : [`${section.type}#${fingerprint(section.type, o)}`]
      }
      default:
        return []
    }
  },

  touchesManagement(section, path) {
    if (section.type !== 'rule' || !path.network) return false
    const src = scalar(section.options, 'src')
    const dest = scalar(section.options, 'dest')
    // Output rules (no src) and input rules from the zone named after the
    // management network are on the path; forward rules never are (the agent
    // dials out from the router itself).
    if (src === null) return true
    return dest === null && (src === path.network || src === '*')
  },

  parse(sections) {
    return sections
      .filter(
        (s) => s.config === 'firewall' && (FIREWALL_TYPES as readonly string[]).includes(s.type)
      )
      .map((s) => ({
        perchId: s.perchId,
        section: s.name,
        type: s.type,
        options: cloneOptions(s.options),
        secretNames: Object.keys(s.secrets ?? {}),
      }))
  },

  render(obj, current) {
    const existing = obj.perchId ? current.find((s) => s.perchId === obj.perchId) : undefined
    const secrets: Record<string, SecretEdit> = {}
    for (const name of obj.secretNames) {
      if (existing?.secrets?.[name]) secrets[name] = { keep: true }
    }
    const edit: SectionEdit = {
      op: 'put',
      perchId: obj.perchId,
      config: 'firewall',
      type: obj.type,
      options: cloneOptions(obj.options),
      ...(obj.perchId === null && obj.section ? { name: obj.section } : {}),
      ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
    }
    return [edit]
  },

  validate(desired, ctx) {
    return validateFirewall(desired, ctx)
  },
}

export function cloneOptions(options: UciOptions): UciOptions {
  const out: UciOptions = {}
  for (const [k, v] of Object.entries(options)) out[k] = Array.isArray(v) ? [...v] : v
  return out
}

// ── read models (the REST layer's views, pure) ───────────────────────────

export interface ZoneInfo {
  name: string
  networks: string[]
  input: string | null
  output: string | null
  forward: string | null
  masq: boolean
  mtuFix: boolean
}

export function zoneInfo(options: UciOptions): ZoneInfo {
  return {
    name: scalar(options, 'name')?.trim() ?? '',
    networks: wordsOf(options.network),
    input: scalar(options, 'input')?.toUpperCase() ?? null,
    output: scalar(options, 'output')?.toUpperCase() ?? null,
    forward: scalar(options, 'forward')?.toUpperCase() ?? null,
    masq: truthy(scalar(options, 'masq')),
    mtuFix: truthy(scalar(options, 'mtu_fix')),
  }
}

/** The zones of a set of firewall sections (any scope). */
export function zonesOf(sections: Array<{ type: string; options: UciOptions }>): ZoneInfo[] {
  return sections.filter((s) => s.type === 'zone').map((s) => zoneInfo(s.options))
}

/**
 * WAN zones: the masquerading ones (fw4's default `wan` has `masq '1'`),
 * else a zone called `wan`.
 */
export function wanZones(zones: ZoneInfo[]): string[] {
  const masq = zones.filter((z) => z.masq).map((z) => z.name)
  if (masq.length > 0) return masq
  return zones.some((z) => z.name === 'wan') ? ['wan'] : []
}

/** The zone listing a network (`lan` → the zone whose `network` has `lan`). */
export function zoneOfNetwork(zones: ZoneInfo[], network: string | null): string | null {
  if (!network) return null
  return zones.find((z) => z.networks.includes(network))?.name ?? null
}

/** The fields of a rule that decide what it matches. */
export interface RuleMatch {
  src: string | null
  dest: string | null
  proto: string[]
  srcIp: string[]
  srcMac: string[]
  destIp: string[]
  srcPort: PortRange[]
  destPort: PortRange[]
  family: 'ipv4' | 'ipv6' | 'any'
  ipset: string | null
  target: string
  enabled: boolean
}

export function ruleMatch(options: UciOptions): RuleMatch {
  return {
    src: scalar(options, 'src'),
    dest: scalar(options, 'dest'),
    proto: protocolsOf(options.proto),
    srcIp: lowerWords(options.src_ip),
    srcMac: macsOf(options.src_mac),
    destIp: lowerWords(options.dest_ip),
    srcPort: parsePorts(options.src_port) ?? [],
    destPort: parsePorts(options.dest_port) ?? [],
    family: familyOf(scalar(options, 'family')),
    ipset: scalar(options, 'ipset'),
    target: (scalar(options, 'target') ?? 'DROP').toUpperCase(),
    enabled: truthy(scalar(options, 'enabled'), true),
  }
}

function zonesMeet(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b
  return a === '*' || b === '*' || a === b
}

function listsMeet(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true
  return a.some((x) => b.includes(x))
}

function protosMeet(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0 || a.includes('all') || b.includes('all')) return true
  return a.some((x) => b.includes(x))
}

function familiesMeet(a: RuleMatch['family'], b: RuleMatch['family']): boolean {
  return a === 'any' || b === 'any' || a === b
}

/**
 * Whether two rules can match the same packet (so the earlier one decides
 * for those packets). Conservative towards "yes" where a dimension is
 * unknown (an ipset's members, a negated address).
 */
export function rulesIntersect(a: RuleMatch, b: RuleMatch): boolean {
  return (
    zonesMeet(a.src, b.src) &&
    zonesMeet(a.dest, b.dest) &&
    protosMeet(a.proto, b.proto) &&
    familiesMeet(a.family, b.family) &&
    listsMeet(a.srcIp, b.srcIp) &&
    listsMeet(a.srcMac, b.srcMac) &&
    listsMeet(a.destIp, b.destIp) &&
    portsIntersect(a.srcPort, b.srcPort) &&
    portsIntersect(a.destPort, b.destPort)
  )
}

const VERDICTS = new Set(['ACCEPT', 'REJECT', 'DROP'])

function listCovers(a: string[], b: string[]): boolean {
  if (a.length === 0) return true
  return b.length > 0 && b.every((x) => a.includes(x))
}

function portsCoverAll(a: PortRange[], b: PortRange[]): boolean {
  if (a.length === 0) return true
  return b.length > 0 && b.every((r) => a.some((x) => x.from <= r.from && r.to <= x.to))
}

/**
 * Whether rule `a` matches everything `b` matches, zones aside (zones only
 * need to meet): protocols, ports, addresses, MACs, family and ipset. An
 * earlier narrow exception (`udp 123` ACCEPT before a REJECT of everything)
 * does not cover the later rule; an earlier `lan → wan` ACCEPT of all
 * traffic covers a later block rule `* → wan` for the devices on `lan`.
 */
export function ruleCovers(a: RuleMatch, b: RuleMatch): boolean {
  const aAll = a.proto.length === 0 || a.proto.includes('all')
  const bAll = b.proto.length === 0 || b.proto.includes('all')
  const proto = aAll || (!bAll && b.proto.every((p) => a.proto.includes(p)))
  return (
    proto &&
    (a.family === 'any' || a.family === b.family) &&
    listCovers(a.srcIp, b.srcIp) &&
    listCovers(a.srcMac, b.srcMac) &&
    listCovers(a.destIp, b.destIp) &&
    portsCoverAll(a.srcPort, b.srcPort) &&
    portsCoverAll(a.destPort, b.destPort) &&
    (a.ipset === null || a.ipset === b.ipset)
  )
}

/**
 * `shadowedBy` of plan 2 section 5 (`managed_rule_shadowed`): for each
 * enabled rule, the first earlier enabled rule with the opposite verdict
 * (ACCEPT vs REJECT/DROP) whose zones meet it and whose match covers it
 * (`ruleCovers`): for the packets of the shared zones the later rule never
 * decides. `rules` is in file order; keys are the input's `id`.
 */
export function ruleShadows<T extends { id: string; options: UciOptions }>(
  rules: T[]
): Map<string, string> {
  const out = new Map<string, string>()
  const matches = rules.map((r) => ({ id: r.id, m: ruleMatch(r.options) }))
  for (let i = 0; i < matches.length; i++) {
    const later = matches[i]
    if (!later.m.enabled || !VERDICTS.has(later.m.target)) continue
    for (let j = 0; j < i; j++) {
      const earlier = matches[j]
      if (!earlier.m.enabled || !VERDICTS.has(earlier.m.target)) continue
      const opposite = (earlier.m.target === 'ACCEPT') !== (later.m.target === 'ACCEPT')
      const zones = zonesMeet(earlier.m.src, later.m.src) && zonesMeet(earlier.m.dest, later.m.dest)
      if (opposite && zones && ruleCovers(earlier.m, later.m)) {
        out.set(later.id, earlier.id)
        break
      }
    }
  }
  return out
}

/** The fields of a DNAT redirect that decide what it catches. */
export interface RedirectMatch {
  src: string | null
  proto: string[]
  srcDport: PortRange[]
  srcIp: string[]
  srcDip: string[]
  family: 'ipv4' | 'ipv6' | 'any'
  enabled: boolean
}

export function redirectMatch(options: UciOptions): RedirectMatch {
  const proto = protocolsOf(options.proto)
  return {
    src: scalar(options, 'src'),
    // fw4's redirect default is `tcp udp`.
    proto: proto.length > 0 ? proto : ['tcp', 'udp'],
    srcDport: parsePorts(options.src_dport) ?? [],
    srcIp: lowerWords(options.src_ip),
    srcDip: lowerWords(options.src_dip),
    family: familyOf(scalar(options, 'family')),
    enabled: truthy(scalar(options, 'enabled'), true),
  }
}

/** Whether two enabled DNAT redirects catch the same packets (the later one never sees them). */
export function redirectsOverlap(a: RedirectMatch, b: RedirectMatch): boolean {
  return (
    a.enabled &&
    b.enabled &&
    zonesMeet(a.src, b.src) &&
    protosMeet(a.proto, b.proto) &&
    familiesMeet(a.family, b.family) &&
    portsIntersect(a.srcDport, b.srcDport) &&
    listsMeet(a.srcIp, b.srcIp) &&
    listsMeet(a.srcDip, b.srcDip)
  )
}

/** For each redirect (file order), the first earlier one it overlaps with. */
export function redirectShadows<T extends { id: string; options: UciOptions }>(
  redirects: T[]
): Map<string, string> {
  const out = new Map<string, string>()
  const matches = redirects.map((r) => ({ id: r.id, m: redirectMatch(r.options) }))
  for (let i = 0; i < matches.length; i++) {
    for (let j = 0; j < i; j++) {
      if (redirectsOverlap(matches[j].m, matches[i].m)) {
        out.set(matches[i].id, matches[j].id)
        break
      }
    }
  }
  return out
}

// ── the management path (README 3.8, plan 2 section 4.3 "Lockout") ───────

export interface PathContext {
  /** The zone the agent reaches the controller through. */
  managementZone: string | null
  /** The controller's address (from the router's `ip route get`). */
  controllerAddress?: string | null
  /** The zone of the admin's current client, when known (REST only). */
  adminZone?: string | null
}

export type PathVerdict = {
  code: 'firewall_controller_path' | 'firewall_admin_path'
  message: string
}

function coversAddress(list: string[], address: string | null | undefined): boolean {
  if (list.length === 0) return true
  if (!address) return true
  return list.some((entry) => entry.startsWith('!') || ipInCidr(address, entry))
}

/**
 * Would this rule cut the controller path or the admin's way in? Only
 * enabled REJECT/DROP rules can. Refused:
 *
 * - an output rule (no `src`) towards the management zone, any zone (`*`)
 *   or no zone at all: the router's own traffic to the controller
 *   (`firewall_controller_path`; T-F3's `zone wan output REJECT`);
 * - an input rule (no `dest`) from the management zone or `*` that covers
 *   the controller's address (`firewall_controller_path`), or from the
 *   admin's zone, the management zone or `*` that covers port 22, 80 or 443
 *   on the router (`firewall_admin_path`: LuCI and ssh);
 * - a forward rule from the admin's zone (or `*`) to the management zone
 *   (or `*`) that covers the controller's address (`firewall_admin_path`:
 *   the admin loses the dashboard).
 */
export function checkRulePath(options: UciOptions, ctx: PathContext): PathVerdict | null {
  const m = ruleMatch(options)
  if (!m.enabled || (m.target !== 'REJECT' && m.target !== 'DROP')) return null
  const mgmt = ctx.managementZone
  const inZone = (zone: string | null, wanted: string | null | undefined) =>
    zone === '*' || (wanted !== null && wanted !== undefined && zone === wanted)
  if (m.src === null) {
    if (m.dest === null || m.dest === '*' || (mgmt !== null && m.dest === mgmt)) {
      if (coversAddress(m.destIp, ctx.controllerAddress)) {
        return {
          code: 'firewall_controller_path',
          message: 'This rule would block the router’s own traffic to the controller.',
        }
      }
    }
    return null
  }
  if (m.dest === null) {
    if (inZone(m.src, mgmt) && coversAddress(m.srcIp, ctx.controllerAddress)) {
      if (m.srcMac.length === 0 && m.ipset === null && m.destPort.length === 0) {
        return {
          code: 'firewall_controller_path',
          message: 'This rule would block the controller’s zone from the router.',
        }
      }
    }
    const fromAdmin = inZone(m.src, ctx.adminZone) || inZone(m.src, mgmt)
    if (
      fromAdmin &&
      protosMeet(m.proto, ['tcp']) &&
      ADMIN_PORTS.some((p) => portsCover(m.destPort, p))
    ) {
      return {
        code: 'firewall_admin_path',
        message: 'This rule would block ssh or the web interface of the router (22, 80, 443).',
      }
    }
    return null
  }
  if (
    (inZone(m.src, ctx.adminZone) || m.src === '*') &&
    (inZone(m.dest, mgmt) || m.dest === '*') &&
    ctx.adminZone !== undefined &&
    ctx.adminZone !== null &&
    coversAddress(m.destIp, ctx.controllerAddress) &&
    m.srcMac.length === 0 &&
    m.ipset === null
  ) {
    return {
      code: 'firewall_admin_path',
      message: 'This rule would block your own client from the controller.',
    }
  }
  return null
}

// ── validation ───────────────────────────────────────────────────────────

/** File order: by the router position the caller passed (`position`), new sections last. */
function positionOrder(sections: SyncedSection[]): SyncedSection[] {
  const pos = (s: SyncedSection) => s.position ?? Number.MAX_SAFE_INTEGER
  return sections
    .map((s, i) => ({ s, i }))
    .sort((a, b) => pos(a.s) - pos(b.s) || a.i - b.i)
    .map((x) => x.s)
}

function validateFirewall(desired: SyncedSection[], ctx: ValidationCtx): Issue[] {
  const issues: Issue[] = []
  const own = desired.filter((s) => s.config === 'firewall')
  const everything = [
    ...ctx.all.filter((s) => s.config === 'firewall'),
    ...(ctx.unmanaged ?? []).filter((s) => s.config === 'firewall'),
  ]
  const zones = zonesOf(everything)
  const zoneNames = new Set(zones.map((z) => z.name))
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
      config: s.config,
      section: s.name,
      ...(option ? { option } : {}),
    })
  const zoneRef = (s: SyncedSection, option: string, allowAny: boolean) => {
    const value = scalar(s.options, option)
    if (value === null) return
    if (value === '*' && allowAny) return
    if (!zoneNames.has(value)) {
      issue(s, 'error', 'firewall_zone_unknown', `No firewall zone "${value}"`, option)
    }
  }
  const ports = (s: SyncedSection, option: string) => {
    if (s.options[option] === undefined) return
    if (parsePorts(s.options[option]) === null) {
      issue(
        s,
        'error',
        'firewall_port_invalid',
        `"${portText(s.options[option])}" is not a port or port range (1–65535)`,
        option
      )
    }
  }
  const addresses = (s: SyncedSection, option: string) => {
    for (const word of lowerWords(s.options[option])) {
      if (!isIpOrCidr(word)) {
        issue(s, 'error', 'firewall_ip_invalid', `"${word}" is not an address or network`, option)
      }
    }
  }
  const macs = (s: SyncedSection, option: string) => {
    for (const mac of macsOf(s.options[option])) {
      if (!MAC.test(mac)) issue(s, 'error', 'invalid_mac', `"${mac}" is not a MAC address`, option)
    }
  }

  const seenZones = new Map<string, SyncedSection>()
  const seenForwardings = new Map<string, SyncedSection>()
  for (const s of own) {
    switch (s.type) {
      case 'zone': {
        const z = zoneInfo(s.options)
        const other = seenZones.get(z.name)
        if (other)
          issue(s, 'error', 'firewall_zone_duplicate', `Zone ${z.name} is defined twice`, 'name')
        seenZones.set(z.name, s)
        for (const policy of ['input', 'output', 'forward'] as const) {
          const value = z[policy]
          if (value !== null && !ZONE_POLICIES.includes(value)) {
            issue(s, 'error', 'firewall_policy_invalid', `"${value}" is not a zone policy`, policy)
          }
        }
        break
      }
      case 'forwarding': {
        zoneRef(s, 'src', false)
        zoneRef(s, 'dest', false)
        const key = `${scalar(s.options, 'src')}>${scalar(s.options, 'dest')}:${familyOf(scalar(s.options, 'family'))}`
        if (seenForwardings.has(key)) {
          issue(s, 'warning', 'firewall_forwarding_duplicate', 'The same forwarding exists twice')
        }
        seenForwardings.set(key, s)
        break
      }
      case 'rule': {
        zoneRef(s, 'src', true)
        zoneRef(s, 'dest', true)
        ports(s, 'src_port')
        ports(s, 'dest_port')
        addresses(s, 'src_ip')
        addresses(s, 'dest_ip')
        macs(s, 'src_mac')
        const target = (scalar(s.options, 'target') ?? 'DROP').toUpperCase()
        if (!RULE_TARGETS.includes(target)) {
          issue(s, 'error', 'firewall_target_invalid', `"${target}" is not a rule target`, 'target')
        }
        const proto = protocolsOf(s.options.proto)
        if (
          s.options.dest_port !== undefined &&
          proto.length > 0 &&
          !proto.some(
            (p) => p === 'tcp' || p === 'udp' || p === 'all' || p === 'sctp' || p === 'udplite'
          )
        ) {
          issue(
            s,
            'warning',
            'firewall_port_ignored',
            'Ports only apply to TCP and UDP',
            'dest_port'
          )
        }
        const ipset = scalar(s.options, 'ipset')
        if (ipset !== null) {
          const name = ipset.replace(/^!/, '').split(/\s+/)[0]
          const known = everything.some(
            (x) => x.type === 'ipset' && scalar(x.options, 'name') === name
          )
          if (!known) {
            issue(s, 'error', 'firewall_ipset_unknown', `No IP set "${name}"`, 'ipset')
          }
        }
        const verdict = checkRulePath(s.options, {
          managementZone: zoneOfNetwork(zones, ctx.managementPath?.network ?? null),
          controllerAddress: ctx.managementPath?.controllerAddress ?? null,
        })
        if (verdict) issue(s, 'error', verdict.code, verdict.message)
        break
      }
      case 'redirect': {
        zoneRef(s, 'src', false)
        zoneRef(s, 'dest', false)
        ports(s, 'src_dport')
        ports(s, 'dest_port')
        ports(s, 'src_port')
        addresses(s, 'dest_ip')
        addresses(s, 'src_ip')
        addresses(s, 'src_dip')
        if (s.options.src_dport === undefined && truthy(scalar(s.options, 'enabled'), true)) {
          issue(
            s,
            'warning',
            'firewall_all_ports',
            'This port forward forwards every port',
            'src_dport'
          )
        }
        const destIp = scalar(s.options, 'dest_ip')
        if (destIp !== null && IPV4.test(destIp) && ctx.networks && ctx.networks.length > 0) {
          const inside = ctx.networks.some((n) => n.ipv4.some((cidr) => ipInCidr(destIp, cidr)))
          if (!inside) {
            issue(
              s,
              'warning',
              'firewall_dest_outside_networks',
              `${destIp} is outside every LAN network`,
              'dest_ip'
            )
          }
        }
        break
      }
      case 'ipset': {
        macs(s, 'entry')
        break
      }
    }
  }

  // Shadowing, in file order (the router's order; new sections last).
  const ordered = positionOrder(everything)
  const redirects = ordered
    .filter((s) => s.type === 'redirect' && isDnat(s.options))
    .map((s) => ({ id: s.perchId ?? s.name, options: s.options, s }))
  for (const [id, by] of redirectShadows(redirects)) {
    const s = redirects.find((r) => r.id === id)!.s
    if (!own.includes(s)) continue
    const other = redirects.find((r) => r.id === by)!.s
    issue(
      s,
      'warning',
      'firewall_redirect_shadowed',
      `Port forward ${label(s)} overlaps ${label(other)}, which comes first and wins`
    )
  }
  const rules = ordered
    .filter((s) => s.type === 'rule')
    .map((s) => ({ id: s.perchId ?? s.name, options: s.options, s }))
  for (const [id, by] of ruleShadows(rules)) {
    const s = rules.find((r) => r.id === id)!.s
    if (!own.includes(s)) continue
    const other = rules.find((r) => r.id === by)!.s
    issue(
      s,
      'warning',
      'managed_rule_shadowed',
      `Rule ${label(s)} is (partly) shadowed by ${label(other)}, which comes first`
    )
  }
  return issues
}

function label(s: SyncedSection): string {
  const name = scalar(s.options, 'name')
  return name ? `"${name}"` : s.name
}

// ── zone membership (for the networks domain, docs/gateway/networks.md 1.3) ──

/** A network's purpose (docs/gateway/networks.md): decides a new zone's defaults. */
export type NetworkPurpose = 'lan' | 'guest' | 'iot' | 'management' | 'custom'

/** fw4 zone names: letters, digits, `_`; fw3 capped them at 11 characters, kept as the limit. */
export const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,10}$/

/**
 * A zone with `network` added to its `network` list (no-op when present).
 * Keeps the section's spelling: a `list network` stays a list, an `option
 * network 'a b'` stays one string.
 */
export function addNetworkToZone(zone: FirewallObject, network: string): FirewallObject {
  const current = zone.options.network
  const words = wordsOf(current)
  if (words.includes(network)) return zone
  const options = cloneOptions(zone.options)
  options.network =
    typeof current === 'string' ? [...words, network].join(' ') : [...words, network]
  return { ...zone, options }
}

/** A zone without `network` in its `network` list (the option goes when the list empties). */
export function removeNetworkFromZone(zone: FirewallObject, network: string): FirewallObject {
  const current = zone.options.network
  const words = wordsOf(current)
  if (!words.includes(network)) return zone
  const options = cloneOptions(zone.options)
  const rest = words.filter((w) => w !== network)
  if (rest.length === 0) delete options.network
  else options.network = typeof current === 'string' ? rest.join(' ') : rest
  return { ...zone, options }
}

/**
 * The sections a new network gets when it needs a zone of its own: the
 * zone, a forwarding to each WAN zone, and for `guest`/`iot` the DHCP and
 * DNS input rules (their input policy is REJECT). New objects (perchId
 * null, section '' = `perch_<id>`). Defaults per purpose:
 *
 * | purpose | input | output | forward | extra |
 * |---|---|---|---|---|
 * | lan | ACCEPT | ACCEPT | ACCEPT | |
 * | management | ACCEPT | ACCEPT | REJECT | |
 * | guest, iot | REJECT | ACCEPT | REJECT | `<zone>-DHCP` udp 67, `<zone>-DNS` tcp/udp 53 |
 * | custom | REJECT | ACCEPT | REJECT | |
 *
 * Throws on an invalid or taken zone name (callers turn it into a 422/409).
 */
export function zoneObjectsForNetwork(input: {
  network: string
  purpose: NetworkPurpose
  /** Default: the network's name. */
  zoneName?: string
  wanZones: string[]
  existingZones: string[]
}): FirewallObject[] {
  const name = input.zoneName ?? input.network
  if (!ZONE_NAME.test(name)) throw new Error(`"${name}" is not a valid zone name`)
  if (input.existingZones.includes(name)) throw new Error(`zone ${name} exists`)
  const open = input.purpose === 'lan' || input.purpose === 'management'
  const obj = (type: string, options: UciOptions): FirewallObject => ({
    perchId: null,
    section: '',
    type,
    options,
    secretNames: [],
  })
  const out: FirewallObject[] = [
    obj('zone', {
      name,
      network: [input.network],
      input: open ? 'ACCEPT' : 'REJECT',
      output: 'ACCEPT',
      forward: input.purpose === 'lan' ? 'ACCEPT' : 'REJECT',
    }),
  ]
  for (const wan of input.wanZones) out.push(obj('forwarding', { src: name, dest: wan }))
  if (input.purpose === 'guest' || input.purpose === 'iot') {
    const title = name.charAt(0).toUpperCase() + name.slice(1)
    out.push(
      obj('rule', {
        name: `${title}-DHCP`,
        src: name,
        proto: 'udp',
        dest_port: '67',
        target: 'ACCEPT',
        family: 'ipv4',
      }),
      obj('rule', {
        name: `${title}-DNS`,
        src: name,
        proto: ['tcp', 'udp'],
        dest_port: '53',
        target: 'ACCEPT',
      })
    )
  }
  return out
}

/** Whether a MAC is a valid unicast-looking MAC (`02:00:00:…`). */
export function isMac(value: string): boolean {
  return MAC.test(value.toLowerCase())
}

export function isIpv4(value: string): boolean {
  return IPV4.test(value)
}

export type { ManagementPath }
