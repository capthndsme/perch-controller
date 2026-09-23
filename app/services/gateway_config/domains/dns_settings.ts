import { itemsOf } from '#services/gateway_config/canonical'
import type { ConfigDomain, FeatureSyncIssue, SyncedSection } from '#services/gateway_config/domain'
import {
  flagOf,
  flagValue,
  isDnsName,
  isIpAddress,
  isPrivateAddress,
  parseVerbatim,
  renderVerbatim,
  scalarOption,
  scalarsOnly,
  type VerbatimSection,
} from '#services/gateway_config/domains/verbatim'
import type { Issue, UciOptions } from '#services/gateway_config/types'

/**
 * dnsmasq's resolver settings (`dhcp` config, `config dnsmasq` sections;
 * plan 2 section 4.2):
 *
 * | Option | Ownership |
 * |---|---|
 * | `domain`, `local`, `rebind_protection`, `noresolv` | Perch (two-way) |
 * | `server[]` (upstreams `ip[#port]`, domain forwards `/example.com/ip`, local-only `/example.com/`), `rebind_domain[]`, `address[]` (`/example.com/192.168.x.5`) | **per item** (plan 2 P4): Perch owns the items it added; the router's items stay the router's, in its order |
 * | `port`, `interface[]`, `notinterface[]`, `resolvfile`, `leasefile`, `cachesize`, … | router (carried verbatim, never drift) |
 *
 * `port` is router-owned on purpose: the live gateway runs dnsmasq on :54
 * behind AdGuard Home (decision 12: AdGuard is observe only), and moving
 * dnsmasq's port from the controller would take DNS away from the front
 * resolver. Nothing here ever touches AdGuard.
 *
 * Several `dnsmasq` sections (instances) are each claimed; the REST layer
 * addresses one by its perch id (default: the first).
 */

export const DNS_SETTINGS_DOMAIN_KEY = 'dns_settings'

export const DNS_OWNED_OPTIONS = ['domain', 'local', 'rebind_protection', 'noresolv'] as const
export const DNS_ITEM_OPTIONS = ['server', 'rebind_domain', 'address'] as const

// ── item syntax ──────────────────────────────────────────────────────────

/** One `server` item, parsed. */
export type ServerItem =
  | { kind: 'upstream'; server: string }
  | { kind: 'forward'; domains: string[]; server: string }
  | { kind: 'local'; domains: string[] }

