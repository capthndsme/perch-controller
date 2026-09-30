import Collector from '#models/collector'
import type Gateway from '#models/gateway'
import GatewaySecret from '#models/gateway_secret'
import GatewayWan, { type WanRole } from '#models/gateway_wan'
import { requestApply, validateStates } from '#services/gateway_config/apply_lifecycle'
import type { SectionEdit, SecretEdit } from '#services/gateway_config/domain'
import { domainRegistry } from '#services/gateway_config/domains/index'
import { interfaceCidrs, parseCidr } from '#services/gateway_config/domains/networks'
import { protoOf, uciDeviceOf } from '#services/gateway_config/domains/side'
import {
  cloneOptions,
  flagValue,
  isIpv4Address,
  scalarOption,
  wordsOf,
} from '#services/gateway_config/domains/verbatim'
import {
  cidrListsOverlap,
  interfaceEnabled,
  MOBILE_PROTOS,
  primaryUplink,
  WAN_KEY,
  wanTopology,
  type WanLink,
  type WanTopology,
} from '#services/gateway_config/domains/wan'
import { GatewayPlaneError, planeError } from '#services/gateway_config/errors'
import {
  editDomainSections,
  findGateway,
  type DomainEditBatch,
} from '#services/gateway_config/gateway_config_service'
import { getGatewayConfigSettings } from '#services/gateway_config/gateway_config_settings'
import { normalizeMode, writeAccess } from '#services/gateway_config/gateway_registry'
import { loadSections } from '#services/gateway_config/gateway_store'
import {
  getGatewaySyncSettings,
  type GatewaySyncSettings,
} from '#services/gateway_config/gateway_sync_settings'
import {
  latestTransitions,
  transitionsBetween,
  type WanTransitionView,
} from '#services/gateway_config/gateway_wan_transitions'
import {
  contentOf,
  gatewayDisplayName,
  syncOf,
  type SyncInfo,
} from '#services/gateway_config/native_common'
import {
  readObservedFacts,
  readSideFacts,
  type ObservedFacts,
} from '#services/gateway_config/observed_facts'
import { controllerSecretSlot, newSecretRef } from '#services/gateway_config/secrets'
import type { SectionState } from '#services/gateway_config/sync_engine'
import {
  hasFeature,
  type Issue,
  type SectionContent,
  type UciConfigSet,
  type UciOptions,
  type UciValue,
} from '#services/gateway_config/types'
import { DateTime } from 'luxon'
import { isIP } from 'node:net'

/**
 * The WAN REST layer (docs/design/gateway-sync/rest.md 3, domains.md 3):
 * uplinks with their companions, aliases, port and pool as one object, the
 * failover order, NAT links, the Perch-only metadata (`gateway_wans`) and the
 * transition history. Every UCI write goes into the draft through
 * `editDomainSections` and, unless `?apply=0`, into an apply of exactly the
 * touched sections, which the planner makes a **checked** job (the router
 * verifies the internet and rolls back early when it cannot).
 *
 * Guards before anything is written (domains.md 3.5):
 * - `wan_last_uplink` (409): the edit leaves no enabled uplink with a default
 *   route. With the gateway's name in `confirm` it goes out with explicit
 *   empty checks (the router could never pass them) and a note.
 * - `wan_management_path` (409, refused outright): disabling, deleting or
 *   changing the proto of an uplink the management path runs on when the
 *   controller is reached over a WAN (a remote controller).
 * - `wan_admin_outside` (warning): the request comes from outside every LAN
 *   subnet (the admin may lose the dashboard with the WAN).
 */

// ── views (rest.md 3) ─────────────────────────────────────────────────────

export type SecretState = { set: boolean; owner: 'router' | 'controller' | null }
export type Extra = Record<string, string | string[]>

export type WanAliasView = {
  id: string
  network: string
  addresses: string[]
  zone: string | null
  extra: Extra
  sync: SyncInfo
}

export type WanView = {
  id: string
  network: string
  label: string
  role: WanRole
  failoverRank: number | null
  proto: string
  editable: 'full' | 'limited'
  device: string | null
  enabled: boolean
  metric: number | null
  defaultRoute: boolean
  dns: { useProvider: boolean; servers: string[] }
  static: { addresses: string[]; gateway: string | null; broadcast: string | null } | null
  pppoe: {
    username: string | null
    password: SecretState
    service: string | null
    ac: string | null
    keepalive: string | null
  } | null
  dhcp: { hostname: string | null; clientId: string | null; vendorId: string | null } | null
  mobile: { apn: string | null; pincode: SecretState; device: string | null } | null
  mtu: number | null
  mac: {
    effective: string | null
    source: 'device' | 'interface' | null
    deviceSection: string | null
    ignoredInterfaceMac: boolean
  }
  ipv6: {
    mode: 'off' | 'auto' | 'dhcpv6' | 'relay' | 'static'
    companion: string | null
    reqAddress: string | null
    reqPrefix: string | null
    ip6prefix: string[]
    delegate: boolean | null
  }
  aliases: WanAliasView[]
  pool: {
    perchId: string
    ignore: boolean
    ra: string | null
    dhcpv6: string | null
    ndp: string | null
    master: boolean
  } | null
  zone: string | null
  zoneMasq: boolean
  sqm: { queue: string; interface: string; enabled: boolean; mismatch: boolean } | null
  management: boolean
  live: {
    up: boolean
    ipv4: string[]
    ipv6: string[]
    gateway4: string | null
    gateway6: string | null
    defaultRouteActive: boolean
    uptimeSeconds: number | null
    error: string | null
    ipv6Prefixes: Array<{
      prefix: string
      preferredUntil: string | null
      validUntil: string | null
    }>
    mwan3Status: string | null
    observedAt: string
  } | null
  sections: string[]
  sync: SyncInfo
  extra: Extra
  issues: Issue[]
  meta: {
    label: string
    checkTargets: string[] | null
    note: string | null
    roleOverride: WanRole | null
  }
}

export type WanOverview = {
  gatewayId: number
  available: boolean
  unavailableReason: 'capability_missing' | 'router_access' | 'not_managed' | null
  uplinks: WanView[]
  natLinks: WanView[]
  failover: { mode: 'metric' | 'mwan3'; order: string[] }
  managementPath: { network: string | null; wanSide: boolean }
  adminOutside: boolean
  checks: { targets: string[]; resolveName: string | null; confirmTimeoutSeconds: number }
  transitions: WanTransitionView[]
  observedAt: string | null
}

export type WanPatch = {
  label?: string
  enabled?: boolean
  proto?: 'dhcp' | 'static' | 'pppoe'
  metric?: number
  defaultRoute?: boolean
  dns?: { useProvider: boolean; servers: string[] }
  static?: { addresses: string[]; gateway: string | null; broadcast?: string | null }
  pppoe?: {
    username?: string
    password?: string | null
    service?: string | null
    ac?: string | null
    keepalive?: string | null
  }
  dhcp?: { hostname?: string | null; clientId?: string | null; vendorId?: string | null }
  mobile?: { apn?: string | null; pincode?: string | null }
  mtu?: number | null
  mac?: string | null
  ipv6?: {
    mode: 'off' | 'auto' | 'dhcpv6' | 'relay'
    reqAddress?: 'try' | 'force' | 'none'
    reqPrefix?: 'auto' | 'no' | number
  }
  moveSqm?: boolean
  checkTargets?: string[] | null
  confirm?: string
}

export type WanCreate = WanPatch & {
  network: string
  device: string
  proto: 'dhcp' | 'static' | 'pppoe'
  zone?: string | null
  createZone?: boolean
}

export type WanWriteResult<T> = {
  gatewayId: number
  object: T | null
  issues: Issue[]
  apply: unknown | null
  applyError: { error: string; message: string } | null
}

type RequestInfo = { apply: boolean; requestIp?: string | null }

// ── loading ──────────────────────────────────────────────────────────────

type WanContext = {
  gateway: Gateway
  states: SectionState[]
  /** The configs as Perch will have them: C for synced rows, R for mirrors. */
  all: UciConfigSet
  topology: WanTopology
  facts: ObservedFacts
  settings: GatewaySyncSettings
  metas: Map<string, GatewayWan>
}

/** A config set of the rows' current content (a draft delete still shows until applied). */
function currentConfigSet(states: SectionState[]): UciConfigSet {
  const out: UciConfigSet = {}
  const sorted = [...states].sort(
    (a, b) =>
      a.config.localeCompare(b.config) ||
      (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) ||
      a.perchId.localeCompare(b.perchId)
  )
  for (const s of sorted) {
    const c = contentOf(s) ?? s.router
    if (!c) continue
    const config = (out[s.config] ??= { name: s.config, hash: '', sections: [] })
    config.sections.push({
      name: s.name,
      type: c.type,
      anonymous: s.anonymous,
      index: config.sections.length,
      options: c.options,
    })
  }
  return out
}

