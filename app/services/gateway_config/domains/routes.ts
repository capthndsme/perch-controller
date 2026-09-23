import type {
  ConfigDomain,
  FeatureSyncIssue,
  SyncedSection,
  ValidationCtx,
} from '#services/gateway_config/domain'
import {
  flagOf,
  flagValue,
  isIpAddress,
  netmaskBits,
  parsePrefix,
  parseVerbatim,
  prefixContains,
  renderVerbatim,
  scalarOption,
  scalarsOnly,
  type VerbatimSection,
} from '#services/gateway_config/domains/verbatim'
import type { Issue, ManagementPath, UciOptions } from '#services/gateway_config/types'

/**
 * Static routes (`network` config, `config route` / `config route6`; plan 2
 * section 4.4): observed and managed, two-way. Perch owns `interface target
 * netmask gateway metric table type disabled`; `mtu`, `onlink`, `source`
 * and anything newer ride along as the router's.
 *
 * Policy rules (`rule` / `rule6`), mwan3 and pbr are **observe only** (plan
 * 2 section 4.4; README decision 12): no domain claims them, so they stay
 * unmodeled: mirrored, shown on the routing page, never written, never
 * drift. Kernel routes, DHCP-learned defaults and mwan3's tables are
 * runtime state, never config.
 *
 * Identity (plan 2 section 4.4 (a)): the ledger, else `(family, interface,
 * target as a prefix, table)`. A route whose target contains the address
 * the agent reaches the controller at is on the management path (README
 * 3.8): it goes into a protected job with the longer confirm window, and the
 * REST layer refuses one that would take that path away
 * (`routing_controller_path`, `routeStealsPath`).
 */

export const ROUTES_DOMAIN_KEY = 'routes'
export const ROUTE_TYPES = ['route', 'route6'] as const
export const ROUTE_OWNED = [
  'interface',
  'target',
  'netmask',
  'gateway',
  'metric',
  'table',
  'type',
  'disabled',
] as const

/** Route types netifd takes; the ones that are not `unicast` drop what they match. */
export const ROUTE_KINDS = [
  'unicast',
  'local',
  'broadcast',
  'multicast',
  'unreachable',
  'prohibit',
  'blackhole',
  'anycast',
  'throw',
] as const
const DROPPING = new Set(['unreachable', 'prohibit', 'blackhole', 'throw'])

/** The main routing table's names. */
const MAIN_TABLES = new Set(['main', '254'])

export interface RouteFacts {
  family: 4 | 6
  interface: string | null
  /** `addr/len`, from `target` with `netmask` (IPv4) or a `/len` suffix. */
  prefix: { family: 4 | 6; address: string; prefix: number } | null
  gateway: string | null
  metric: number | null
  table: string | null
  kind: string
  enabled: boolean
}

/** Reads a route section (desired or router content). */
export function routeFacts(type: string, options: UciOptions): RouteFacts {
  const family: 4 | 6 = type === 'route6' ? 6 : 4
  const target = scalarOption(options, 'target')
  let prefix = target ? parsePrefix(target) : null
  if (prefix && family === 4 && !target!.includes('/')) {
    const mask = scalarOption(options, 'netmask')
    const bits = mask ? netmaskBits(mask) : 32
    prefix = bits === null ? null : { ...prefix, prefix: bits }
  }
  if (prefix && prefix.family !== family) prefix = null
  const metric = scalarOption(options, 'metric')
  return {
    family,
    interface: scalarOption(options, 'interface'),
    prefix,
    gateway: scalarOption(options, 'gateway'),
    metric: metric !== null && /^\d+$/.test(metric) ? Number(metric) : null,
    table: scalarOption(options, 'table'),
    kind: (scalarOption(options, 'type') ?? 'unicast').toLowerCase(),
    enabled: !flagOf(options, 'disabled', false),
  }
}

export function prefixText(prefix: RouteFacts['prefix']): string | null {
  return prefix ? `${prefix.address.toLowerCase()}/${prefix.prefix}` : null
}

function inMainTable(facts: RouteFacts): boolean {
  return facts.table === null || MAIN_TABLES.has(facts.table.toLowerCase())
}

