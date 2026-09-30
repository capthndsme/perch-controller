import { itemsOf } from '#services/gateway_config/canonical'
import type {
  ConfigDomain,
  SectionEdit,
  SecretEdit,
  SyncedSection,
  ValidationCtx,
} from '#services/gateway_config/domain'
import { leaseSeconds } from '#services/gateway_config/domains/dhcp_hosts'
import {
  ipv4ToInt,
  nonLanNetworks,
  parseCidr,
  scalarOf,
} from '#services/gateway_config/domains/networks'
import type { Issue, UciConfigSet, UciOptions } from '#services/gateway_config/types'

/**
 * DHCP pools (`dhcp` config, `config dhcp '<net>'` sections; plan 2 section
 * 4.1): one pool per LAN network, keyed by its `interface`. The networks
 * domain creates and removes a network's pool with it (plan 1 section 8.1:
 * "the DHCP sibling owns dhcp pool sections and keys them by the network's
 * interface").
 *
 * Perch owns `interface ignore dhcpv4 start limit leasetime dhcp_option
 * domain force` (plan 2 P3). The IPv6 side (`ra dhcpv6 ndp ra_flags
 * ra_slaac dns`), `master` and anything newer are the router's: carried
 * verbatim, never a conflict, never drift. A pool of an interface off the
 * LAN side by the side rule (`side.ts`; `ignore '1'` on `wan`) is the `wan`
 * domain's (a WAN-side pool), not this one's.
 *
 * Equality is normalised (`12h` = `43200`; `ignore 'true'` = `'1'`); the
 * `dhcp_option` list merges per option code, so a new DNS server on one side
 * and a new NTP server on the other both land.
 */

export const DHCP_POOL_OWNED_OPTIONS = [
  'interface',
  'ignore',
  'dhcpv4',
  'start',
  'limit',
  'leasetime',
  'dhcp_option',
  'domain',
  'force',
] as const

export interface DhcpPool {
  perchId: string | null
  section: string
  interface: string
  /** Modeled options present on the section, spelling kept. */
  fields: UciOptions
  /** Router-owned and unknown options, verbatim. */
  extra: UciOptions
  secretNames: string[]
}

/** The code of a `dhcp_option` item (`6,192.168.1.1` → `6`, `option:dns-server,…` → `option:dns-server`). */
export function dhcpOptionCode(item: string): string {
  return item.trim().split(',')[0].toLowerCase()
}

function truthy(value: string): string {
  const text = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(text)) return '1'
  if (['0', 'false', 'no', 'off', 'disabled'].includes(text)) return '0'
  return text
}

/** Networks off the LAN side by the side rule (`side.ts`): their pools are not this domain's. */
function wanNetworksOf(all: UciConfigSet): Set<string> {
  return nonLanNetworks(all)
}

/** Enabled = served: not `ignore '1'` and not `dhcpv4 'disabled'`. */
export function poolEnabled(options: UciOptions): boolean {
  const ignore = scalarOf(options, 'ignore')
  if (ignore !== null && truthy(ignore) === '1') return false
  return scalarOf(options, 'dhcpv4') !== 'disabled'
}

export const dhcpPoolsDomain: ConfigDomain<DhcpPool> = {
  key: 'dhcp_pools',
  configs: ['dhcp'],
  types: ['dhcp'],

  claims(section, all) {
    if (section.config !== 'dhcp' || section.type !== 'dhcp') return false
    const iface = section.options.interface
    if (typeof iface !== 'string' || iface.length === 0) return false
    const scalars = ['ignore', 'dhcpv4', 'start', 'limit', 'leasetime', 'domain', 'force']
    if (
      !scalars.every(
        (k) => section.options[k] === undefined || typeof section.options[k] === 'string'
      )
    )
      return false
    // Known WAN-side interfaces keep their pool router-owned; an interface
    // the read does not know (no network config read) is taken as LAN.
    return !wanNetworksOf(all).has(iface)
  },

  ownership() {
    return { kind: 'options', options: [...DHCP_POOL_OWNED_OPTIONS] }
  },

  listSemantics: { 'dhcp.dhcp_option': { keyed: dhcpOptionCode } },

  normalize(type, option, value) {
    if (type !== 'dhcp' || typeof value !== 'string') return value
    switch (option) {
      case 'leasetime':
        return leaseSeconds(value)
      case 'ignore':
      case 'force':
        return truthy(value)
      case 'start':
      case 'limit':
        return /^\s*\d+\s*$/.test(value) ? String(Number(value)) : value
      default:
        return value
    }
  },

  identityKeys(section) {
    if (section.type !== 'dhcp') return []
    const iface = scalarOf(section.options, 'interface')
    return iface ? [`pool:${iface}`] : []
  },

  parse(sections) {
    return sections
      .filter((s) => s.config === 'dhcp' && s.type === 'dhcp')
      .map((s) => {
        const fields: UciOptions = {}
        const extra: UciOptions = {}
        for (const [key, value] of Object.entries(s.options)) {
          const copy = Array.isArray(value) ? [...value] : value
          if ((DHCP_POOL_OWNED_OPTIONS as readonly string[]).includes(key)) fields[key] = copy
          else extra[key] = copy
        }
        return {
          perchId: s.perchId,
          section: s.name,
          interface: scalarOf(s.options, 'interface') ?? '',
          fields,
          extra,
          secretNames: Object.keys(s.secrets ?? {}),
        } satisfies DhcpPool
      })
  },

  render(obj, current) {
    const existing = obj.perchId ? current.find((s) => s.perchId === obj.perchId) : undefined
    const options: UciOptions = { ...obj.extra }
    for (const [key, value] of Object.entries(obj.fields)) {
      options[key] = Array.isArray(value) ? [...value] : value
    }
    const secrets: Record<string, SecretEdit> = {}
    for (const name of obj.secretNames) {
      if (existing?.secrets?.[name]) secrets[name] = { keep: true }
    }
    const edit: SectionEdit = {
      op: 'put',
      perchId: obj.perchId,
      config: 'dhcp',
      type: 'dhcp',
      ...(obj.perchId ? {} : { name: obj.section }),
      options,
      ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
    }
    return [edit]
  },

  validate(desired, ctx) {
    return validatePools(desired, ctx)
  },
}