async function loadWan(gatewayId: number): Promise<WanContext> {
  const gateway = await findGateway(gatewayId)
  const { states } = await loadSections(gateway.id)
  const facts = await readObservedFacts(gateway.collectorId)
  const sideFacts = await readSideFacts(gateway.collectorId, facts)
  const metaRows = await GatewayWan.query().where('gateway_id', gateway.id)
  const metas = new Map(metaRows.map((m) => [m.network, m]))
  const roles: Record<string, WanRole> = {}
  for (const [network, meta] of metas) {
    if (meta.roleOverride === 'internet' || meta.roleOverride === 'nat_link') {
      roles[network] = meta.roleOverride
    }
  }
  const all = currentConfigSet(states)
  return {
    gateway,
    states,
    all,
    topology: wanTopology(all, { facts: sideFacts, roles }),
    facts,
    settings: await getGatewaySyncSettings(),
    metas,
  }
}

function rowOf(ctx: WanContext, config: string, name: string): SectionState | null {
  return ctx.states.find((s) => s.config === config && s.name === name) ?? null
}

function interfaceRow(ctx: WanContext, network: string): SectionState {
  const row = rowOf(ctx, 'network', network)
  if (!row) throw planeError(404, 'wan_not_found', `No WAN ${network}.`)
  return row
}

function optionsOf(row: SectionState | null): UciOptions {
  return row ? cloneOptions((contentOf(row) ?? row.router)?.options ?? {}) : {}
}

const STATUS_WEIGHT: Record<string, number> = {
  conflict: 5,
  drift: 4,
  reverting: 3,
  pending: 2,
  ahead: 1,
  in_sync: 0,
}

/** The worst sync info of a set of rows (the interface's when equal). */
function worstSync(rows: SectionState[]): SyncInfo {
  const sorted = [...rows].sort(
    (a, b) => (STATUS_WEIGHT[b.status] ?? 0) - (STATUS_WEIGHT[a.status] ?? 0)
  )
  const worst = sorted[0]
  const info = syncOf(worst)
  if (rows.some((r) => r.scope !== 'synced')) {
    const mirror = rows.find((r) => r.scope !== 'synced')!
    return { ...info, scope: mirror.scope, owner: 'router', issue: mirror.issue }
  }
  return info
}

function secretState(row: SectionState | null, option: string): SecretState {
  const c = row ? (contentOf(row) ?? row.router) : null
  const slot = c?.secrets?.[option]
  if (!slot) return { set: false, owner: null }
  return { set: true, owner: slot.ref ? 'controller' : 'router' }
}

const MODELED_INTERFACE = new Set([
  'proto',
  'device',
  'ifname',
  'metric',
  'disabled',
  'auto',
  'defaultroute',
  'peerdns',
  'dns',
  'ipaddr',
  'netmask',
  'gateway',
  'broadcast',
  'username',
  'service',
  'ac',
  'keepalive',
  'hostname',
  'clientid',
  'vendorid',
  'apn',
  'mtu',
  'macaddr',
  'ipv6',
  'delegate',
])

function extraOf(options: UciOptions, modeled: Set<string>): Extra {
  const out: Extra = {}
  for (const [k, v] of Object.entries(options)) {
    if (!modeled.has(k)) out[k] = Array.isArray(v) ? [...v] : v
  }
  return out
}

function zoneOf(ctx: WanContext, network: string): { name: string; masq: boolean } | null {
  for (const z of ctx.all.firewall?.sections ?? []) {
    if (z.type !== 'zone' || !wordsOf(z.options.network).includes(network)) continue
    const masq = scalarOption(z.options, 'masq')
    return {
      name: scalarOption(z.options, 'name') ?? z.name,
      masq: masq !== null && flagValue(masq) === '1',
    }
  }
  return null
}

function flag(options: UciOptions, key: string): string | null {
  const v = scalarOption(options, key)
  return v === null ? null : flagValue(v)
}

function managementOf(ctx: WanContext, link: WanLink): boolean {
  const path = ctx.gateway.managementPath
  if (!path) return false
  if (path.network === link.network) return true
  const live = ctx.facts.interfaces?.find((i) => i.network === link.network)?.device ?? null
  if (path.device === link.device || (live !== null && path.device === live)) return true
  return pathWanSide(ctx) && link.role === 'internet'
}

/** Is the controller reached over a WAN (domains.md 3.6)? */
function pathWanSide(ctx: WanContext): boolean {
  const path = ctx.gateway.managementPath
  if (!path) return false
  if (path.network !== null) return ctx.topology.sides.get(path.network) === 'wan'
  return ctx.topology.uplinks.some((u) => u.device === path.device)
}

function aliasView(ctx: WanContext, network: string): WanAliasView | null {
  const row = rowOf(ctx, 'network', network)
  if (!row) return null
  const o = optionsOf(row)
  return {
    id: row.perchId,
    network,
    addresses: interfaceCidrs(o),
    zone: zoneOf(ctx, network)?.name ?? null,
    extra: extraOf(o, new Set(['proto', 'device', 'ipaddr', 'netmask'])),
    sync: syncOf(row),
  }
}

