import { itemsOf } from '#services/gateway_config/canonical'
import type {
  ConfigDomain,
  SectionEdit,
  SecretEdit,
  SyncedSection,
  ValidationCtx,
} from '#services/gateway_config/domain'
import type { Issue, UciOptions, UciValue } from '#services/gateway_config/types'

/**
 * DHCP host reservations (`dhcp` config, `config host` sections): the
 * sample domain that proves the registry (plan 2 section 4.1; the REST and
 * the device-page flow come with M3).
 *
 * Perch owns `mac`, `ip`, `name`, `dns` and `leasetime` (plan 2 P3); every
 * other option (`duid`, `hostid`, `tag`, `match_tag`, `instance`,
 * `broadcast`, anything newer) rides along verbatim and stays the router's:
 * the merge takes the router's value and Authoritative Mode never reverts
 * it. `ip 'ignore'` is a DHCP deny. A host with a wildcard MAC, or none, is
 * not a reservation: it stays unmodeled.
 *
 * Equality is normalised (`mac 'a b'` = `list mac 'a' 'b'`, any case and
 * order; `12h` = `720m`; `dns 'true'` = `'1'`), stored content never is:
 * the round trip reproduces the router's spelling exactly.
 */

export const DHCP_HOST_OWNED_OPTIONS = ['mac', 'ip', 'name', 'dns', 'leasetime'] as const

/**
 * Options Perch owns but carries in `extra` (edited by the DHCP page, not
 * modeled as fields): the host's dnsmasq tags (plan 2 section 4.1, "static
 * lease extras"). Rows claimed before `tag` was owned get it when an admin
 * first edits their tags (`widenOwnership`).
 */
export const DHCP_HOST_EXTRA_OWNED = ['tag'] as const

/** The tags of a host: `list tag` items or a space-separated `option tag`. */
export function hostTags(options: UciOptions): string[] {
  return itemsOf(options.tag)
    .flatMap((t) => t.split(/\s+/))
    .filter((t) => t.length > 0)
}

export interface DhcpReservation {
  perchId: string | null
  /** UCI section name. */
  section: string
  /** MACs, lowercase, in the section's order. */
  macs: string[]
  /** How the section spells its MACs: `list mac` or one (space-separated) string. */
  macForm: 'list' | 'string'
  /** `ignore` = DHCP deny; null = name-only host (the name follows the dynamic lease). */
  ip: string | null
  name: string | null
  /** Raw `dns` flag ('1' registers the name in DNS). */
  dns: string | null
  leasetime: string | null
  /** Options Perch does not model, verbatim. */
  extra: UciOptions
  /** Secret slots the section carries (none expected; kept as the router's). */
  secretNames: string[]
  /** The raw `mac` value, so an unchanged MAC set keeps its original spelling. */
  macRaw: UciValue | null
}

const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i
const LEASETIME = /^(\d+)([smhdw]?)$/i
const UNIT_SECONDS: Record<string, number> = {
  '': 1,
  's': 1,
  'm': 60,
  'h': 3600,
  'd': 86400,
  'w': 604800,
}

/** MACs of a `mac` value: a list, or whitespace-separated in a string. */
export function macsOf(value: UciValue | undefined): string[] {
  return itemsOf(value)
    .flatMap((item) => item.split(/\s+/))
    .filter((item) => item.length > 0)
    .map((item) => item.toLowerCase())
}

function scalar(options: UciOptions, key: string): string | null {
  const value = options[key]
  if (value === undefined) return null
  return Array.isArray(value) ? value.join(' ') : value
}

/** Lease time in seconds as text (`infinite` stays), or the input when unparseable. */
export function leaseSeconds(value: string): string {
  const text = value.trim().toLowerCase()
  if (text === 'infinite') return text
  const m = LEASETIME.exec(text)
  if (!m) return text
  return String(Number(m[1]) * UNIT_SECONDS[m[2].toLowerCase()])
}

function truthy(value: string): string {
  const text = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(text)) return '1'
  if (['0', 'false', 'no', 'off', 'disabled'].includes(text)) return '0'
  return text
}

/**
 * A reservation: at least one MAC, none a wildcard, and the other owned
 * options plain strings (a list there would not survive the round trip).
 */