/**
 * Errors: two pools for one interface, `start`/`limit` that are not
 * positive integers, a malformed lease time. Warning: a range that does not
 * fit the network's subnet (`ctx.networks`).
 */
function validatePools(desired: SyncedSection[], ctx: ValidationCtx): Issue[] {
  const issues: Issue[] = []
  const pools = desired.filter((s) => s.config === 'dhcp' && s.type === 'dhcp')
  const others = [
    ...ctx.all.filter(
      (s) => s.config === 'dhcp' && s.type === 'dhcp' && !pools.some((p) => p.perchId === s.perchId)
    ),
    ...(ctx.unmanaged ?? []).filter((s) => s.config === 'dhcp' && s.type === 'dhcp'),
  ]
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

  const seen = new Map<string, SyncedSection>()
  for (const s of others) {
    const iface = scalarOf(s.options, 'interface')
    if (iface) seen.set(iface, s)
  }
  for (const s of pools) {
    const iface = scalarOf(s.options, 'interface')
    if (!iface) {
      issue(s, 'error', 'pool_interface_required', 'A pool needs its interface', 'interface')
      continue
    }
    const twin = seen.get(iface)
    if (twin && twin !== s) {
      issue(s, 'error', 'duplicate_pool', `${iface} already has a pool (${twin.name})`, 'interface')
    }
    seen.set(iface, s)
    const start = scalarOf(s.options, 'start')
    const limit = scalarOf(s.options, 'limit')
    for (const [name, value] of [
      ['start', start],
      ['limit', limit],
    ] as const) {
      if (value !== null && (!/^\s*\d+\s*$/.test(value) || Number(value) < 1)) {
        issue(s, 'error', 'invalid_pool_range', `${name} "${value}" is not a positive number`, name)
      }
    }
    const lease = scalarOf(s.options, 'leasetime')
    if (lease !== null && lease.toLowerCase() !== 'infinite' && !/^\d+[smhdw]?$/i.test(lease)) {
      issue(s, 'error', 'invalid_leasetime', `"${lease}" is not a lease time`, 'leasetime')
    }
    const network = ctx.networks?.find((n) => n.name === iface)
    const cidr = network ? parseCidr(network.ipv4[0] ?? '') : null
    if (cidr && poolEnabled(s.options)) {
      const size = 2 ** (32 - cidr.prefix)
      const offset = (ipv4ToInt(cidr.address) & (size - 1)) >>> 0
      const first = Number(start ?? '100')
      const last = first + Number(limit ?? '150') - 1
      if (Number.isFinite(first) && Number.isFinite(last) && (first < 1 || last > size - 2)) {
        issue(
          s,
          'warning',
          'pool_outside_subnet',
          `Addresses ${first}–${last} do not fit ${network!.ipv4[0]}`,
          'limit'
        )
      } else if (offset >= first && offset <= last) {
        issue(
          s,
          'warning',
          'pool_includes_router',
          `The router's address ${cidr.address} is inside the pool`,
          'start'
        )
      }
    }
  }
  return issues
}

/** Items of the `dhcp_option` list. */
export function dhcpOptions(options: UciOptions): string[] {
  return itemsOf(options.dhcp_option)
}