function linkView(ctx: WanContext, link: WanLink, issues: Issue[]): WanView {
  const row = interfaceRow(ctx, link.network)
  const o = optionsOf(row)
  const proto = link.proto
  const companionRow = link.companion ? rowOf(ctx, 'network', link.companion) : null
  const companion = optionsOf(companionRow)
  const deviceRow = link.deviceSection ? rowOf(ctx, 'network', link.deviceSection) : null
  const device = optionsOf(deviceRow)
  const poolRow = link.pool ? rowOf(ctx, 'dhcp', link.pool) : null
  const pool = optionsOf(poolRow)
  const meta = ctx.metas.get(link.network) ?? null
  const live = ctx.facts.interfaces?.find((i) => i.network === link.network) ?? null
  const liveV6 = link.companion
    ? (ctx.facts.interfaces?.find((i) => i.network === link.companion) ?? null)
    : null
  const zone = zoneOf(ctx, link.network)
  const aliases = link.aliases
    .map((a) => aliasView(ctx, a))
    .filter((a): a is WanAliasView => a !== null)
  const ifaceMac = scalarOption(o, 'macaddr')
  const devMac = scalarOption(device, 'macaddr')
  const mtuText = scalarOption(device, 'mtu') ?? scalarOption(o, 'mtu')
  const metricText = scalarOption(o, 'metric')
  const sqmQueue = (ctx.all.sqm?.sections ?? []).find(
    (q) =>
      q.type === 'queue' &&
      (scalarOption(q.options, 'interface') === link.device ||
        (live?.device && scalarOption(q.options, 'interface') === live.device) ||
        scalarOption(q.options, 'interface') === `pppoe-${link.network}`)
  )
  const l3 = live?.device ?? (proto === 'pppoe' ? `pppoe-${link.network}` : link.device)
  const ipv6Mode: WanView['ipv6']['mode'] = (() => {
    const relay = scalarOption(pool, 'ra') === 'relay' || scalarOption(pool, 'dhcpv6') === 'relay'
    if (relay) return 'relay'
    if (companionRow && interfaceEnabled(companion)) {
      return protoOf(companion) === 'static' ? 'static' : 'dhcpv6'
    }
    const v6 = scalarOption(o, 'ipv6')
    if (v6 !== null && v6 !== '0') return 'auto'
    if (v6 === null && proto === 'pppoe') return 'auto'
    return 'off'
  })()
  const sectionRows = [
    row,
    companionRow,
    deviceRow,
    poolRow,
    ...link.aliases.map((a) => rowOf(ctx, 'network', a)),
  ].filter((r): r is SectionState => r !== null)
  const ids = new Set(sectionRows.map((r) => r.perchId))
  return {
    id: row.perchId,
    network: link.network,
    label: meta?.label ?? link.network,
    role: link.role,
    failoverRank: link.rank,
    proto,
    editable: (['dhcp', 'static', 'pppoe'] as string[]).includes(proto) ? 'full' : 'limited',
    device: link.device,
    enabled: link.enabled,
    metric: metricText !== null && /^\d+$/.test(metricText) ? Number(metricText) : null,
    defaultRoute: link.defaultRoute,
    dns: { useProvider: flag(o, 'peerdns') !== '0', servers: wordsOf(o.dns) },
    static:
      proto === 'static'
        ? {
            addresses: interfaceCidrs(o),
            gateway: scalarOption(o, 'gateway'),
            broadcast: scalarOption(o, 'broadcast'),
          }
        : null,
    pppoe:
      proto === 'pppoe'
        ? {
            username: scalarOption(o, 'username'),
            password: secretState(row, 'password'),
            service: scalarOption(o, 'service'),
            ac: scalarOption(o, 'ac'),
            keepalive: scalarOption(o, 'keepalive'),
          }
        : null,
    dhcp:
      proto === 'dhcp'
        ? {
            hostname: scalarOption(o, 'hostname'),
            clientId: scalarOption(o, 'clientid'),
            vendorId: scalarOption(o, 'vendorid'),
          }
        : null,
    mobile: MOBILE_PROTOS.includes(proto)
      ? {
          apn: scalarOption(o, 'apn'),
          pincode: secretState(row, 'pincode'),
          device: scalarOption(o, 'device'),
        }
      : null,
    mtu: mtuText !== null && /^\d+$/.test(mtuText) ? Number(mtuText) : null,
    mac: {
      effective: devMac ?? ifaceMac,
      source: devMac ? 'device' : ifaceMac ? 'interface' : null,
      deviceSection: deviceRow?.perchId ?? null,
      ignoredInterfaceMac:
        devMac !== null && ifaceMac !== null && devMac.toLowerCase() !== ifaceMac.toLowerCase(),
    },
    ipv6: {
      mode: ipv6Mode,
      companion: companionRow?.perchId ?? null,
      reqAddress: scalarOption(companion, 'reqaddress'),
      reqPrefix: scalarOption(companion, 'reqprefix'),
      ip6prefix: wordsOf(o.ip6prefix),
      delegate: flag(o, 'delegate') === null ? null : flag(o, 'delegate') === '1',
    },
    aliases,
    pool: poolRow
      ? {
          perchId: poolRow.perchId,
          ignore: flag(pool, 'ignore') === '1',
          ra: scalarOption(pool, 'ra'),
          dhcpv6: scalarOption(pool, 'dhcpv6'),
          ndp: scalarOption(pool, 'ndp'),
          master: flag(pool, 'master') === '1',
        }
      : null,
    zone: zone?.name ?? null,
    zoneMasq: zone?.masq ?? false,
    sqm: sqmQueue
      ? {
          queue: sqmQueue.name,
          interface: scalarOption(sqmQueue.options, 'interface') ?? '',
          enabled: flag(sqmQueue.options, 'enabled') === '1',
          mismatch: l3 !== null && scalarOption(sqmQueue.options, 'interface') !== l3,
        }
      : null,
    management: managementOf(ctx, link),
    live: live
      ? {
          up: live.up,
          ipv4: live.ipv4,
          ipv6: [...live.ipv6, ...(liveV6?.ipv6 ?? [])],
          gateway4: live.gateway4,
          gateway6: live.gateway6 ?? liveV6?.gateway6 ?? null,
          defaultRouteActive: live.defaultRoute === true,
          uptimeSeconds: live.uptimeSeconds,
          error: live.error,
          ipv6Prefixes: [],
          mwan3Status: mwan3StatusOf(ctx, link.network),
          observedAt: ctx.facts.observedAt.interfaces ?? DateTime.utc().toISO()!,
        }
      : null,
    sections: [...ids],
    sync: worstSync(sectionRows),
    extra: extraOf(o, MODELED_INTERFACE),
    issues: issues.filter((i) => i.perchId && ids.has(i.perchId)),
    meta: {
      label: meta?.label ?? link.network,
      checkTargets: meta?.checkTargets ?? null,
      note: meta?.note ?? null,
      roleOverride: (meta?.roleOverride as WanRole | null) ?? null,
    },
  }
}

function mwan3StatusOf(ctx: WanContext, network: string): string | null {
  const status = ctx.facts.mwan3 as unknown as {
    interfaces?: Array<{ name?: string; status?: string }>
  } | null
  const entry = status?.interfaces?.find((i) => i.name === network)
  return typeof entry?.status === 'string' ? entry.status : null
}

function mwan3Running(ctx: WanContext): boolean {
  const m = ctx.facts.mwan3 as unknown as { running?: boolean } | null
  return m?.running === true
}

function unavailableReason(ctx: WanContext): WanOverview['unavailableReason'] {
  if (normalizeMode(ctx.gateway.mode) !== 'managed') return 'not_managed'
  if (!hasFeature(ctx.gateway.capabilities, 'config.checks.v1')) return 'capability_missing'
  const reason = domainRegistry()
    .get(WAN_KEY)
    ?.requires?.(ctx.gateway.capabilities ?? {})
  return reason ? 'router_access' : null
}

/** Is an address inside one of the LAN subnets (the side rule's LAN networks)? */
function adminOutside(ctx: WanContext, ip: string | null | undefined): boolean {
  if (!ip) return false
  const address = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  if (address === '127.0.0.1' || address === '::1') return false
  if (!isIpv4Address(address)) return isIP(address) === 6 && !address.startsWith('fe80')
  const lans = (ctx.all.network?.sections ?? []).filter(
    (s) => s.type === 'interface' && ctx.topology.sides.get(s.name) === 'lan'
  )
  return !lans.some((s) =>
    interfaceCidrs(s.options).some((cidr) => {
      const p = parseCidr(cidr)
      if (!p) return false
      const mask = p.prefix === 0 ? 0 : (0xffffffff << (32 - p.prefix)) >>> 0
      const n = (a: string) => a.split('.').reduce((acc, x) => acc * 256 + Number(x), 0) >>> 0
      return (n(address) & mask) >>> 0 === (n(p.address) & mask) >>> 0
    })
  )
}

function overviewOf(
  ctx: WanContext,
  requestIp: string | null | undefined,
  transitions: WanTransitionView[]
): WanOverview {
  const issues = validateStates(ctx.gateway, ctx.states)
  const reason = unavailableReason(ctx)
  const confirmMax = (ctx.gateway.capabilities as Record<string, unknown> | null)?.confirmMaxSeconds
  return {
    gatewayId: ctx.gateway.id,
    available: reason === null,
    unavailableReason: reason,
    uplinks: ctx.topology.uplinks.map((l) => linkView(ctx, l, issues)),
    natLinks: ctx.topology.natLinks.map((l) => linkView(ctx, l, issues)),
    failover: {
      mode: mwan3Running(ctx) ? 'mwan3' : 'metric',
      order: ctx.topology.uplinks.map((u) => interfaceRow(ctx, u.network).perchId),
    },
    managementPath: {
      network: ctx.gateway.managementPath?.network ?? null,
      wanSide: pathWanSide(ctx),
    },
    adminOutside: adminOutside(ctx, requestIp),
    checks: {
      targets: ctx.settings.checkTargets,
      resolveName: ctx.settings.checkResolveName || null,
      confirmTimeoutSeconds:
        typeof confirmMax === 'number' && confirmMax > 0
          ? Math.min(ctx.settings.wanConfirmTimeoutSeconds, confirmMax)
          : ctx.settings.wanConfirmTimeoutSeconds,
    },
    transitions,
    observedAt: ctx.facts.observedAt.interfaces ?? null,
  }
}

/** `GET /gateways/:id/wan`. */
export async function wanOverview(
  gatewayId: number,
  requestIp?: string | null
): Promise<WanOverview> {
  const ctx = await loadWan(gatewayId)
  return overviewOf(ctx, requestIp, await latestTransitions(ctx.gateway.id, 50))
}

function linkById(ctx: WanContext, perchId: string): WanLink {
  const row = ctx.states.find((s) => s.perchId === perchId && s.config === 'network')
  const link = row
    ? [...ctx.topology.uplinks, ...ctx.topology.natLinks].find((l) => l.network === row.name)
    : undefined
  if (!link) throw planeError(404, 'wan_not_found', `No WAN ${perchId}.`)
  return link
}

/** `GET /gateways/:id/wan/:perchId`. */
export async function wanView(gatewayId: number, perchId: string): Promise<WanView> {
  const ctx = await loadWan(gatewayId)
  return linkView(ctx, linkById(ctx, perchId), validateStates(ctx.gateway, ctx.states))
}

/** `GET /gateways/:id/wan/history`. */
export async function wanHistory(
  gatewayId: number,
  range: '24h' | '7d' | '30d',
  network: string | null
) {
  const gateway = await findGateway(gatewayId)
  const to = DateTime.utc()
  const from = to.minus(
    range === '24h' ? { hours: 24 } : range === '7d' ? { days: 7 } : { days: 30 }
  )
  return {
    gatewayId: gateway.id,
    from: from.toISO()!,
    to: to.toISO()!,
    transitions: await transitionsBetween(gateway.id, from, to, network),
  }
}