/**
 * Would this route take the controller's traffic away from the management
 * path (README 3.8; plan 2 section 4.4 "unless `ip route get` would stay the
 * same device")? `pathPrefix` = the prefix length of the route the path
 * uses today (the management network's subnet when the controller is on it,
 * else the longest enabled route on the path's network covering it, else 0:
 * the default route). A route in the main table that covers the controller
 * address steals the path when it is at least as specific and leaves by
 * another network, or drops the traffic (`unreachable`, `blackhole`, …).
 */
export function routeStealsPath(
  facts: RouteFacts,
  path: { network: string | null; controllerAddress: string; pathPrefix: number }
): boolean {
  if (!facts.enabled || !facts.prefix || !inMainTable(facts)) return false
  if (!prefixContains(facts.prefix, path.controllerAddress)) return false
  if (DROPPING.has(facts.kind)) return true
  if (facts.interface !== null && facts.interface === path.network) return false
  return facts.prefix.prefix >= path.pathPrefix
}

export const routesDomain: ConfigDomain<VerbatimSection> = {
  key: ROUTES_DOMAIN_KEY,
  configs: ['network'],
  types: [...ROUTE_TYPES],

  claims(section) {
    return (
      section.config === 'network' &&
      (ROUTE_TYPES as readonly string[]).includes(section.type) &&
      typeof section.options.target === 'string' &&
      scalarsOnly(section.options, ROUTE_OWNED)
    )
  },

  ownership() {
    return { kind: 'options', options: [...ROUTE_OWNED] }
  },

  normalize(type, option, value) {
    if (!(ROUTE_TYPES as readonly string[]).includes(type) || typeof value !== 'string') {
      return value
    }
    switch (option) {
      case 'disabled':
        return flagValue(value)
      case 'metric':
        return /^\s*\d+\s*$/.test(value) ? String(Number(value)) : value
      case 'target':
      case 'gateway':
        return value.trim().toLowerCase()
      case 'type':
        return value.trim().toLowerCase()
      default:
        return value
    }
  },

  identityKeys(section) {
    if (!(ROUTE_TYPES as readonly string[]).includes(section.type)) return []
    const facts = routeFacts(section.type, section.options)
    const target = prefixText(facts.prefix)
    if (!target) return []
    return [
      `route${facts.family}:${facts.interface ?? ''}|${target}|${facts.table ?? 'main'}|${facts.kind}`,
    ]
  },

  touchesManagement(section, path) {
    if (!(ROUTE_TYPES as readonly string[]).includes(section.type)) return false
    if (!path.controllerAddress || !isIpAddress(path.controllerAddress)) return false
    const facts = routeFacts(section.type, section.options)
    return facts.prefix !== null && prefixContains(facts.prefix, path.controllerAddress)
  },

  parse(sections) {
    return parseVerbatim(sections, 'network', ROUTE_TYPES)
  },

  render(obj, current) {
    return renderVerbatim(obj, current, 'network')
  },

  validate(desired, ctx) {
    return validateRoutes(desired, ctx)
  },

  inSync(sections, observed) {
    const issues: FeatureSyncIssue[] = []
    if (!observed.interfaces) return issues
    const known = new Set(observed.interfaces.map((i) => i.network))
    for (const s of sections) {
      if (s.scope !== 'synced') continue
      const facts = routeFacts(s.type, s.options)
      if (!facts.enabled || facts.interface === null) continue
      if (!known.has(facts.interface)) {
        issues.push({
          feature: ROUTES_DOMAIN_KEY,
          objectId: s.perchId,
          code: 'route_interface_missing',
          message: `Route ${prefixText(facts.prefix) ?? s.name}: the router has no interface "${facts.interface}" up in netifd.`,
        })
      }
    }
    return issues
  },
}

/** Interface section names of the `network` config (desired or mirrored). */
function interfaceNames(ctx: ValidationCtx): Set<string> {
  const out = new Set<string>()
  for (const s of [...ctx.all, ...(ctx.unmanaged ?? [])]) {
    if (s.config === 'network' && s.type === 'interface') out.add(s.name)
  }
  return out
}

