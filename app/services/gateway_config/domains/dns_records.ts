import type {
  ConfigDomain,
  SectionEdit,
  SyncedSection,
  ValidationCtx,
} from '#services/gateway_config/domain'
import { flagValue } from '#services/gateway_config/domains/verbatim'
import type { Issue, UciOptions } from '#services/gateway_config/types'

/**
 * Local DNS records served by dnsmasq (`dhcp` config; plan 2 section 4.2):
 * `config domain` (`name`, `ip`: an A/AAAA record) and `config cname`
 * (`cname`, `target`). Perch owns those two options; anything else on the
 * section rides along as the router's.
 *
 * Names from device labels do not live here: they are `host` names
 * (`dhcp_hosts`), applied through the label-name review (README 7.10).
 * Reserved names (`wpad`, `localhost`, the router's own name, …) are refused
 * by the REST layer before an edit reaches the draft; this domain's
 * validation covers syntax and collisions.
 *
 * Gateway sync (docs/design/gateway-sync/domains.md 6): a `host` with no
 * `mac`, no `duid`, and a plain `name` and `ip` is a local DNS name, not a
 * reservation (`dhcp_hosts` claims hosts with a MAC and comes first in the
 * registry). Record type `host`: Perch owns `name`, `ip` and `dns`;
 * `hostid`, `leasetime`, `tag` and the rest stay the router's. Identity
 * `host:<name>`.
 */

export type DnsRecordType = 'a' | 'cname' | 'host'

export interface DnsRecord {
  perchId: string | null
  section: string
  type: DnsRecordType
  name: string
  value: string
  /** Options Perch does not model, verbatim. */
  extra: UciOptions
}

export const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const IPV6 = /^[0-9a-f:]+$/i

/** Names a label or record may never take (plan 2 section 4.2: `wpad` would be a proxy hijack). */
export const RESERVED_DNS_NAMES: readonly string[] = Object.freeze([
  'wpad',
  'isatap',
  'localhost',
  'perch',
  'router',
  'gateway',
  'openwrt',
  'broadcasthost',
])

export function isValidIp(value: string): boolean {
  if (IPV4.test(value)) return true
  return value.includes(':') && IPV6.test(value) && value.length <= 45
}

/** Whether a DNS name (any label, case-insensitive) is reserved. */
export function isReservedName(name: string, extra: readonly string[] = []): boolean {
  const first = name.toLowerCase().split('.')[0]
  const all = [...RESERVED_DNS_NAMES, ...extra.map((n) => n.toLowerCase())]
  return all.includes(first) || all.includes(name.toLowerCase())
}

/**
 * A label (`Living room TV`) as a DNS name: lowercase, `[a-z0-9-]`, at most
 * 63 characters, no leading or trailing dash; empty when nothing is left.
 */
export function slugifyLabel(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '')
}

const OWNED: Record<DnsRecordType, [string, string]> = {
  a: ['name', 'ip'],
  cname: ['cname', 'target'],
  host: ['name', 'ip'],
}

/** The UCI section type of a record type. */
export const SECTION_TYPE: Record<DnsRecordType, string> = {
  a: 'domain',
  cname: 'cname',
  host: 'host',
}

/**
 * A `dhcp` `host` that is only a DNS name (domains.md 6): no `mac`, no
 * `duid`, and a plain `name` and `ip`.
 */
export function isDnsHost(options: UciOptions): boolean {
  return (
    options.mac === undefined &&
    options.duid === undefined &&
    scalar(options, 'name') !== null &&
    scalar(options, 'ip') !== null
  )
}

function typeOf(sectionType: string, options?: UciOptions): DnsRecordType | null {
  if (sectionType === 'domain') return 'a'
  if (sectionType === 'cname') return 'cname'
  if (sectionType === 'host' && (!options || isDnsHost(options))) return 'host'
  return null
}

function scalar(options: UciOptions, key: string): string | null {
  const v = options[key]
  return typeof v === 'string' ? v : null
}