// ── write helpers ─────────────────────────────────────────────────────────

function requireManaged(ctx: WanContext) {
  if (normalizeMode(ctx.gateway.mode) !== 'managed') {
    throw planeError(409, 'not_managed', 'The gateway is not in managed mode.')
  }
}

/** A WAN row must be synced by the `wan` domain before Perch writes it. */
function requireWanSynced(ctx: WanContext, row: SectionState) {
  if (row.scope === 'synced' && row.domain === WAN_KEY) return
  const reason = domainRegistry()
    .get(WAN_KEY)
    ?.requires?.(ctx.gateway.capabilities ?? {})
  if (reason && hasFeature(ctx.gateway.capabilities, 'config.checks.v1') === false) {
    throw planeError(409, 'gateway_capability_missing', `${reason}.`, {
      capability: 'config.checks.v1',
    })
  }
  if (reason) throw planeError(409, 'router_access_insufficient', `${reason}.`)
  throw planeError(409, 'not_synced', `${row.name} is the router’s; include it first.`, {
    perchId: row.perchId,
    issue: row.issue,
  })
}

const PPPOE_OPTIONS = ['username', 'password', 'service', 'ac', 'keepalive', 'host_uniq']
const STATIC_OPTIONS = ['ipaddr', 'netmask', 'gateway', 'broadcast']
const DHCP_OPTIONS = ['hostname', 'clientid', 'vendorid', 'reqopts', 'sendopts']

function setOpt(o: UciOptions, key: string, value: UciValue | null | undefined) {
  if (value === undefined) return
  if (value === null || (Array.isArray(value) && value.length === 0) || value === '') delete o[key]
  else o[key] = value
}

function validMac(value: string): boolean {
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value)
}

function cidrList(addresses: string[], field: string): string[] {
  const out: string[] = []
  for (const a of addresses) {
    const p = parseCidr(a)
    if (!p || !a.includes('/') || p.prefix < 1 || p.prefix > 32) {
      throw planeError(
        422,
        'wan_static_address_invalid',
        `"${a}" is not an IPv4 address with a prefix.`,
        {
          field,
        }
      )
    }
    out.push(`${p.address}/${p.prefix}`)
  }
  return out
}

type Staged = {
  batches: Map<string, SectionEdit[]>
  secrets: Array<{ ref: string; value: string; fingerprint: string }>
  skipChecks: boolean
  touched: string[]
}

function staged(): Staged {
  return { batches: new Map(), secrets: [], skipChecks: false, touched: [] }
}

function stage(s: Staged, domain: string, edit: SectionEdit) {
  const list = s.batches.get(domain) ?? []
  list.push(edit)
  s.batches.set(domain, list)
}

/** Keeps every router or controller secret of a row as it is. */
function keptSecrets(row: SectionState | null, except: string[] = []): Record<string, SecretEdit> {
  const out: Record<string, SecretEdit> = {}
  const c = row ? (contentOf(row) ?? row.router) : null
  for (const name of Object.keys(c?.secrets ?? {})) {
    if (!except.includes(name)) out[name] = { keep: true }
  }
  return out
}

async function apiKeyOf(gateway: Gateway): Promise<string> {
  const collector = gateway.collectorId !== null ? await Collector.find(gateway.collectorId) : null
  if (!collector?.apiKey) throw planeError(409, 'agent_offline', 'The gateway has no collector.')
  return collector.apiKey
}

/** Secrets travel only over verified TLS (config-plane.md 11.1). */
async function requireSecureForSecrets(gateway: Gateway) {
  const access = writeAccess(gateway, await getGatewayConfigSettings())
  const insecure =
    (access.writable && access.signed) ||
    (!access.writable &&
      ['insecure_transport', 'not_paired', 'sign_key_unknown'].includes(access.reason))
  if (insecure) {
    throw planeError(
      409,
      'insecure_transport',
      'Passwords go to the router only over verified TLS; set it in LuCI, Perch keeps the router’s value.'
    )
  }
}

/** A controller-set secret on `network.<section>.<option>`. */
async function secretEdit(
  ctx: WanContext,
  s: Staged,
  section: string,
  option: string,
  value: string
): Promise<SecretEdit> {
  await requireSecureForSecrets(ctx.gateway)
  const ref = newSecretRef()
  const slot = controllerSecretSlot(
    await apiKeyOf(ctx.gateway),
    { config: 'network', section, option },
    ref,
    value
  )
  s.secrets.push({ ref, value, fingerprint: slot.fingerprint })
  return { ref, fingerprint: slot.fingerprint }
}

/** The topology after the staged network edits (the guards' view). */
function topologyAfter(ctx: WanContext, s: Staged): WanTopology {
  const next: UciConfigSet = structuredClone(ctx.all)
  for (const [, edits] of s.batches) {
    for (const edit of edits) {
      if (edit.op === 'order') continue
      if (edit.op === 'delete') {
        const row = ctx.states.find((r) => r.perchId === edit.perchId)
        if (!row) continue
        const list = next[row.config]?.sections
        const i = list?.findIndex((x) => x.name === row.name) ?? -1
        if (list && i >= 0) list.splice(i, 1)
        continue
      }
      const row = edit.perchId ? ctx.states.find((r) => r.perchId === edit.perchId) : null
      const name = row?.name ?? edit.name ?? `perch_new${Math.random().toString(36).slice(2, 8)}`
      const config = (next[edit.config] ??= { name: edit.config, hash: '', sections: [] })
      const i = config.sections.findIndex((x) => x.name === name)
      const section = {
        name,
        type: edit.type,
        anonymous: false,
        index: config.sections.length,
        options: edit.options,
      }
      if (i >= 0) config.sections[i] = { ...section, index: i }
      else config.sections.push(section)
    }
  }
  return wanTopology(next)
}

/** `wan_last_uplink` / `wan_management_path` (domains.md 3.5). */
async function guards(
  ctx: WanContext,
  s: Staged,
  link: WanLink,
  change: { disables: boolean; deletes: boolean; protoChange: boolean },
  confirm: string | undefined
) {
  if (pathWanSide(ctx) && link.role === 'internet' && managementOf(ctx, link)) {
    if (change.disables || change.deletes || change.protoChange) {
      throw planeError(
        409,
        'wan_management_path',
        `The controller is reached over ${link.network}: disabling, deleting or changing its protocol would cut Perch off.`,
        { network: link.network }
      )
    }
  }
  const after = topologyAfter(ctx, s)
  const before = ctx.topology.uplinks.some((u) => u.enabled && u.defaultRoute)
  if (before && !primaryUplink(after)) {
    const name = await gatewayDisplayName(ctx.gateway)
    if (confirm === undefined) {
      throw planeError(
        409,
        'wan_last_uplink',
        `This leaves no enabled internet uplink. Type the gateway's name (${name}) to apply it anyway.`,
        { confirm: name }
      )
    }
    if (confirm.trim() !== name) {
      throw planeError(422, 'confirm_mismatch', `Type the gateway's name (${name}) exactly.`)
    }
    // The router's checks could never pass: send the job with none.
    s.skipChecks = true
  }
}

/** Stores the staged secrets, edits the draft and starts the apply. */
async function commit(
  ctx: WanContext,
  userId: number,
  s: Staged,
  info: RequestInfo
): Promise<{
  issues: Issue[]
  apply: unknown | null
  applyError: WanWriteResult<unknown>['applyError']
}> {
  if (s.batches.size === 0) return { issues: [], apply: null, applyError: null }
  for (const secret of s.secrets) {
    const row = new GatewaySecret()
    row.gatewayId = ctx.gateway.id
    row.ref = secret.ref
    row.value = secret.value
    row.fingerprint = secret.fingerprint
    await row.save()
  }
  const batches: DomainEditBatch[] = [...s.batches].map(([domain, edits]) => ({ domain, edits }))
  const outcome = await editDomainSections(ctx.gateway.id, userId, batches)
  const touched = [...new Set([...outcome.perchIds, ...outcome.deleted])]
  const issues = [...outcome.issues]
  if (adminOutside(ctx, info.requestIp)) {
    issues.push({
      severity: 'warning',
      code: 'wan_admin_outside',
      message: 'You are connected from outside the LAN: a WAN change can cut this dashboard off.',
    })
  }
  if (!info.apply || touched.length === 0) return { issues, apply: null, applyError: null }
  try {
    const apply = await requestApply(ctx.gateway.id, {
      userId,
      perchIds: touched,
      skipChecks: s.skipChecks,
    })
    return { issues, apply, applyError: null }
  } catch (error) {
    if (error instanceof GatewayPlaneError) {
      return { issues, apply: null, applyError: { error: error.code, message: error.message } }
    }
    throw error
  }
}

