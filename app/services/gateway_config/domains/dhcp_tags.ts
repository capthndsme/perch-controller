import { itemsOf } from '#services/gateway_config/canonical'
import type { ConfigDomain, SyncedSection } from '#services/gateway_config/domain'
import { dhcpOptionCode } from '#services/gateway_config/domains/dhcp_pools'
import {
  flagValue,
  parseVerbatim,
  renderVerbatim,
  scalarsOnly,
  type VerbatimSection,
} from '#services/gateway_config/domains/verbatim'
import type { Issue } from '#services/gateway_config/types'

/**
 * DHCP tags (`dhcp` config, `config tag '<name>'`; plan 2 section 4.1,
 * "pool options beyond the IPv4 core"): a named set of `dhcp_option` items
 * that dnsmasq sends to every client carrying the tag. A reservation gets a
 * tag through its `tag` option (the `dhcp_hosts` domain), so one device can
 * receive its own DNS server or gateway without a pool of its own.
 *
 * Perch owns `dhcp_option` (merged per option code, like a pool's) and
 * `force`; the section name is the tag. Other options ride along.
 */

export const DHCP_TAGS_DOMAIN_KEY = 'dhcp_tags'

/** A tag name dnsmasq accepts and UCI can name a section after. */
export const TAG_NAME = /^[A-Za-z0-9_]{1,32}$/

/**
 * One `dhcp_option` item: `<code>,<value>` (`6,192.168.1.2`), the
 * `option:<name>,<value>` spelling (`option:dns-server,…`), or with an
 * explicit tag prefix (`tag:guest,6,…`). Returns null for anything else.
 */
export function parseDhcpOption(
  item: string
): { tags: string[]; code: number | null; name: string | null; value: string } | null {
  const parts = item.trim().split(',')
  const tags: string[] = []
  while (parts.length > 0 && /^(tag|net):/i.test(parts[0])) tags.push(parts.shift()!.slice(4))
  if (parts.length < 1) return null
  const head = parts.shift()!.trim().toLowerCase()
  const value = parts.join(',').trim()
  if (/^\d{1,3}$/.test(head)) {
    const code = Number(head)
    if (code < 1 || code > 254) return null
    return { tags, code, name: null, value }
  }
  const named = /^option6?:([a-z0-9-]+)$/.exec(head)
  if (named) return { tags, code: DHCP_OPTION_NAMES[named[1]] ?? null, name: named[1], value }
  return null
}

/** dnsmasq's option names for the codes the pages show (`dnsmasq --help dhcp`). */
export const DHCP_OPTION_NAMES: Record<string, number> = {
  'netmask': 1,
  'router': 3,
  'dns-server': 6,
  'log-server': 7,
  'hostname': 12,
  'domain-name': 15,
  'ntp-server': 42,
  'netbios-ns': 44,
  'vendor-encap': 43,
  'tftp-server': 66,
  'bootfile-name': 67,
  'classless-static-route': 121,
  'domain-search': 119,
  'mtu': 26,
  'broadcast': 28,
  'static-route': 33,
  'T1': 58,
  'T2': 59,
  'server-ip-address': 150,
}

export const dhcpTagsDomain: ConfigDomain<VerbatimSection> = {
  key: DHCP_TAGS_DOMAIN_KEY,
  configs: ['dhcp'],
  types: ['tag'],

  claims(section) {
    return (
      section.config === 'dhcp' &&
      section.type === 'tag' &&
      !section.anonymous &&
      scalarsOnly(section.options, ['force'])
    )
  },

  ownership() {
    return { kind: 'options', options: ['dhcp_option', 'force'] }
  },

  listSemantics: { 'tag.dhcp_option': { keyed: dhcpOptionCode } },

  normalize(type, option, value) {
    if (type === 'tag' && option === 'force' && typeof value === 'string') return flagValue(value)
    return value
  },

  parse(sections) {
    return parseVerbatim(sections, 'dhcp', ['tag'])
  },

  render(obj, current) {
    return renderVerbatim(obj, current, 'dhcp')
  },

  validate(desired) {
    return validateTags(desired)
  },
}

function validateTags(desired: SyncedSection[]): Issue[] {
  const issues: Issue[] = []
  for (const s of desired) {
    if (s.config !== 'dhcp' || s.type !== 'tag') continue
    const issue = (code: string, message: string, option?: string) =>
      issues.push({
        severity: 'error',
        code,
        message,
        perchId: s.perchId,
        config: 'dhcp',
        section: s.name,
        ...(option ? { option } : {}),
      })
    if (!TAG_NAME.test(s.name)) issue('dhcp_tag_invalid', `"${s.name}" is not a tag name`)
    for (const item of itemsOf(s.options.dhcp_option)) {
      if (!parseDhcpOption(item)) {
        issue('dhcp_option_invalid', `"${item}" is not a DHCP option`, 'dhcp_option')
      }
    }
  }
  return issues
}
