import type {
  AuthoritativePolicy,
  ConfigDomain,
  FeatureSyncIssue,
  SyncedSection,
} from '#services/gateway_config/domain'
import {
  flagOf,
  flagValue,
  parsePrefix,
  parseVerbatim,
  prefixContains,
  renderVerbatim,
  scalarOption,
  type VerbatimSection,
} from '#services/gateway_config/domains/verbatim'
import { itemsOf } from '#services/gateway_config/canonical'
import {
  GENERATED_FINGERPRINT_PREFIX,
  hasFeature,
  type GatewayCapabilities,
  type Issue,
  type SectionContent,
  type UciOptions,
} from '#services/gateway_config/types'

/**
 * Gateway sync: WireGuard interfaces and their peers (docs/design/gateway-sync/
 * domains.md 4). An `interface` with proto `wireguard` is Perch's whole, its
 * `private_key` a secret: generated on the router for an interface created
 * here (`$generate`, protocol.md 2), the router's own for an imported one
 * (`$keep`), or a provider's key an admin pasted (a controller-set secret,
 * TLS only). Its peers are the `wireguard_<interface>` sections, whole, with
 * `preshared_key` secret and `public_key` plain (the kit's K1 stopped
 * redacting it; `requires` checks the agent says so).
 *
 * After a job that generated a key, the router's next read carries the real
 * fingerprint in place of the `gen:` placeholder: that row imports it even
 * under Authoritative Mode (`authoritative`), so Perch never "reverts" the key
 * by generating another.
 */

export const WIREGUARD_KEY = 'wireguard'
export const WIREGUARD_PACKAGES = ['wireguard-tools', 'kmod-wireguard']
const PEER_PREFIX = 'wireguard_'

const FLAG_OPTIONS = new Set([
  'route_allowed_ips',
  'nohostroute',
  'defaultroute',
  'delegate',
  'disabled',
])

/** Base64 of 32 bytes: a WireGuard key. */
export function isWgKey(value: string | null): boolean {
  if (!value || !/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(value.trim())) return false
  return Buffer.from(value.trim(), 'base64').length === 32
}

export function peerTypeOf(iface: string): string {
  return `${PEER_PREFIX}${iface}`
}

export function interfaceOfPeerType(type: string): string | null {
  return type.startsWith(PEER_PREFIX) ? type.slice(PEER_PREFIX.length) : null
}

function isWgInterface(type: string, options: UciOptions): boolean {
  return type === 'interface' && scalarOption(options, 'proto') === 'wireguard'
}

/** `addr/len` items of a list option (`allowed_ips`, `addresses`), parsed; bad items are null. */
export function prefixesOf(value: UciOptions[string] | undefined) {
  return itemsOf(value)
    .flatMap((v) => v.split(/\s+/))
    .filter(Boolean)
    .map((text) => ({ text, prefix: parsePrefix(text) }))
}

export function prefixesOverlap(
  a: { family: 4 | 6; address: string; prefix: number },
  b: { family: 4 | 6; address: string; prefix: number }
): boolean {
  if (a.family !== b.family) return false
  const [outer, inner] = a.prefix <= b.prefix ? [a, b] : [b, a]
  return prefixContains(outer, inner.address)
}

/** `server` (listens, no peer with an endpoint), `client` (peers with endpoints, no port), `site` (both). */
export function roleOf(iface: UciOptions, peers: UciOptions[]): 'server' | 'client' | 'site' {
  const listens = scalarOption(iface, 'listen_port') !== null
  const dials = peers.some((p) => scalarOption(p, 'endpoint_host') !== null)
  if (listens && dials) return 'site'
  return dials ? 'client' : 'server'
}