async function upsertMeta(
  ctx: WanContext,
  network: string,
  interfacePerchId: string | null,
  set: { label?: string; checkTargets?: string[] | null }
) {
  if (set.label === undefined && set.checkTargets === undefined) return
  let meta = ctx.metas.get(network)
  if (!meta) {
    meta = new GatewayWan()
    meta.gatewayId = ctx.gateway.id
    meta.network = network
    meta.label = network
    meta.roleOverride = null
    meta.checkTargets = null
    meta.note = null
  }
  meta.interfacePerchId = interfacePerchId
  if (set.label !== undefined) meta.label = set.label.trim().slice(0, 80) || network
  if (set.checkTargets !== undefined) {
    const targets = set.checkTargets
    if (targets !== null) {
      if (targets.length === 0 || targets.length > 8) {
        throw planeError(422, 'invalid_setting', 'Name 1 to 8 check targets.', {
          field: 'checkTargets',
        })
      }
      const bad = targets.find((t) => t !== '$gateway' && isIP(t) === 0)
      if (bad) {
        throw planeError(422, 'invalid_setting', `"${bad}" is not an IP address or $gateway.`, {
          field: 'checkTargets',
        })
      }
    }
    meta.checkTargets = targets
  }
  await meta.save()
  ctx.metas.set(network, meta)
}

// ── PATCH /wan/:perchId ───────────────────────────────────────────────────

const FULL_FIELDS = ['proto', 'static', 'pppoe', 'dhcp'] as const

/** `PATCH /gateways/:id/wan/:perchId[?apply=0]`. */
export async function updateWan(
  gatewayId: number,
  userId: number,
  perchId: string,
  patch: WanPatch,
  info: RequestInfo
): Promise<WanWriteResult<WanView>> {
  const ctx = await loadWan(gatewayId)
  const link = linkById(ctx, perchId)
  const row = interfaceRow(ctx, link.network)
  await upsertMeta(ctx, link.network, row.perchId, patch)

  const uciFields = Object.keys(patch).filter(
    (k) => !['label', 'checkTargets', 'confirm', 'moveSqm'].includes(k)
  )
  if (uciFields.length === 0) {
    return {
      gatewayId: ctx.gateway.id,
      object: await wanView(gatewayId, perchId),
      issues: [],
      apply: null,
      applyError: null,
    }
  }
  requireManaged(ctx)
  requireWanSynced(ctx, row)
  const limited = !(['dhcp', 'static', 'pppoe'] as string[]).includes(link.proto)
  if (limited && FULL_FIELDS.some((f) => patch[f] !== undefined)) {
    throw planeError(
      409,
      'wan_limited_proto',
      `${link.network} runs ${link.proto}: only metric, DNS, MTU and enabled are edited here.`
    )
  }
  const current = optionsOf(row)
  // A router-side proto change while the draft holds edits of another proto
  // (domains.md 3.3): re-save with the router's proto first.
  if (patch.proto === undefined && row.status === 'ahead' && row.router) {
    const routerProto = protoOf(row.router.options)
    const stray =
      (routerProto !== 'pppoe' && PPPOE_OPTIONS.some((k) => current[k] !== undefined)) ||
      (routerProto !== 'static' &&
        ['ipaddr', 'netmask', 'gateway'].some((k) => current[k] !== undefined))
    if (stray && row.base && protoOf(row.base.options) === routerProto) {
      throw planeError(
        409,
        'wan_proto_changed_on_router',
        `The router runs ${link.network} with ${routerProto} now; save it again with that protocol.`,
        { routerProto }
      )
    }
  }

  const s = staged()
  const o = cloneOptions(current)
  const secrets = keptSecrets(row, ['password', 'pincode'])
  const nextProto = patch.proto ?? link.proto
  const protoChange = patch.proto !== undefined && patch.proto !== link.proto
  if (protoChange) {
    o.proto = patch.proto!
    const drop = [
      ...(nextProto !== 'pppoe' ? PPPOE_OPTIONS : []),
      ...(nextProto !== 'static' ? STATIC_OPTIONS : []),
      ...(nextProto !== 'dhcp' ? DHCP_OPTIONS : []),
    ]
    for (const k of drop) delete o[k]
  } else {
    // Secrets of the current proto stay.
    const c = contentOf(row) ?? row.router
    for (const name of ['password', 'pincode']) {
      if (c?.secrets?.[name]) secrets[name] = { keep: true }
    }
  }
  if (patch.enabled !== undefined) {
    if (patch.enabled) {
      delete o.disabled
      if (flag(o, 'auto') === '0') delete o.auto
    } else {
      o.disabled = '1'
    }
  }
  if (patch.metric !== undefined) o.metric = String(patch.metric)
  if (patch.defaultRoute !== undefined) setOpt(o, 'defaultroute', patch.defaultRoute ? null : '0')
  if (patch.dns) {
    setOpt(o, 'peerdns', patch.dns.useProvider ? null : '0')
    for (const server of patch.dns.servers) {
      if (isIP(server) === 0) {
        throw planeError(422, 'wan_dns_invalid', `"${server}" is not an IP address.`, {
          field: 'dns',
        })
      }
    }
    setOpt(o, 'dns', patch.dns.servers.length > 0 ? [...patch.dns.servers] : null)
  }
  if (patch.static) {
    if (nextProto !== 'static') {
      throw planeError(422, 'wan_static_address_invalid', 'Static addresses need proto static.')
    }
    o.ipaddr = cidrList(patch.static.addresses, 'static.addresses')
    delete o.netmask
    if (patch.static.gateway !== null && !isIpv4Address(patch.static.gateway)) {
      throw planeError(
        422,
        'wan_static_address_invalid',
        `"${patch.static.gateway}" is not an IPv4 gateway.`,
        {
          field: 'static.gateway',
        }
      )
    }
    setOpt(o, 'gateway', patch.static.gateway)
    if (patch.static.broadcast !== undefined) setOpt(o, 'broadcast', patch.static.broadcast)
  }
  if (patch.pppoe) {
    if (nextProto !== 'pppoe') {
      throw planeError(422, 'wan_pppoe_username_required', 'PPPoE settings need proto pppoe.')
    }
    if (patch.pppoe.username !== undefined) setOpt(o, 'username', patch.pppoe.username)
    setOpt(o, 'service', patch.pppoe.service)
    setOpt(o, 'ac', patch.pppoe.ac)
    setOpt(o, 'keepalive', patch.pppoe.keepalive)
    if (patch.pppoe.password === null) delete secrets.password
    else if (patch.pppoe.password !== undefined) {
      secrets.password = await secretEdit(ctx, s, row.name, 'password', patch.pppoe.password)
    }
  }
  if (nextProto === 'pppoe' && !scalarOption(o, 'username')) {
    throw planeError(422, 'wan_pppoe_username_required', 'PPPoE needs a user name.', {
      field: 'pppoe.username',
    })
  }
  if (patch.dhcp) {
    setOpt(o, 'hostname', patch.dhcp.hostname)
    setOpt(o, 'clientid', patch.dhcp.clientId)
    setOpt(o, 'vendorid', patch.dhcp.vendorId)
  }
  if (patch.mobile) {
    if (!MOBILE_PROTOS.includes(link.proto)) {
      throw planeError(409, 'wan_limited_proto', `${link.network} is not a mobile WAN.`)
    }
    setOpt(o, 'apn', patch.mobile.apn)
    if (patch.mobile.pincode === null) delete secrets.pincode
    else if (patch.mobile.pincode !== undefined) {
      secrets.pincode = await secretEdit(ctx, s, row.name, 'pincode', patch.mobile.pincode)
    }
  }
  if (patch.metric !== undefined && (patch.metric < 0 || patch.metric > 2147483647)) {
    throw planeError(422, 'wan_metric_invalid', 'The metric is 0 to 2147483647.', {
      field: 'metric',
    })
  }
  // MAC and MTU go to the port's device section (the one in effect).
  if (patch.mac !== undefined || patch.mtu !== undefined) {
    if (patch.mac !== undefined && patch.mac !== null && !validMac(patch.mac)) {
      throw planeError(422, 'wan_mac_invalid', `"${patch.mac}" is not a MAC address.`, {
        field: 'mac',
      })
    }
    if (patch.mtu !== undefined && patch.mtu !== null && (patch.mtu < 576 || patch.mtu > 9200)) {
      throw planeError(422, 'wan_mtu_invalid', 'The MTU is 576 to 9200.', { field: 'mtu' })
    }
    const deviceRow = link.deviceSection ? rowOf(ctx, 'network', link.deviceSection) : null
    if (deviceRow) {
      requireWanSynced(ctx, deviceRow)
      const d = optionsOf(deviceRow)
      if (patch.mac !== undefined)
        setOpt(d, 'macaddr', patch.mac === null ? null : patch.mac.toLowerCase())
      if (patch.mtu !== undefined) setOpt(d, 'mtu', patch.mtu === null ? null : String(patch.mtu))
      stage(s, WAN_KEY, {
        op: 'put',
        perchId: deviceRow.perchId,
        config: 'network',
        type: 'device',
        options: d,
      })
    } else if (link.device && !link.device.startsWith('@')) {
      const d: UciOptions = { name: link.device }
      if (patch.mac) d.macaddr = patch.mac.toLowerCase()
      if (patch.mtu !== undefined && patch.mtu !== null) d.mtu = String(patch.mtu)
      if (Object.keys(d).length > 1) {
        stage(s, WAN_KEY, {
          op: 'put',
          perchId: null,
          config: 'network',
          type: 'device',
          options: d,
        })
      }
    } else if (patch.mtu !== undefined) {
      setOpt(o, 'mtu', patch.mtu === null ? null : String(patch.mtu))
    }
    // The interface-level macaddr is not in effect beside a device's.
    if (patch.mac !== undefined) delete o.macaddr
  }
  if (patch.ipv6) stageIpv6(ctx, s, link, o, patch.ipv6)
  if (patch.moveSqm && protoChange) stageSqmMove(ctx, s, link, nextProto)

  stage(s, WAN_KEY, {
    op: 'put',
    perchId: row.perchId,
    config: 'network',
    type: 'interface',
    options: o,
    ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
    // An explicit enable takes the switch back from a router-side pause.
    ...(patch.enabled !== undefined ? { reclaim: ['disabled'] } : {}),
  })
  await guards(
    ctx,
    s,
    link,
    {
      disables: patch.enabled === false || patch.defaultRoute === false,
      deletes: false,
      protoChange,
    },
    patch.confirm
  )
  const result = await commit(ctx, userId, s, info)
  return {
    gatewayId: ctx.gateway.id,
    object: await wanView(gatewayId, perchId),
    ...result,
  }
}