export const dnsRecordsDomain: ConfigDomain<DnsRecord> = {
  key: 'dns_records',
  configs: ['dhcp'],
  types: ['domain', 'cname', 'host'],

  claims(section) {
    if (section.config !== 'dhcp') return false
    const type = typeOf(section.type, section.options)
    if (!type) return false
    const [nameKey, valueKey] = OWNED[type]
    return scalar(section.options, nameKey) !== null && scalar(section.options, valueKey) !== null
  },

  ownership(section) {
    const type = typeOf(section.type) ?? 'a'
    return {
      kind: 'options',
      options: type === 'host' ? [...OWNED.host, 'dns'] : [...OWNED[type]],
    }
  },

  normalize(type, option, value) {
    if (typeof value !== 'string') return value
    if (['name', 'ip', 'cname', 'target'].includes(option) && typeOf(type)) {
      return value.trim().toLowerCase()
    }
    if (type === 'host' && option === 'dns') return flagValue(value)
    return value
  },

  identityKeys(section) {
    const type = typeOf(section.type, section.options)
    if (!type) return []
    const name = scalar(section.options, OWNED[type][0])
    if (!name) return []
    // A name may carry several A records (round robin); a CNAME and a host
    // name are unique.
    if (type === 'cname') return [`cname:${name.toLowerCase()}`]
    if (type === 'host') return [`host:${name.toLowerCase()}`]
    return []
  },

  parse(sections) {
    const out: DnsRecord[] = []
    for (const s of sections) {
      const type = typeOf(s.type, s.options)
      if (s.config !== 'dhcp' || !type) continue
      const [nameKey, valueKey] = OWNED[type]
      const extra: UciOptions = {}
      for (const [k, v] of Object.entries(s.options)) {
        if (k !== nameKey && k !== valueKey) extra[k] = Array.isArray(v) ? [...v] : v
      }
      out.push({
        perchId: s.perchId,
        section: s.name,
        type,
        name: scalar(s.options, nameKey) ?? '',
        value: scalar(s.options, valueKey) ?? '',
        extra,
      })
    }
    return out
  },

  render(obj) {
    const [nameKey, valueKey] = OWNED[obj.type]
    const edit: SectionEdit = {
      op: 'put',
      perchId: obj.perchId,
      config: 'dhcp',
      type: SECTION_TYPE[obj.type],
      options: { ...obj.extra, [nameKey]: obj.name, [valueKey]: obj.value },
    }
    return [edit]
  },

  validate(desired, ctx) {
    return validateRecords(desired, ctx)
  },
}

function validateRecords(desired: SyncedSection[], ctx: ValidationCtx): Issue[] {
  const issues: Issue[] = []
  const records = dnsRecordsDomain.parse(desired)
  const issue = (r: DnsRecord, code: string, message: string, option: string) =>
    issues.push({
      severity: 'error',
      code,
      message,
      perchId: r.perchId,
      config: 'dhcp',
      section: r.section,
      option,
    })
  const others = dnsRecordsDomain.parse(
    [...ctx.all, ...(ctx.unmanaged ?? [])].filter(
      (s) => !desired.some((d) => d.perchId !== null && d.perchId === s.perchId)
    )
  )
  const cnames = new Map<string, DnsRecord>()
  const aNames = new Set<string>()
  for (const r of [...others, ...records]) {
    if (r.type === 'a' || r.type === 'host') aNames.add(r.name.toLowerCase())
  }
  const controllerAddress = ctx.managementPath?.controllerAddress ?? null
  for (const r of others) if (r.type === 'cname') cnames.set(r.name.toLowerCase(), r)
  for (const r of records) {
    const [nameKey, valueKey] = OWNED[r.type]
    if (!HOSTNAME.test(r.name)) {
      issue(r, 'dns_name_invalid', `"${r.name}" is not a valid DNS name`, nameKey)
      continue
    }
    if ((r.type === 'a' || r.type === 'host') && !isValidIp(r.value)) {
      issue(r, 'dns_value_invalid', `"${r.value}" is not an IP address`, valueKey)
    }
    if (r.type === 'host' && controllerAddress !== null && r.value === controllerAddress) {
      // domains.md 6: the name the agents may dial; editing it can cut them off.
      issues.push({
        severity: 'warning',
        code: 'dns_controller_address',
        message: `${r.name} points at the controller's address; the gateway agent may dial it.`,
        perchId: r.perchId,
        config: 'dhcp',
        section: r.section,
        option: valueKey,
      })
    }
    if (r.type === 'cname') {
      if (!HOSTNAME.test(r.value)) {
        issue(r, 'dns_value_invalid', `"${r.value}" is not a valid target name`, valueKey)
      }
      const key = r.name.toLowerCase()
      const owner = cnames.get(key)
      if (owner && owner !== r) {
        issue(r, 'dns_name_taken', `${r.name} is already an alias (${owner.section})`, nameKey)
      }
      cnames.set(key, r)
      if (aNames.has(key)) {
        issue(r, 'dns_name_taken', `${r.name} already has an address record`, nameKey)
      }
      if (key === r.value.toLowerCase()) {
        issue(r, 'dns_value_invalid', 'An alias cannot point at itself', valueKey)
      }
    }
  }
  return issues
}