export const wireguardDomain: ConfigDomain<VerbatimSection> = {
  key: WIREGUARD_KEY,
  configs: ['network'],
  types: ['interface', 'wireguard_*'],
  listSemantics: { 'interface.addresses': 'set', 'wireguard_*.allowed_ips': 'set' },
  secretOptions: ['private_key', 'preshared_key'],

  requires(caps: GatewayCapabilities): string | null {
    if (!hasFeature(caps, 'config.plain_public_key')) {
      return 'The gateway agent redacts WireGuard public keys (update it)'
    }
    return null
  },

  claims(section, all) {
    if (section.config !== 'network') return false
    if (isWgInterface(section.type, section.options)) return true
    const iface = interfaceOfPeerType(section.type)
    if (!iface) return false
    return (all.network?.sections ?? []).some(
      (s) => s.name === iface && isWgInterface(s.type, s.options)
    )
  },

  normalize(_type, option, value) {
    if (typeof value !== 'string') return value
    if (FLAG_OPTIONS.has(option)) return flagValue(value)
    return value
  },

  identityKeys(section) {
    const iface = interfaceOfPeerType(section.type)
    const key = scalarOption(section.options, 'public_key')?.trim()
    return iface && key ? [`wgpeer:${iface}:${key}`] : []
  },

  touchesManagement(section, path) {
    if (section.type === 'interface') return path.network === section.name
    const iface = interfaceOfPeerType(section.type)
    if (!iface) return false
    if (path.network === iface) return true
    // A peer whose routed prefixes cover the controller carries the path.
    if (!path.controllerAddress || !flagOf(section.options, 'route_allowed_ips', false)) {
      return false
    }
    return prefixesOf(section.options.allowed_ips).some(
      (p) => p.prefix && prefixContains(p.prefix, path.controllerAddress!)
    )
  },

  authoritative(_settings, row): AuthoritativePolicy {
    // The router's first read after a generated key: import its fingerprint.
    const slot = row.base?.secrets?.private_key
    return slot?.fingerprint.startsWith(GENERATED_FINGERPRINT_PREFIX) ? 'import' : 'follow'
  },

  parse(sections) {
    return parseVerbatim(
      sections,
      'network',
      [...new Set(sections.map((s) => s.type))].filter(
        (t) => t === 'interface' || t.startsWith(PEER_PREFIX)
      )
    ).filter((s) => s.type !== 'interface' || isWgInterface(s.type, s.options))
  },

  render(obj, current) {
    return renderVerbatim(obj, current, 'network')
  },

  validate(desired, ctx) {
    return validateWireguard(desired, [...ctx.all, ...(ctx.unmanaged ?? [])], ctx)
  },

  inSync(sections, observed) {
    const out: FeatureSyncIssue[] = []
    const live = observed.wireguard
    const netifd = observed.interfaces
    for (const s of sections) {
      if (s.scope !== 'synced') continue
      if (isWgInterface(s.type, s.options)) {
        if (
          netifd &&
          !flagOf(s.options, 'disabled', false) &&
          !netifd.some((i) => i.network === s.name)
        ) {
          out.push({
            feature: WIREGUARD_KEY,
            objectId: s.perchId,
            code: 'wg_interface_missing',
            message: `The WireGuard interface ${s.name} is not up on the router.`,
          })
        }
        continue
      }
      const iface = interfaceOfPeerType(s.type)
      if (!iface || !live || flagOf(s.options, 'disabled', false)) continue
      const key = scalarOption(s.options, 'public_key')?.trim()
      const loaded = live.interfaces.find((i) => i.network === iface || i.name === iface)
      if (key && loaded && !loaded.peers.includes(key)) {
        out.push({
          feature: WIREGUARD_KEY,
          objectId: s.perchId,
          code: 'wg_peer_not_loaded',
          message: `A peer of ${iface} is not loaded on the router.`,
        })
      }
    }
    return out
  },
}

function lanWanPrefixes(all: SyncedSection[]) {
  const out: Array<{ network: string; prefix: NonNullable<ReturnType<typeof parsePrefix>> }> = []
  for (const s of all) {
    if (s.config !== 'network' || s.type !== 'interface') continue
    if (isWgInterface(s.type, s.options)) continue
    const mask = scalarOption(s.options, 'netmask')
    for (const raw of itemsOf(s.options.ipaddr)
      .flatMap((v) => v.split(/\s+/))
      .filter(Boolean)) {
      const bits = mask ? maskBits(mask) : null
      const p = parsePrefix(raw.includes('/') ? raw : `${raw}/${bits ?? 32}`)
      if (p) out.push({ network: s.name, prefix: p })
    }
  }
  return out
}

function maskBits(mask: string): number | null {
  const parts = mask.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null
  const n = parts.reduce((acc, p) => acc * 256 + p, 0) >>> 0
  let bits = 0
  while (bits < 32 && (n & (0x80000000 >>> bits)) !== 0) bits++
  return bits
}