/** The WAN's IPv6 upstream (rest.md 3 `ipv6`): the companion, the uplink's `ipv6`, relay on its pool. */
function stageIpv6(
  ctx: WanContext,
  s: Staged,
  link: WanLink,
  o: UciOptions,
  ipv6: NonNullable<WanPatch['ipv6']>
) {
  const companionRow = link.companion ? rowOf(ctx, 'network', link.companion) : null
  const companion = optionsOf(companionRow)
  const put = (options: UciOptions) => {
    if (companionRow) {
      requireWanSynced(ctx, companionRow)
      stage(s, WAN_KEY, {
        op: 'put',
        perchId: companionRow.perchId,
        config: 'network',
        type: 'interface',
        options,
        ...(Object.keys(keptSecrets(companionRow)).length > 0
          ? { secrets: keptSecrets(companionRow) }
          : {}),
      })
    }
  }
  if (ipv6.mode === 'off') {
    if (companionRow) put({ ...companion, disabled: '1' })
    if (link.proto === 'pppoe' || scalarOption(o, 'ipv6') !== null) o.ipv6 = '0'
    return
  }
  if (ipv6.mode === 'auto') {
    if (companionRow) put({ ...companion, disabled: '1' })
    if (link.proto === 'pppoe') delete o.ipv6
    else o.ipv6 = 'auto'
    return
  }
  if (ipv6.mode === 'relay') {
    const poolRow = link.pool ? rowOf(ctx, 'dhcp', link.pool) : null
    const pool = poolRow ? optionsOf(poolRow) : { interface: link.companion ?? link.network }
    Object.assign(pool, { ra: 'relay', dhcpv6: 'relay', ndp: 'relay', master: '1' })
    if (poolRow) requireWanSynced(ctx, poolRow)
    stage(s, WAN_KEY, {
      op: 'put',
      perchId: poolRow?.perchId ?? null,
      config: 'dhcp',
      type: 'dhcp',
      options: pool,
      ...(poolRow ? {} : { name: link.network }),
    })
    return
  }
  // dhcpv6: the companion does it.
  const next: UciOptions = companionRow
    ? { ...companion }
    : { proto: 'dhcpv6', device: `@${link.network}` }
  delete next.disabled
  next.proto = 'dhcpv6'
  if (ipv6.reqAddress !== undefined) next.reqaddress = ipv6.reqAddress
  if (ipv6.reqPrefix !== undefined) {
    const v = ipv6.reqPrefix as unknown
    const ok =
      v === 'auto' ||
      v === 'no' ||
      (typeof v === 'number' && Number.isInteger(v) && v >= 48 && v <= 64)
    if (!ok) {
      throw planeError(
        422,
        'wan_ipv6_mode_invalid',
        'reqPrefix is auto, no or a length of 48–64.',
        {
          field: 'ipv6.reqPrefix',
        }
      )
    }
    next.reqprefix = String(v)
  }
  if (companionRow) put(next)
  else {
    const name = `${link.network}6`.slice(0, 15)
    if (ctx.all.network?.sections.some((x) => x.name === name)) {
      throw planeError(409, 'network_key_taken', `An interface ${name} exists already.`)
    }
    stage(s, WAN_KEY, {
      op: 'put',
      perchId: null,
      config: 'network',
      type: 'interface',
      name,
      options: next,
    })
    stageZoneMembership(ctx, s, name, zoneOf(ctx, link.network)?.name ?? null)
  }
  if (link.proto === 'dhcp') delete o.ipv6
}

/** A proto change moves the L3 device (`pppoe-<net>`): its SQM queue follows (`moveSqm`). */
function stageSqmMove(ctx: WanContext, s: Staged, link: WanLink, proto: string) {
  const oldL3 = link.proto === 'pppoe' ? `pppoe-${link.network}` : link.device
  const newL3 = proto === 'pppoe' ? `pppoe-${link.network}` : link.device
  if (!oldL3 || !newL3 || oldL3 === newL3) return
  for (const row of ctx.states) {
    const c = contentOf(row)
    if (row.config !== 'sqm' || !c || c.type !== 'queue') continue
    if (scalarOption(c.options, 'interface') !== oldL3) continue
    if (row.scope !== 'synced') {
      throw planeError(409, 'not_synced', `The SQM queue ${row.name} is the router’s.`, {
        perchId: row.perchId,
      })
    }
    stage(s, row.domain ?? 'sqm', {
      op: 'put',
      perchId: row.perchId,
      config: 'sqm',
      type: 'queue',
      options: { ...c.options, interface: newL3 },
      ...(Object.keys(keptSecrets(row)).length > 0 ? { secrets: keptSecrets(row) } : {}),
    })
  }
}

/** Puts a network into a firewall zone (and out of any other), or out of every zone (null). */
function stageZoneMembership(ctx: WanContext, s: Staged, network: string, zone: string | null) {
  for (const row of ctx.states) {
    const c = contentOf(row)
    if (row.config !== 'firewall' || !c || c.type !== 'zone') continue
    const name = scalarOption(c.options, 'name') ?? row.name
    const networks = wordsOf(c.options.network)
    const listed = networks.includes(network)
    const wanted = name === zone
    if (listed === wanted) continue
    if (row.scope !== 'synced') {
      throw planeError(
        409,
        'not_synced',
        `The firewall zone ${name} is the router’s; include it first.`,
        {
          perchId: row.perchId,
        }
      )
    }
    const next = wanted ? [...networks, network] : networks.filter((n) => n !== network)
    stage(s, row.domain ?? 'firewall', {
      op: 'put',
      perchId: row.perchId,
      config: 'firewall',
      type: 'zone',
      options: { ...c.options, network: next },
    })
  }
  if (zone !== null && !zoneExists(ctx, zone)) {
    throw planeError(422, 'firewall_zone_unknown', `No firewall zone ${zone}.`, { field: 'zone' })
  }
}

function zoneExists(ctx: WanContext, zone: string): boolean {
  return (ctx.all.firewall?.sections ?? []).some(
    (z) => z.type === 'zone' && (scalarOption(z.options, 'name') ?? z.name) === zone
  )
}

// ── PUT /wan/order ────────────────────────────────────────────────────────