function isReservation(options: UciOptions): boolean {
  const macs = macsOf(options.mac)
  if (macs.length === 0 || !macs.every((m) => MAC.test(m))) return false
  return ['ip', 'name', 'dns', 'leasetime'].every(
    (key) => options[key] === undefined || typeof options[key] === 'string'
  )
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0)
}

/** `192.168.1.1/24` → contains / router address checks. */
function inCidr(ip: string, cidr: string): { inside: boolean; router: boolean } {
  const [address, prefixText] = cidr.split('/')
  const prefix = Number(prefixText ?? 32)
  if (!IPV4.test(address) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return { inside: false, router: false }
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const inside = (ipv4ToInt(ip) & mask) >>> 0 === (ipv4ToInt(address) & mask) >>> 0
  return { inside, router: ip === address }
}

export const dhcpHostsDomain: ConfigDomain<DhcpReservation> = {
  key: 'dhcp_hosts',
  configs: ['dhcp'],
  types: ['host'],

  claims(section) {
    return section.config === 'dhcp' && section.type === 'host' && isReservation(section.options)
  },

  ownership() {
    return { kind: 'options', options: [...DHCP_HOST_OWNED_OPTIONS, ...DHCP_HOST_EXTRA_OWNED] }
  },

  normalize(type, option, value) {
    if (type !== 'host') return value
    switch (option) {
      case 'tag':
        return [...new Set(hostTags({ tag: value }))].sort()
      case 'mac':
        return [...new Set(macsOf(value))].sort()
      case 'leasetime':
        return typeof value === 'string' ? leaseSeconds(value) : value
      case 'dns':
        return typeof value === 'string' ? truthy(value) : value
      case 'ip':
      case 'name':
        return typeof value === 'string' ? value.trim().toLowerCase() : value
      default:
        return value
    }
  },

  identityKeys(section) {
    if (section.type !== 'host') return []
    const keys = macsOf(section.options.mac)
      .filter((m) => MAC.test(m))
      .map((m) => `mac:${m}`)
    const duid = scalar(section.options, 'duid')
    if (duid) keys.push(`duid:${duid.toLowerCase()}`)
    return keys
  },

  parse(sections) {
    return sections
      .filter((s) => s.config === 'dhcp' && s.type === 'host')
      .map((s) => {
        const extra: UciOptions = {}
        for (const [key, value] of Object.entries(s.options)) {
          if (!(DHCP_HOST_OWNED_OPTIONS as readonly string[]).includes(key)) {
            extra[key] = Array.isArray(value) ? [...value] : value
          }
        }
        const macRaw = s.options.mac ?? null
        return {
          perchId: s.perchId,
          section: s.name,
          macs: macsOf(s.options.mac),
          macForm: Array.isArray(macRaw) ? 'list' : 'string',
          ip: scalar(s.options, 'ip'),
          name: scalar(s.options, 'name'),
          dns: scalar(s.options, 'dns'),
          leasetime: scalar(s.options, 'leasetime'),
          extra,
          secretNames: Object.keys(s.secrets ?? {}),
          macRaw: macRaw === null ? null : Array.isArray(macRaw) ? [...macRaw] : macRaw,
        } satisfies DhcpReservation
      })
  },

  render(obj, current) {
    const existing = obj.perchId ? current.find((s) => s.perchId === obj.perchId) : undefined
    const options: UciOptions = { ...obj.extra }
    // An unchanged MAC list keeps the router's spelling (case, separators).
    const sameMacs =
      obj.macRaw !== null &&
      JSON.stringify(macsOf(obj.macRaw)) === JSON.stringify(obj.macs.map((m) => m.toLowerCase()))
    if (obj.macs.length > 0) {
      options.mac = sameMacs
        ? obj.macRaw!
        : obj.macForm === 'list'
          ? obj.macs.map((m) => m.toLowerCase())
          : obj.macs.map((m) => m.toLowerCase()).join(' ')
    }
    if (obj.ip !== null) options.ip = obj.ip
    if (obj.name !== null) options.name = obj.name
    if (obj.dns !== null) options.dns = obj.dns
    if (obj.leasetime !== null) options.leasetime = obj.leasetime
    const secrets: Record<string, SecretEdit> = {}
    for (const name of obj.secretNames) {
      if (existing?.secrets?.[name]) secrets[name] = { keep: true }
    }
    const edit: SectionEdit = {
      op: 'put',
      perchId: obj.perchId,
      config: 'dhcp',
      type: 'host',
      options,
      ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
    }
    return [edit]
  },

  validate(desired, ctx) {
    return validateReservations(desired, ctx)
  },
}

function validateReservations(desired: SyncedSection[], ctx: ValidationCtx): Issue[] {
  const issues: Issue[] = []
  const hosts = desired.filter((s) => s.config === 'dhcp' && s.type === 'host')
  const others = [
    ...ctx.all.filter(
      (s) => s.config === 'dhcp' && s.type === 'host' && !hosts.some((h) => h.perchId === s.perchId)
    ),
    ...(ctx.unmanaged ?? []).filter((s) => s.config === 'dhcp' && s.type === 'host'),
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
      option,
    })

  const macOwner = new Map<string, SyncedSection>()
  const ipOwner = new Map<string, SyncedSection>()
  const nameOwner = new Map<string, SyncedSection>()
  for (const s of others) {
    for (const mac of macsOf(s.options.mac)) macOwner.set(mac, s)
    const ip = scalar(s.options, 'ip')
    if (ip && ip !== 'ignore') ipOwner.set(ip, s)
    const name = scalar(s.options, 'name')
    if (name) nameOwner.set(name.toLowerCase(), s)
  }

  for (const s of hosts) {
    const macs = macsOf(s.options.mac)
    if (macs.length === 0)
      issue(s, 'error', 'mac_required', 'A reservation needs a MAC address', 'mac')
    for (const mac of macs) {
      if (!MAC.test(mac)) {
        issue(s, 'error', 'invalid_mac', `"${mac}" is not a MAC address`, 'mac')
        continue
      }
      const owner = macOwner.get(mac)
      if (owner && owner !== s) {
        issue(s, 'error', 'duplicate_mac', `${mac} is already reserved by ${owner.name}`, 'mac')
      }
      macOwner.set(mac, s)
    }

    const ip = scalar(s.options, 'ip')
    if (ip !== null && ip !== 'ignore') {
      if (!IPV4.test(ip)) {
        issue(s, 'error', 'invalid_ip', `"${ip}" is not an IPv4 address`, 'ip')
      } else {
        const owner = ipOwner.get(ip)
        if (owner && owner !== s) {
          issue(s, 'error', 'duplicate_ip', `${ip} is already reserved by ${owner.name}`, 'ip')
        }
        ipOwner.set(ip, s)
        if (ctx.networks && ctx.networks.length > 0) {
          const checks = ctx.networks.flatMap((n) => n.ipv4.map((cidr) => inCidr(ip, cidr)))
          if (checks.some((c) => c.router)) {
            issue(s, 'error', 'ip_is_router', `${ip} is the router's own address`, 'ip')
          } else if (!checks.some((c) => c.inside)) {
            issue(s, 'warning', 'ip_outside_networks', `${ip} is outside every LAN network`, 'ip')
          }
        }
      }
    }

    const name = scalar(s.options, 'name')
    if (name !== null) {
      if (!HOSTNAME.test(name)) {
        issue(s, 'error', 'invalid_name', `"${name}" is not a valid host name`, 'name')
      } else {
        const key = name.toLowerCase()
        const owner = nameOwner.get(key)
        if (owner && owner !== s) {
          issue(s, 'warning', 'duplicate_name', `${name} is also used by ${owner.name}`, 'name')
        }
        nameOwner.set(key, s)
      }
    }

    for (const tag of hostTags(s.options)) {
      if (!/^[A-Za-z0-9_]{1,32}$/.test(tag)) {
        issue(s, 'error', 'dhcp_tag_invalid', `"${tag}" is not a tag name`, 'tag')
      }
    }

    const leasetime = scalar(s.options, 'leasetime')
    if (
      leasetime !== null &&
      leasetime.toLowerCase() !== 'infinite' &&
      !LEASETIME.test(leasetime)
    ) {
      issue(s, 'error', 'invalid_leasetime', `"${leasetime}" is not a lease time`, 'leasetime')
    }
  }
  return issues
}