/** The prefix length of the route the management path uses today (see `routeStealsPath`). */
export function managementPathPrefix(
  path: ManagementPath,
  networks: Array<{ name: string; ipv4: string[] }>,
  routes: RouteFacts[]
): number {
  const address = path.controllerAddress
  if (!address) return 0
  let best = 0
  const network = networks.find((n) => n.name === path.network)
  for (const cidr of network?.ipv4 ?? []) {
    const p = parsePrefix(cidr)
    if (p && prefixContains(p, address)) best = Math.max(best, p.prefix)
  }
  for (const r of routes) {
    if (
      r.enabled &&
      r.prefix &&
      r.interface === path.network &&
      inMainTable(r) &&
      !DROPPING.has(r.kind) &&
      prefixContains(r.prefix, address)
    ) {
      best = Math.max(best, r.prefix.prefix)
    }
  }
  return best
}

function validateRoutes(desired: SyncedSection[], ctx: ValidationCtx): Issue[] {
  const issues: Issue[] = []
  const interfaces = interfaceNames(ctx)
  const seen = new Map<string, SyncedSection>()
  const others = [...ctx.all, ...(ctx.unmanaged ?? [])].filter(
    (s) =>
      s.config === 'network' &&
      (ROUTE_TYPES as readonly string[]).includes(s.type) &&
      !desired.some((d) => d.perchId !== null && d.perchId === s.perchId)
  )
  for (const s of others) {
    for (const key of routesDomain.identityKeys!(s)) seen.set(key, s)
  }
  const path = ctx.managementPath
  const allRoutes = [...others, ...desired]
    .filter((s) => (ROUTE_TYPES as readonly string[]).includes(s.type))
    .map((s) => routeFacts(s.type, s.options))
  const pathPrefix =
    path?.controllerAddress && isIpAddress(path.controllerAddress)
      ? managementPathPrefix(path, ctx.networks ?? [], allRoutes)
      : null

  for (const s of desired) {
    if (s.config !== 'network' || !(ROUTE_TYPES as readonly string[]).includes(s.type)) continue
    const issue = (severity: Issue['severity'], code: string, message: string, option?: string) =>
      issues.push({
        severity,
        code,
        message,
        perchId: s.perchId,
        config: 'network',
        section: s.name,
        ...(option ? { option } : {}),
      })
    const facts = routeFacts(s.type, s.options)
    if (!facts.prefix) {
      issue(
        'error',
        'routing_target_invalid',
        `"${scalarOption(s.options, 'target')}" is not a ${facts.family === 6 ? 'IPv6' : 'IPv4'} prefix`,
        'target'
      )
      continue
    }
    if (facts.gateway !== null) {
      const ok =
        facts.gateway === '0.0.0.0' ||
        (isIpAddress(facts.gateway) && parsePrefix(facts.gateway)!.family === facts.family)
      if (!ok)
        issue(
          'error',
          'routing_gateway_invalid',
          `"${facts.gateway}" is not an IPv${facts.family} address`,
          'gateway'
        )
    }
    const metric = scalarOption(s.options, 'metric')
    if (metric !== null && !/^\d{1,10}$/.test(metric)) {
      issue('error', 'routing_metric_invalid', `"${metric}" is not a metric`, 'metric')
    }
    if (!(ROUTE_KINDS as readonly string[]).includes(facts.kind)) {
      issue('error', 'routing_type_invalid', `"${facts.kind}" is not a route type`, 'type')
    }
    if (facts.table !== null && !/^[A-Za-z0-9_-]{1,32}$/.test(facts.table)) {
      issue('error', 'routing_table_invalid', `"${facts.table}" is not a routing table`, 'table')
    }
    if (facts.interface === null) {
      if (!DROPPING.has(facts.kind)) {
        issue('error', 'routing_interface_required', 'A route needs its interface', 'interface')
      }
    } else if (interfaces.size > 0 && !interfaces.has(facts.interface)) {
      issue('error', 'routing_interface_unknown', `No interface "${facts.interface}"`, 'interface')
    }
    for (const key of routesDomain.identityKeys!(s)) {
      const twin = seen.get(key)
      if (twin && twin !== s) {
        issue('error', 'duplicate_route', `Same route as ${twin.name}`, 'target')
      }
      seen.set(key, s)
    }
    if (
      path?.controllerAddress &&
      pathPrefix !== null &&
      routeStealsPath(facts, {
        network: path.network,
        controllerAddress: path.controllerAddress,
        pathPrefix,
      })
    ) {
      issue(
        'warning',
        'routing_controller_path',
        `The route covers the controller (${path.controllerAddress}) and leaves by another way`,
        'target'
      )
    }
  }
  return issues
}