/** `PUT /gateways/:id/wan/order[?apply=0]`: the existing metrics, sorted, in the new order. */
export async function orderWans(
  gatewayId: number,
  userId: number,
  ids: string[],
  info: RequestInfo
): Promise<WanWriteResult<WanOverview>> {
  const ctx = await loadWan(gatewayId)
  requireManaged(ctx)
  const uplinkIds = ctx.topology.uplinks.map((u) => interfaceRow(ctx, u.network).perchId)
  const missing = uplinkIds.filter((id) => !ids.includes(id))
  const unknown = ids.filter((id) => !uplinkIds.includes(id))
  if (missing.length > 0 || unknown.length > 0 || new Set(ids).size !== ids.length) {
    throw planeError(422, 'wan_order_incomplete', 'Name every uplink once, primary first.', {
      missing,
      unknown,
    })
  }
  if (mwan3Running(ctx)) {
    throw planeError(409, 'wan_order_mwan3', 'mwan3 runs on the router: the order is its policy’s.')
  }
  const metrics = ctx.topology.uplinks.map((u) => u.metric).sort((a, b) => a - b)
  const s = staged()
  let previous = -1
  ids.forEach((id, i) => {
    const row = ctx.states.find((r) => r.perchId === id)!
    let metric = metrics[i]
    if (metric <= previous) metric = previous + 1
    previous = metric
    const link = ctx.topology.uplinks.find((u) => u.network === row.name)!
    if (link.metric === metric && scalarOption(optionsOf(row), 'metric') !== null) return
    requireWanSynced(ctx, row)
    const o = optionsOf(row)
    o.metric = String(metric)
    const secrets = keptSecrets(row)
    stage(s, WAN_KEY, {
      op: 'put',
      perchId: row.perchId,
      config: 'network',
      type: 'interface',
      options: o,
      ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
    })
  })
  const result = await commit(ctx, userId, s, info)
  return {
    gatewayId: ctx.gateway.id,
    object: await wanOverview(gatewayId, info.requestIp),
    ...result,
  }
}

// ── POST /wan, DELETE /wan/:perchId ───────────────────────────────────────

const NETWORK_NAME = /^[a-z][a-z0-9_]{0,14}$/
const DEVICE_NAME = /^[A-Za-z0-9_.@-]{1,15}$/

/** `POST /gateways/:id/wan[?apply=0]`: a new uplink in the primary's zone (or a new one). */
export async function createWan(
  gatewayId: number,
  userId: number,
  body: WanCreate,
  info: RequestInfo
): Promise<WanWriteResult<WanView>> {
  const ctx = await loadWan(gatewayId)
  requireManaged(ctx)
  if (
    domainRegistry()
      .get(WAN_KEY)
      ?.requires?.(ctx.gateway.capabilities ?? {})
  ) {
    throw planeError(
      409,
      'gateway_capability_missing',
      'The gateway agent is too old for WAN changes.',
      {
        capability: 'config.checks.v1',
      }
    )
  }
  if (!NETWORK_NAME.test(body.network)) {
    throw planeError(
      422,
      'network_name_invalid',
      'A network name is a-z, 0-9 and _, 1–15 characters.',
      {
        field: 'network',
      }
    )
  }
  if (!DEVICE_NAME.test(body.device)) {
    throw planeError(422, 'wan_device_invalid', `"${body.device}" is not a device name.`, {
      field: 'device',
    })
  }
  if (
    ctx.all.network?.sections.some((x) => x.name === body.network) ||
    (zoneExists(ctx, body.network) && body.createZone)
  ) {
    throw planeError(409, 'network_key_taken', `The name ${body.network} is taken.`, {
      field: 'network',
    })
  }
  const usedBy = (ctx.all.network?.sections ?? [])
    .filter((x) => x.type === 'interface' && ctx.topology.sides.get(x.name) === 'lan')
    .filter((x) => uciDeviceOf(x) === body.device)
    .map((x) => x.name)
  const bridgePorts = (ctx.all.network?.sections ?? []).filter(
    (x) =>
      x.type === 'device' &&
      scalarOption(x.options, 'type') === 'bridge' &&
      wordsOf(x.options.ports).includes(body.device)
  )
  if (usedBy.length > 0 || bridgePorts.length > 0) {
    throw planeError(409, 'wan_device_in_use', `${body.device} is used on the LAN.`, {
      usedBy: [...usedBy, ...bridgePorts.map((b) => scalarOption(b.options, 'name') ?? b.name)],
    })
  }
  const s = staged()
  const o: UciOptions = { proto: body.proto, device: body.device }
  const primary = primaryUplink(ctx.topology)
  o.metric = String(body.metric ?? Math.max(0, ...ctx.topology.uplinks.map((u) => u.metric)) + 10)
  if (body.enabled === false) o.disabled = '1'
  if (body.defaultRoute === false) o.defaultroute = '0'
  if (body.dns) {
    setOpt(o, 'peerdns', body.dns.useProvider ? null : '0')
    setOpt(o, 'dns', body.dns.servers.length > 0 ? [...body.dns.servers] : null)
  }
  if (body.proto === 'static') {
    if (!body.static)
      throw planeError(422, 'wan_static_address_invalid', 'A static WAN needs its addresses.')
    o.ipaddr = cidrList(body.static.addresses, 'static.addresses')
    if (body.static.gateway !== null && !isIpv4Address(body.static.gateway)) {
      throw planeError(
        422,
        'wan_static_address_invalid',
        `"${body.static.gateway}" is not an IPv4 gateway.`
      )
    }
    setOpt(o, 'gateway', body.static.gateway)
  }
  const secrets: Record<string, SecretEdit> = {}
  if (body.proto === 'pppoe') {
    if (!body.pppoe?.username) {
      throw planeError(422, 'wan_pppoe_username_required', 'PPPoE needs a user name.', {
        field: 'pppoe.username',
      })
    }
    o.username = body.pppoe.username
    setOpt(o, 'service', body.pppoe.service)
    setOpt(o, 'ac', body.pppoe.ac)
    setOpt(o, 'keepalive', body.pppoe.keepalive)
    if (body.pppoe.password) {
      secrets.password = await secretEdit(ctx, s, body.network, 'password', body.pppoe.password)
    }
  }
  if (body.dhcp) {
    setOpt(o, 'hostname', body.dhcp.hostname)
    setOpt(o, 'clientid', body.dhcp.clientId)
    setOpt(o, 'vendorid', body.dhcp.vendorId)
  }
  stage(s, WAN_KEY, {
    op: 'put',
    perchId: null,
    config: 'network',
    type: 'interface',
    name: body.network,
    options: o,
    ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
  })
  let zone =
    body.zone === undefined
      ? primary
        ? (zoneOf(ctx, primary.network)?.name ?? null)
        : null
      : body.zone
  if (body.createZone) {
    zone = body.zone ?? body.network
    stage(s, 'firewall', {
      op: 'put',
      perchId: null,
      config: 'firewall',
      type: 'zone',
      options: {
        name: zone,
        network: [body.network],
        input: 'REJECT',
        output: 'ACCEPT',
        forward: 'REJECT',
        masq: '1',
        mtu_fix: '1',
      },
    })
    // The LAN zones that forward to the primary's zone forward to this one too.
    const primaryZone = primary ? zoneOf(ctx, primary.network)?.name : undefined
    for (const f of ctx.all.firewall?.sections ?? []) {
      if (f.type !== 'forwarding' || scalarOption(f.options, 'dest') !== primaryZone) continue
      const src = scalarOption(f.options, 'src')
      if (!src) continue
      stage(s, 'firewall', {
        op: 'put',
        perchId: null,
        config: 'firewall',
        type: 'forwarding',
        options: { src, dest: zone },
      })
    }
  } else if (zone !== null) {
    stageZoneMembership(ctx, s, body.network, zone)
  }
  if (body.label !== undefined || body.checkTargets !== undefined) {
    await upsertMeta(ctx, body.network, null, body)
  }
  const result = await commit(ctx, userId, s, info)
  const after = await loadWan(gatewayId)
  const created = [...after.topology.uplinks, ...after.topology.natLinks].find(
    (l) => l.network === body.network
  )
  return {
    gatewayId: ctx.gateway.id,
    object: created ? linkView(after, created, result.issues) : null,
    ...result,
  }
}

/**
 * `DELETE /gateways/:id/wan/:perchId[?apply=0]` `{ confirm }` (the WAN's
 * network name): the interface, its companion, aliases, pool, the port's
 * device section when only it used it, and its zone membership.
 */