/** `1.1.1.1`, `1.1.1.1#5353`, `fd00::53`, `192.168.1.2@eth0`, `192.168.1.2#53@wan`. */
export function isServerTarget(value: string): boolean {
  const m = /^([^#@]+)(?:#(\d{1,5}))?(?:@([A-Za-z0-9_.:-]{1,64}))?$/.exec(value)
  if (!m) return false
  if (!isIpAddress(m[1])) return false
  if (m[2] !== undefined && (Number(m[2]) < 1 || Number(m[2]) > 65535)) return false
  return true
}

function domainList(text: string): string[] | null {
  // `/a/b/` → [a, b]; `#` = every domain; `` (//) = unqualified names.
  if (!text.startsWith('/')) return null
  const end = text.lastIndexOf('/')
  if (end <= 0) return null
  const domains = text.slice(1, end).split('/')
  if (domains.some((d) => d !== '' && d !== '#' && !isDnsName(d.replace(/^\*\.?/, '')))) {
    return null
  }
  return domains.map((d) => d.toLowerCase())
}

/** A `server` item, or null when dnsmasq would not take it. */
export function parseServerItem(item: string): ServerItem | null {
  const text = item.trim()
  if (text.startsWith('/')) {
    const end = text.lastIndexOf('/')
    const domains = domainList(text.slice(0, end + 1))
    if (!domains) return null
    const rest = text.slice(end + 1)
    if (rest === '') return { kind: 'local', domains }
    // `#` = forward these domains to the standard servers.
    if (rest === '#' || isServerTarget(rest)) return { kind: 'forward', domains, server: rest }
    return null
  }
  return isServerTarget(text) ? { kind: 'upstream', server: text } : null
}

/** An `address` item: `/example.com/192.168.x.5`, `/example.com/` (NXDOMAIN), `/example.com/#` (0.0.0.0). */
export function parseAddressItem(item: string): { domains: string[]; address: string } | null {
  const text = item.trim()
  if (!text.startsWith('/')) return null
  const end = text.lastIndexOf('/')
  const domains = domainList(text.slice(0, end + 1))
  if (!domains) return null
  const address = text.slice(end + 1)
  if (address !== '' && address !== '#' && !isIpAddress(address)) return null
  return { domains, address }
}

/** A `rebind_domain` item: `example.com` or `/example.com/` (dnsmasq `--rebind-domain-ok`). */
export function parseRebindItem(item: string): string[] | null {
  const text = item.trim()
  if (text.startsWith('/')) return domainList(text.endsWith('/') ? text : `${text}/`)
  return isDnsName(text) ? [text.toLowerCase().replace(/\.$/, '')] : null
}

/** `local`: `/lan/` (or a bare `lan`). */
export function parseLocalDomain(value: string): string[] | null {
  const text = value.trim()
  if (text.startsWith('/')) return domainList(text)
  return isDnsName(text) ? [text.toLowerCase()] : null
}

/** Whether `name` falls under one of `domains` (`#` = all; `` = unqualified names). */
export function nameCovered(name: string, domains: string[]): boolean {
  const n = name.toLowerCase().replace(/\.$/, '')
  return domains.some((raw) => {
    const d = raw.replace(/^\*\.?/, '').replace(/\.$/, '')
    if (d === '#') return true
    if (d === '') return !n.includes('.')
    return n === d || n.endsWith(`.${d}`)
  })
}

// ── views of one instance ────────────────────────────────────────────────

export type ItemOwner = 'perch' | 'router'

export interface DnsInstanceSettings {
  domain: string | null
  local: string | null
  rebindProtection: boolean
  noresolv: boolean
  /** Router-owned, shown only. */
  port: number | null
  interfaces: string[]
  notInterfaces: string[]
  upstreams: Array<{ value: string; owner: ItemOwner }>
  forwards: Array<{ value: string; domains: string[]; server: string | null; owner: ItemOwner }>
  addresses: Array<{ value: string; domains: string[]; address: string; owner: ItemOwner }>
  rebindDomains: Array<{ value: string; owner: ItemOwner }>
  /** Items the controller cannot parse, shown as they are. */
  other: Array<{ option: string; value: string; owner: ItemOwner }>
}

/** Reads one instance; `owned` = the section's item ownership (items Perch added). */
export function dnsInstanceSettings(
  options: UciOptions,
  owned: Partial<Record<string, string[]>> | null
): DnsInstanceSettings {
  const ownerOf = (option: string, value: string): ItemOwner =>
    owned?.[option]?.includes(value) ? 'perch' : 'router'
  const out: DnsInstanceSettings = {
    domain: scalarOption(options, 'domain'),
    local: scalarOption(options, 'local'),
    // dnsmasq.init: rebind_protection defaults on; noresolv off.
    rebindProtection: flagOf(options, 'rebind_protection', true),
    noresolv: flagOf(options, 'noresolv', false),
    port: portOf(options),
    interfaces: itemsOf(options.interface),
    notInterfaces: itemsOf(options.notinterface),
    upstreams: [],
    forwards: [],
    addresses: [],
    rebindDomains: [],
    other: [],
  }
  for (const value of itemsOf(options.server)) {
    const owner = ownerOf('server', value)
    const parsed = parseServerItem(value)
    if (!parsed) out.other.push({ option: 'server', value, owner })
    else if (parsed.kind === 'upstream') out.upstreams.push({ value, owner })
    else {
      out.forwards.push({
        value,
        domains: parsed.domains,
        server: parsed.kind === 'forward' ? parsed.server : null,
        owner,
      })
    }
  }
  for (const value of itemsOf(options.address)) {
    const owner = ownerOf('address', value)
    const parsed = parseAddressItem(value)
    if (!parsed) out.other.push({ option: 'address', value, owner })
    else out.addresses.push({ value, domains: parsed.domains, address: parsed.address, owner })
  }
  for (const value of itemsOf(options.rebind_domain)) {
    const owner = ownerOf('rebind_domain', value)
    if (parseRebindItem(value)) out.rebindDomains.push({ value, owner })
    else out.other.push({ option: 'rebind_domain', value, owner })
  }
  return out
}

/** dnsmasq's DNS port: 53 by default, 0 = DNS off. */
export function portOf(options: UciOptions): number | null {
  const port = scalarOption(options, 'port')
  if (port === null) return 53
  return /^\d{1,5}$/.test(port) ? Number(port) : null
}

/**
 * The item list after an edit of the owned items of one category
 * (`inCategory`; upstreams and forwards share `server`): the router's items
 * and owned items of other categories stay where they are, owned items of
 * the category stay when still wanted, new ones are appended in the
 * request's order. A wanted item equal to a router item stays the router's.
 */
export function editOwnedItems(
  current: string[],
  owned: string[],
  wanted: string[],
  inCategory: (item: string) => boolean = () => true
): string[] {
  const kept = current.filter(
    (item) => !owned.includes(item) || !inCategory(item) || wanted.includes(item)
  )
  const added = [...new Set(wanted)].filter((item) => !kept.includes(item))
  return [...kept, ...added]
}

// ── the controller's name (plan 2 section 4.2: "Controller name pin") ────

/** What the controller knows about the name the agents dial. */
export interface ControllerHost {
  /** Host name of the controller URL (null when the agents dial an address). */
  name: string | null
  /** Addresses the router resolved it to (the resolver observation). */
  addresses: string[]
  /** Names the router's dnsmasq answers from its own records (hosts, `domain` records). */
  localNames: string[]
}

export type GuardRefusal = { status: 409 | 422; code: string; message: string }

function plainUpstreams(options: UciOptions): string[] {
  return itemsOf(options.server).filter((i) => parseServerItem(i)?.kind === 'upstream')
}

/**
 * The name-resolution guard of a DNS settings edit (plan 2 section 4.2,
 * the controller name pin): refuses an edit that would stop the router
 * resolving at all (422 `dns_no_upstream`) or change or drop the answer for
 * the controller's host name (409 `dns_controller_name_pinned`):
 *
 * - a new `address`/`server` item for the name's domain (unless an address
 *   item keeps the address the router resolves today), or dropping one;
 * - `local` newly covering the name when no local record answers it;
 * - rebind protection dropping the name's `rebind_domain` cover while the
 *   name resolves to a private address from upstream;
 * - removing a private upstream server while the name resolves privately
 *   and nothing local answers it (the name likely comes from that server).
 */
export function dnsEditGuard(
  before: UciOptions,
  after: UciOptions,
  host: ControllerHost
): GuardRefusal | null {
  const upBefore = plainUpstreams(before)
  const upAfter = plainUpstreams(after)
  const resolvedBefore = !flagOf(before, 'noresolv', false) || upBefore.length > 0
  const resolvedAfter = !flagOf(after, 'noresolv', false) || upAfter.length > 0
  if (resolvedBefore && !resolvedAfter) {
    return {
      status: 422,
      code: 'dns_no_upstream',
      message:
        'With "ignore resolv file" on and no upstream server the router cannot resolve names.',
    }
  }
  const name = host.name?.toLowerCase().replace(/\.$/, '') ?? null
  if (!name || isIpAddress(name)) return null
  const pinned = (message: string): GuardRefusal => ({
    status: 409,
    code: 'dns_controller_name_pinned',
    message: `${message} (${name} is the name the gateway agents dial).`,
  })

  const nameItems = (options: UciOptions) => {
    const items: string[] = []
    for (const value of itemsOf(options.server)) {
      const p = parseServerItem(value)
      if (p && p.kind !== 'upstream' && nameCovered(name, p.domains)) items.push(`server:${value}`)
    }
    for (const value of itemsOf(options.address)) {
      const p = parseAddressItem(value)
      if (p && nameCovered(name, p.domains)) items.push(`address:${value}`)
    }
    return items
  }
  const itemsBefore = nameItems(before)
  const itemsAfter = nameItems(after)
  for (const item of itemsAfter) {
    if (itemsBefore.includes(item)) continue
    const address = item.startsWith('address:') ? parseAddressItem(item.slice(8))?.address : null
    if (address && host.addresses.includes(address)) continue
    return pinned(`"${item.replace(/^\w+:/, '')}" would change the answer for the controller`)
  }
  for (const item of itemsBefore) {
    if (!itemsAfter.includes(item)) {
      return pinned(`"${item.replace(/^\w+:/, '')}" is how the router answers the controller`)
    }
  }

  const answeredLocally = host.localNames.some((n) => n.toLowerCase() === name)
  const localOf = (options: UciOptions) => {
    const local = scalarOption(options, 'local')
    return local ? (parseLocalDomain(local) ?? []) : []
  }
  if (
    nameCovered(name, localOf(after)) &&
    !nameCovered(name, localOf(before)) &&
    !answeredLocally
  ) {
    return pinned('The local domain would cover the controller, and no local record answers it')
  }

  const privateAnswer = host.addresses.some((a) => isPrivateAddress(a))
  if (privateAnswer && !answeredLocally) {
    const covered = (options: UciOptions) =>
      !flagOf(options, 'rebind_protection', true) ||
      itemsOf(options.rebind_domain).some((i) => nameCovered(name, parseRebindItem(i) ?? []))
    if (covered(before) && !covered(after)) {
      return pinned('Rebind protection would drop the controller’s private answer')
    }
    const removedPrivate = upBefore.filter((u) => !upAfter.includes(u) && privateTarget(u))
    if (removedPrivate.length > 0 && itemsBefore.length === 0) {
      return pinned(
        `The controller resolves privately and may be answered by ${removedPrivate.join(', ')}`
      )
    }
  }
  return null
}

function privateTarget(server: string): boolean {
  const address = server.split(/[#@]/)[0]
  return isIpAddress(address) && isPrivateAddress(address)
}

/**
 * Whether rebind protection would refuse the controller's answer as things
 * stand (the page offers to add the name to `rebind_domain`).
 */
export function suggestRebindDomain(options: UciOptions, host: ControllerHost): boolean {
  const name = host.name?.toLowerCase() ?? null
  if (!name || isIpAddress(name)) return false
  if (!flagOf(options, 'rebind_protection', true)) return false
  if (host.localNames.some((n) => n.toLowerCase() === name)) return false
  if (!host.addresses.some((a) => isPrivateAddress(a))) return false
  return !itemsOf(options.rebind_domain).some((i) => nameCovered(name, parseRebindItem(i) ?? []))
}

// ── the domain ───────────────────────────────────────────────────────────

export const dnsSettingsDomain: ConfigDomain<VerbatimSection> = {
  key: DNS_SETTINGS_DOMAIN_KEY,
  configs: ['dhcp'],
  types: ['dnsmasq'],

  claims(section) {
    return (
      section.config === 'dhcp' &&
      section.type === 'dnsmasq' &&
      scalarsOnly(section.options, DNS_OWNED_OPTIONS)
    )
  },

  ownership() {
    return {
      kind: 'options',
      options: [...DNS_OWNED_OPTIONS],
      items: { server: [], rebind_domain: [], address: [] },
    }
  },

  normalize(type, option, value) {
    if (type !== 'dnsmasq' || typeof value !== 'string') return value
    if (option === 'rebind_protection' || option === 'noresolv') return flagValue(value)
    if (option === 'domain' || option === 'local') return value.trim().toLowerCase()
    return value
  },

  parse(sections) {
    return parseVerbatim(sections, 'dhcp', ['dnsmasq'])
  },

  render(obj, current) {
    return renderVerbatim(obj, current, 'dhcp')
  },

  validate(desired) {
    return validateDns(desired)
  },

  inSync(sections, observed) {
    const issues: FeatureSyncIssue[] = []
    const synced = sections.filter((s) => s.scope === 'synced')
    if (synced.length === 0 || !observed.resolver) return issues
    const wantsDns = synced.some((s) => portOf(s.options) !== 0)
    if (wantsDns && observed.resolver.dnsmasqPort === null) {
      issues.push({
        feature: DNS_SETTINGS_DOMAIN_KEY,
        objectId: synced[0].perchId,
        code: 'dns_dnsmasq_not_running',
        message: 'dnsmasq is not answering on the router.',
      })
    }
    const host = observed.resolver.controllerHost
    if (host?.name && !isIpAddress(host.name) && (host.error || host.addresses.length === 0)) {
      issues.push({
        feature: DNS_SETTINGS_DOMAIN_KEY,
        objectId: null,
        code: 'dns_controller_name_unresolved',
        message: `The router cannot resolve ${host.name}${host.error ? ` (${host.error})` : ''}.`,
      })
    }
    return issues
  },
}

function validateDns(desired: SyncedSection[]): Issue[] {
  const issues: Issue[] = []
  for (const s of desired) {
    if (s.config !== 'dhcp' || s.type !== 'dnsmasq') continue
    const issue = (severity: Issue['severity'], code: string, message: string, option: string) =>
      issues.push({
        severity,
        code,
        message,
        perchId: s.perchId,
        config: 'dhcp',
        section: s.name,
        option,
      })
    for (const value of itemsOf(s.options.server)) {
      if (!parseServerItem(value)) {
        issue('error', 'dns_server_invalid', `"${value}" is not a DNS server entry`, 'server')
      }
    }
    for (const value of itemsOf(s.options.address)) {
      if (!parseAddressItem(value)) {
        issue('error', 'dns_address_invalid', `"${value}" is not an address override`, 'address')
      }
    }
    for (const value of itemsOf(s.options.rebind_domain)) {
      if (!parseRebindItem(value)) {
        issue('error', 'dns_rebind_domain_invalid', `"${value}" is not a domain`, 'rebind_domain')
      }
    }
    const domain = scalarOption(s.options, 'domain')
    if (domain !== null && domain !== '' && !isDnsName(domain)) {
      issue('error', 'dns_domain_invalid', `"${domain}" is not a domain`, 'domain')
    }
    const local = scalarOption(s.options, 'local')
    if (local !== null && local !== '' && !parseLocalDomain(local)) {
      issue('error', 'dns_local_invalid', `"${local}" is not a local domain`, 'local')
    }
    if (flagOf(s.options, 'noresolv', false) && plainUpstreams(s.options).length === 0) {
      issue(
        'warning',
        'dns_no_upstream',
        'Ignoring the resolv file with no upstream server: only local names resolve',
        'noresolv'
      )
    }
  }
  return issues
}