function validateWireguard(
  desired: SyncedSection[],
  everything: SyncedSection[],
  ctx: Parameters<ConfigDomain['validate']>[1]
): Issue[] {
  const issues: Issue[] = []
  const interfaces = desired.filter(
    (s) => s.config === 'network' && isWgInterface(s.type, s.options)
  )
  const peers = desired.filter((s) => s.config === 'network' && interfaceOfPeerType(s.type))
  const others = lanWanPrefixes(everything)
  const ports = new Map<string, string>()
  const zones = everything.filter((s) => s.config === 'firewall' && s.type === 'zone')

  for (const s of interfaces) {
    const at = { perchId: s.perchId, config: 'network', section: s.name }
    const port = scalarOption(s.options, 'listen_port')
    if (port !== null) {
      const n = /^\d{1,5}$/.test(port) ? Number(port) : Number.NaN
      if (!(n >= 1 && n <= 65535)) {
        issues.push({
          severity: 'error',
          code: 'wg_port_invalid',
          message: 'The listen port is 1–65535.',
          ...at,
          option: 'listen_port',
        })
      } else if (ports.has(port)) {
        issues.push({
          severity: 'error',
          code: 'wg_port_in_use',
          message: `Port ${port} is already the listen port of ${ports.get(port)}.`,
          ...at,
          option: 'listen_port',
        })
      } else {
        ports.set(port, s.name)
      }
    }
    for (const a of prefixesOf(s.options.addresses)) {
      if (!a.prefix) {
        issues.push({
          severity: 'error',
          code: 'wg_address_invalid',
          message: `"${a.text}" is not an address with a prefix length.`,
          ...at,
          option: 'addresses',
        })
        continue
      }
      const clash = others.find((o) => prefixesOverlap(o.prefix, a.prefix!))
      if (clash) {
        issues.push({
          severity: 'error',
          code: 'wg_subnet_overlap',
          message: `${a.text} overlaps the subnet of ${clash.network}.`,
          ...at,
          option: 'addresses',
        })
      }
    }
    const inZone = zones.some((z) =>
      itemsOf(z.options.network)
        .flatMap((v) => v.split(/\s+/))
        .includes(s.name)
    )
    if (zones.length > 0 && !inZone) {
      issues.push({
        severity: 'warning',
        code: 'wg_no_zone',
        message: `${s.name} is in no firewall zone: the router drops its traffic by default policy.`,
        ...at,
      })
    }
  }

  const byInterface = new Map<
    string,
    Array<{
      peer: SyncedSection
      prefix: NonNullable<ReturnType<typeof parsePrefix>>
      text: string
    }>
  >()
  for (const s of peers) {
    const at = { perchId: s.perchId, config: 'network', section: s.name }
    const iface = interfaceOfPeerType(s.type)!
    if (!isWgKey(scalarOption(s.options, 'public_key'))) {
      issues.push({
        severity: 'error',
        code: 'wg_public_key_invalid',
        message: 'A public key is 44 characters of base64 (32 bytes).',
        ...at,
        option: 'public_key',
      })
    }
    const routed = flagOf(s.options, 'route_allowed_ips', false)
    const list = byInterface.get(iface) ?? []
    for (const a of prefixesOf(s.options.allowed_ips)) {
      if (!a.prefix) {
        issues.push({
          severity: 'error',
          code: 'wg_allowed_ips_invalid',
          message: `"${a.text}" is not an address or prefix.`,
          ...at,
          option: 'allowed_ips',
        })
        continue
      }
      const shared = list.find((x) => x.peer !== s && prefixesOverlap(x.prefix, a.prefix!))
      if (shared) {
        issues.push({
          severity: 'error',
          code: 'wg_allowed_ips_overlap',
          message: `${a.text} overlaps ${shared.text} of another peer of ${iface}.`,
          ...at,
          option: 'allowed_ips',
        })
      }
      list.push({ peer: s, prefix: a.prefix, text: a.text })
      if (routed && a.prefix.prefix === 0) {
        issues.push({
          severity: 'warning',
          code: 'wg_default_route',
          message: 'This peer routes all traffic through the tunnel.',
          ...at,
          option: 'allowed_ips',
        })
      }
      const path = ctx.managementPath
      if (
        routed &&
        path?.controllerAddress &&
        path.network !== iface &&
        a.prefix.prefix > 0 &&
        prefixContains(a.prefix, path.controllerAddress)
      ) {
        issues.push({
          severity: 'error',
          code: 'wg_route_steals_path',
          message: `${a.text} would route the controller's address into the tunnel and cut the router off from Perch.`,
          ...at,
          option: 'allowed_ips',
        })
      }
    }
    byInterface.set(iface, list)
  }
  return issues
}

/** The public key a generated or pasted private key has, when the router told us (for views). */
export function generatedSlot(content: SectionContent | null): boolean {
  return Boolean(content?.secrets?.private_key?.generate)
}