export async function deleteWan(
  gatewayId: number,
  userId: number,
  perchId: string,
  confirm: string,
  info: RequestInfo
): Promise<WanWriteResult<null>> {
  const ctx = await loadWan(gatewayId)
  requireManaged(ctx)
  const link = linkById(ctx, perchId)
  if (confirm.trim() !== link.network) {
    throw planeError(
      422,
      'confirm_mismatch',
      `Type the WAN's network name (${link.network}) to delete it.`
    )
  }
  const referenced = referencesOf(ctx, link)
  if (referenced.length > 0) {
    throw planeError(
      409,
      'wan_referenced',
      `${link.network} is still named by ${referenced.join(', ')}.`,
      {
        by: referenced,
      }
    )
  }
  const s = staged()
  const networks = [link.network, ...(link.companion ? [link.companion] : []), ...link.aliases]
  for (const network of networks) {
    const row = interfaceRow(ctx, network)
    requireWanSynced(ctx, row)
    stage(s, WAN_KEY, { op: 'delete', perchId: row.perchId })
    stageZoneMembership(ctx, s, network, null)
  }
  if (link.pool) {
    const pool = rowOf(ctx, 'dhcp', link.pool)
    if (pool) {
      requireWanSynced(ctx, pool)
      stage(s, WAN_KEY, { op: 'delete', perchId: pool.perchId })
    }
  }
  if (link.deviceSection && link.device) {
    const others = (ctx.all.network?.sections ?? []).filter(
      (x) => x.type === 'interface' && !networks.includes(x.name) && uciDeviceOf(x) === link.device
    )
    const dev = rowOf(ctx, 'network', link.deviceSection)
    if (dev && others.length === 0) {
      requireWanSynced(ctx, dev)
      stage(s, WAN_KEY, { op: 'delete', perchId: dev.perchId })
    }
  }
  if (pathWanSide(ctx) && managementOf(ctx, link)) {
    throw planeError(
      409,
      'wan_management_path',
      `The controller is reached over ${link.network}.`,
      {
        network: link.network,
      }
    )
  }
  const after = topologyAfter(ctx, s)
  if (ctx.topology.uplinks.some((u) => u.enabled && u.defaultRoute) && !primaryUplink(after)) {
    throw planeError(
      409,
      'wan_last_uplink',
      `${link.network} is the last internet uplink; disable it instead.`
    )
  }
  const result = await commit(ctx, userId, s, info)
  const meta = ctx.metas.get(link.network)
  if (meta && info.apply) await meta.delete()
  return { gatewayId: ctx.gateway.id, object: null, ...result }
}

/** What still names a WAN: SQM queues, static routes, mwan3 interfaces, DDNS services. */
function referencesOf(ctx: WanContext, link: WanLink): string[] {
  const out: string[] = []
  const names = new Set([link.network, ...(link.companion ? [link.companion] : [])])
  const devices = new Set(
    [link.device, `pppoe-${link.network}`].filter((d): d is string => d !== null)
  )
  for (const q of ctx.all.sqm?.sections ?? []) {
    if (q.type === 'queue' && devices.has(scalarOption(q.options, 'interface') ?? ''))
      out.push(`sqm.${q.name}`)
  }
  for (const r of ctx.all.network?.sections ?? []) {
    if (
      (r.type === 'route' || r.type === 'route6') &&
      names.has(scalarOption(r.options, 'interface') ?? '')
    ) {
      out.push(`network.${r.name}`)
    }
  }
  for (const m of ctx.all.mwan3?.sections ?? []) {
    if (m.type === 'interface' && names.has(m.name)) out.push(`mwan3.${m.name}`)
  }
  for (const d of ctx.all.ddns?.sections ?? []) {
    if (d.type !== 'service') continue
    if (
      names.has(scalarOption(d.options, 'interface') ?? '') ||
      names.has(scalarOption(d.options, 'ip_network') ?? '')
    ) {
      out.push(`ddns.${d.name}`)
    }
  }
  return out
}

// ── aliases ───────────────────────────────────────────────────────────────

function aliasChecks(ctx: WanContext, link: WanLink, addresses: string[]) {
  const theirs = interfaceCidrs(optionsOf(interfaceRow(ctx, link.network)))
  const live = ctx.facts.interfaces?.find((i) => i.network === link.network)
  const own = [...theirs, ...(live?.ipv4 ?? [])].map((c) => `${c.split('/')[0]}/32`)
  const gw = live?.gateway4 ? [`${live.gateway4}/32`] : []
  if (cidrListsOverlap(addresses, [...own, ...gw])) {
    throw planeError(
      422,
      'wan_alias_overlaps_uplink',
      `The alias covers ${link.network}'s own address or gateway.`,
      {
        field: 'addresses',
      }
    )
  }
}

/** `POST /gateways/:id/wan/:perchId/aliases[?apply=0]`. */
export async function createAlias(
  gatewayId: number,
  userId: number,
  perchId: string,
  body: { network: string; addresses: string[]; zone?: string | null },
  info: RequestInfo
): Promise<WanWriteResult<WanAliasView>> {
  const ctx = await loadWan(gatewayId)
  requireManaged(ctx)
  const link = linkById(ctx, perchId)
  requireWanSynced(ctx, interfaceRow(ctx, link.network))
  if (!NETWORK_NAME.test(body.network)) {
    throw planeError(
      422,
      'network_name_invalid',
      'A network name is a-z, 0-9 and _, 1–15 characters.'
    )
  }
  if (ctx.all.network?.sections.some((x) => x.name === body.network)) {
    throw planeError(409, 'network_key_taken', `The name ${body.network} is taken.`)
  }
  const addresses = cidrList(body.addresses, 'addresses')
  if (addresses.length === 0)
    throw planeError(422, 'wan_static_address_invalid', 'Name at least one address.')
  aliasChecks(ctx, link, addresses)
  const s = staged()
  const device = link.device && !link.device.startsWith('@') ? link.device : `@${link.network}`
  stage(s, WAN_KEY, {
    op: 'put',
    perchId: null,
    config: 'network',
    type: 'interface',
    name: body.network,
    options: { proto: 'static', device, ipaddr: addresses },
  })
  if (body.zone) stageZoneMembership(ctx, s, body.network, body.zone)
  const result = await commit(ctx, userId, s, info)
  const after = await loadWan(gatewayId)
  return { gatewayId: ctx.gateway.id, object: aliasView(after, body.network), ...result }
}

function aliasById(ctx: WanContext, perchId: string): { row: SectionState; link: WanLink } {
  const row = ctx.states.find((s) => s.perchId === perchId && s.config === 'network')
  const host = row ? ctx.topology.aliasOf.get(row.name) : undefined
  const link = host ? ctx.topology.uplinks.find((u) => u.network === host) : undefined
  if (!row || !link) throw planeError(404, 'wan_alias_not_found', `No WAN alias ${perchId}.`)
  return { row, link }
}

/** `PATCH /gateways/:id/wan/aliases/:perchId[?apply=0]`. */
export async function updateAlias(
  gatewayId: number,
  userId: number,
  perchId: string,
  body: { addresses?: string[]; zone?: string | null },
  info: RequestInfo
): Promise<WanWriteResult<WanAliasView>> {
  const ctx = await loadWan(gatewayId)
  requireManaged(ctx)
  const { row, link } = aliasById(ctx, perchId)
  requireWanSynced(ctx, row)
  const s = staged()
  if (body.addresses !== undefined) {
    const addresses = cidrList(body.addresses, 'addresses')
    if (addresses.length === 0)
      throw planeError(422, 'wan_static_address_invalid', 'Name at least one address.')
    aliasChecks(ctx, link, addresses)
    const o = optionsOf(row)
    o.ipaddr = addresses
    delete o.netmask
    stage(s, WAN_KEY, {
      op: 'put',
      perchId: row.perchId,
      config: 'network',
      type: 'interface',
      options: o,
    })
  }
  if (body.zone !== undefined) stageZoneMembership(ctx, s, row.name, body.zone)
  const result = await commit(ctx, userId, s, info)
  return {
    gatewayId: ctx.gateway.id,
    object: aliasView(await loadWan(gatewayId), row.name),
    ...result,
  }
}

/** `DELETE /gateways/:id/wan/aliases/:perchId[?apply=0]`. */
export async function deleteAlias(
  gatewayId: number,
  userId: number,
  perchId: string,
  info: RequestInfo
): Promise<WanWriteResult<null>> {
  const ctx = await loadWan(gatewayId)
  requireManaged(ctx)
  const { row } = aliasById(ctx, perchId)
  requireWanSynced(ctx, row)
  const s = staged()
  stage(s, WAN_KEY, { op: 'delete', perchId: row.perchId })
  stageZoneMembership(ctx, s, row.name, null)
  const result = await commit(ctx, userId, s, info)
  return { gatewayId: ctx.gateway.id, object: null, ...result }
}

/** For callers that need the raw content of a WAN section (tests, the IPv6 page). */
export function wanSectionContent(row: SectionState): SectionContent | null {
  return contentOf(row) ?? row.router
}
