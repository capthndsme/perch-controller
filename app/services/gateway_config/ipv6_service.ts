import { itemsOf } from '#services/gateway_config/canonical'
import type { SectionEdit } from '#services/gateway_config/domain'
import {
  DHCP_POOL_IPV6_OPTIONS,
  IPV6_MODES,
  NDP_MODES,
  RA_FLAGS,
} from '#services/gateway_config/domains/dhcp_pools'
import { NETWORK_GLOBALS_KEY, ulaProblem } from '#services/gateway_config/domains/network_globals'
import {
  flagOf,
  parsePrefix,
  prefixContains,
  scalarOption,
  withOptions,
} from '#services/gateway_config/domains/verbatim'
import { planeError } from '#services/gateway_config/errors'
import {
  editDomainSections,
  findGateway,
  type DomainEditBatch,
} from '#services/gateway_config/gateway_config_service'
import { loadSections } from '#services/gateway_config/gateway_store'
import {
  applyNow,
  contentOf,
  gatewayDisplayName,
  requireManaged,
  requireSynced,
  sectionsOf,
  syncOf,
  widenOwnership,
  type SyncInfo,
  type WriteResult,
} from '#services/gateway_config/native_common'
import { readObservedFacts } from '#services/gateway_config/observed_facts'
import type { SectionState } from '#services/gateway_config/sync_engine'
import type { UciOptions } from '#services/gateway_config/types'
import { wanOverview, type WanView } from '#services/gateway_config/wan_service'
import { randomBytes } from 'node:crypto'

/**
 * The IPv6 REST layer (docs/design/gateway-sync/rest.md 5, domains.md 7): no
 * new write path. The ULA is the `globals` section's `ula_prefix`
 * (`network_globals`); each LAN's prefix assignment lives on its interface
 * (`networks`: `ip6assign ip6hint ip6class ip6ifaceid`), its RA / DHCPv6 / NDP
 * on its pool (`dhcp_pools`, which takes those options over on the first IPv6
 * edit, `widenOwnership`). The upstream (the WAN's DHCPv6 companion, relay on
 * the WAN-side pool) is edited on the WAN page; this overview shows it with
 * the delegated prefixes the router reports. `dhcp.odhcpd` stays the router's
 * (shown read only).
 */

export type Ipv6Mode = (typeof IPV6_MODES)[number]

export type Ipv6Lan = {
  network: string
  poolPerchId: string | null
  ip6assign: number | null
  ip6hint: string | null
  ip6class: string[]
  ip6ifaceid: string | null
  assigned: string[]
  ra: Ipv6Mode | null
  dhcpv6: Ipv6Mode | null
  ndp: 'relay' | 'hybrid' | 'disabled' | null
  raFlags: string[]
  raSlaac: boolean | null
  dns: string[]
  raDefault: number | null
  management: boolean
  /** `perch` once the pool owns its IPv6 options; `router` until the first IPv6 edit here. */
  ownership: 'perch' | 'router'
  sync: SyncInfo | null
}

export type Ipv6Overview = {
  gatewayId: number
  ula: { prefix: string | null; perchId: string | null; sync: SyncInfo | null }
  upstream: Array<{
    wan: string
    companion: string | null
    mode: WanView['ipv6']['mode']
    delegated: Array<{ prefix: string; preferredUntil: string | null; validUntil: string | null }>
    addresses: string[]
  }>
  lans: Ipv6Lan[]
  odhcpd: {
    perchId: string | null
    maindhcp: boolean | null
    running: boolean | null
    options: Record<string, string | string[]>
  }
  leases6: number
  observedAt: string | null
}

export type Ipv6LanPatch = {
  ip6assign?: number | null
  ip6hint?: string | null
  ip6class?: string[]
  ra?: Ipv6Mode | null
  dhcpv6?: Ipv6Mode | null
  ndp?: 'relay' | 'hybrid' | 'disabled' | null
  raFlags?: string[]
  raSlaac?: boolean
  dns?: string[]
  confirm?: string
}

function optionsOf(row: SectionState): UciOptions {
  return (contentOf(row) ?? row.router)!.options
}

function num(value: string | null): number | null {
  return value !== null && /^\d+$/.test(value.trim()) ? Number(value) : null
}

function words(value: UciOptions[string] | undefined): string[] {
  return itemsOf(value)
    .flatMap((v) => v.split(/\s+/))
    .filter(Boolean)
}

async function context(gatewayId: number) {
  const gateway = await findGateway(gatewayId)
  const { states } = await loadSections(gateway.id)
  const facts = await readObservedFacts(gateway.collectorId)
  return { gateway, states, facts }
}

type Ctx = Awaited<ReturnType<typeof context>>

function globalsRow(states: SectionState[]): SectionState | null {
  return sectionsOf(states, 'network', ['globals'])[0] ?? null
}

/** LAN-side networks: those whose pool the `dhcp_pools` domain claims. */
function lanPools(states: SectionState[]): Array<{ network: string; pool: SectionState }> {
  return sectionsOf(states, 'dhcp', ['dhcp'])
    .filter((s) => s.domain === 'dhcp_pools')
    .map((pool) => ({ network: scalarOption(optionsOf(pool), 'interface') ?? '', pool }))
    .filter((x) => x.network !== '')
}

function interfaceRow(states: SectionState[], network: string): SectionState | null {
  return sectionsOf(states, 'network', ['interface']).find((s) => s.name === network) ?? null
}

function lanView(ctx: Ctx, network: string, pool: SectionState | null): Ipv6Lan {
  const iface = interfaceRow(ctx.states, network)
  const io = iface ? optionsOf(iface) : {}
  const po = pool ? optionsOf(pool) : {}
  const mode = (v: string | null) =>
    v !== null && (IPV6_MODES as readonly string[]).includes(v) ? (v as Ipv6Mode) : null
  const ndp = scalarOption(po, 'ndp')
  const owned =
    pool?.ownership?.kind === 'options'
      ? pool.ownership.options.includes('ra')
      : pool?.ownership === null
  return {
    network,
    poolPerchId: pool?.perchId ?? null,
    ip6assign: num(scalarOption(io, 'ip6assign')),
    ip6hint: scalarOption(io, 'ip6hint'),
    ip6class: words(io.ip6class),
    ip6ifaceid: scalarOption(io, 'ip6ifaceid'),
    assigned: ctx.facts.interfaces?.find((i) => i.network === network)?.ipv6Assigned ?? [],
    ra: mode(scalarOption(po, 'ra')),
    dhcpv6: mode(scalarOption(po, 'dhcpv6')),
    ndp:
      ndp !== null && (NDP_MODES as readonly string[]).includes(ndp)
        ? (ndp as Ipv6Lan['ndp'])
        : null,
    raFlags: words(po.ra_flags),
    raSlaac: po.ra_slaac === undefined ? null : flagOf(po, 'ra_slaac', true),
    dns: words(po.dns),
    raDefault: num(scalarOption(po, 'ra_default')),
    management: ctx.gateway.managementPath?.network === network,
    ownership: owned ? 'perch' : 'router',
    sync: pool ? syncOf(pool) : null,
  }
}

/** `GET /gateways/:id/ipv6`. */
export async function ipv6Overview(gatewayId: number): Promise<Ipv6Overview> {
  const ctx = await context(gatewayId)
  const globals = globalsRow(ctx.states)
  const wan = await wanOverview(gatewayId).catch(() => null)
  const odhcpd = sectionsOf(ctx.states, 'dhcp', ['odhcpd'])[0] ?? null
  const odhcpdOptions = odhcpd ? optionsOf(odhcpd) : {}
  const live = ctx.facts.interfaces ?? []
  return {
    gatewayId: ctx.gateway.id,
    ula: {
      prefix: globals ? scalarOption(optionsOf(globals), 'ula_prefix') : null,
      perchId: globals?.perchId ?? null,
      sync: globals ? syncOf(globals) : null,
    },
    upstream: (wan?.uplinks ?? []).map((w) => {
      const companionRow = w.ipv6.companion
        ? ctx.states.find((s) => s.perchId === w.ipv6.companion)
        : null
      const names = [w.network, ...(companionRow ? [companionRow.name] : [])]
      const obs = live.filter((i) => names.includes(i.network))
      return {
        wan: w.network,
        companion: companionRow?.name ?? null,
        mode: w.ipv6.mode,
        delegated: obs.flatMap((i) => i.ipv6Prefixes),
        addresses: obs.flatMap((i) => i.ipv6),
      }
    }),
    lans: lanPools(ctx.states).map(({ network, pool }) => lanView(ctx, network, pool)),
    odhcpd: {
      perchId: odhcpd?.perchId ?? null,
      maindhcp:
        odhcpdOptions.maindhcp === undefined ? null : flagOf(odhcpdOptions, 'maindhcp', false),
      running: null,
      options: Object.fromEntries(
        Object.entries(odhcpdOptions).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v])
      ),
    },
    leases6: 0,
    observedAt: ctx.facts.observedAt.interfaces ?? null,
  }
}

/** A random ULA /48 (RFC 4193: fd + 40 random bits). */
export function randomUla(): string {
  const b = randomBytes(5)
  const hex = (n: number) => n.toString(16).padStart(2, '0')
  return `fd${hex(b[0])}:${hex(b[1])}${hex(b[2])}:${hex(b[3])}${hex(b[4])}::/48`
}

/** `PATCH /gateways/:id/ipv6[?apply=0]` `{ ula, confirm? }`. */
export async function updateIpv6(
  gatewayId: number,
  userId: number,
  input: { ula: string | null | 'generate'; confirm?: string },
  options: { apply: boolean }
): Promise<WriteResult<Ipv6Overview>> {
  const ctx = await context(gatewayId)
  requireManaged(ctx.gateway)
  const row = globalsRow(ctx.states)
  if (!row)
    throw planeError(404, 'ipv6_globals_not_found', 'The router has no network globals section.')
  requireSynced(row, 'The IPv6 settings')
  const ula = input.ula === 'generate' ? randomUla() : input.ula
  if (ula !== null) {
    const problem = ulaProblem(ula)
    if (problem) throw planeError(422, 'ipv6_ula_invalid', problem)
  }
  const current = scalarOption(optionsOf(row), 'ula_prefix')
  const path = ctx.gateway.managementPath?.controllerAddress
  const currentPrefix = current ? parsePrefix(current) : null
  if (
    path &&
    currentPrefix?.family === 6 &&
    prefixContains(currentPrefix, path) &&
    ula !== current
  ) {
    const name = await gatewayDisplayName(ctx.gateway)
    if (input.confirm?.trim() !== name) {
      throw planeError(
        409,
        'ipv6_management_path',
        `The controller reaches the router over the current ULA: type the gateway's name (${name}) to renumber it.`,
        { confirm: name }
      )
    }
  }
  const outcome = await editDomainSections(ctx.gateway.id, userId, [
    {
      domain: NETWORK_GLOBALS_KEY,
      edits: [
        {
          op: 'put',
          perchId: row.perchId,
          config: 'network',
          type: 'globals',
          options: withOptions(contentOf(row)!.options, { ula_prefix: ula }),
        },
      ],
    },
  ])
  const { apply, applyError } = await applyNow(ctx.gateway, userId, [row.perchId], options.apply)
  return {
    gatewayId: ctx.gateway.id,
    object: await ipv6Overview(ctx.gateway.id),
    issues: outcome.issues,
    apply,
    applyError,
  }
}

function checkLanPatch(patch: Ipv6LanPatch) {
  if (patch.ip6assign !== undefined && patch.ip6assign !== null) {
    if (patch.ip6assign !== 0 && (patch.ip6assign < 48 || patch.ip6assign > 64)) {
      throw planeError(
        422,
        'ipv6_assign_invalid',
        'ip6assign is 0 (none) or a prefix length from 48 to 64.'
      )
    }
  }
  if (
    patch.ip6hint !== undefined &&
    patch.ip6hint !== null &&
    !/^[0-9a-f]{1,4}$/i.test(patch.ip6hint)
  ) {
    throw planeError(422, 'ipv6_hint_invalid', 'ip6hint is up to four hex digits (the subnet id).')
  }
  for (const c of patch.ip6class ?? []) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(c)) {
      throw planeError(
        422,
        'ipv6_class_unknown',
        `"${c}" is not a prefix class (an upstream name or "local").`
      )
    }
  }
  for (const [key, value] of [
    ['ra', patch.ra],
    ['dhcpv6', patch.dhcpv6],
  ] as const) {
    if (
      value !== undefined &&
      value !== null &&
      !(IPV6_MODES as readonly string[]).includes(value)
    ) {
      throw planeError(422, 'ipv6_mode_invalid', `${key} is server, relay, hybrid or disabled.`)
    }
  }
  if (
    patch.ndp !== undefined &&
    patch.ndp !== null &&
    !(NDP_MODES as readonly string[]).includes(patch.ndp)
  ) {
    throw planeError(422, 'ipv6_mode_invalid', 'ndp is relay, hybrid or disabled.')
  }
  if (patch.raFlags?.some((f) => !(RA_FLAGS as readonly string[]).includes(f))) {
    throw planeError(
      422,
      'ipv6_ra_flags_invalid',
      'RA flags are managed-config, other-config, home-agent or none.'
    )
  }
  for (const d of patch.dns ?? []) {
    const p = parsePrefix(d)
    if (!p || p.family !== 6 || d.includes('/')) {
      throw planeError(422, 'ipv6_dns_invalid', `"${d}" is not an IPv6 address.`)
    }
  }
}

/** `PATCH /gateways/:id/ipv6/lans/:network[?apply=0]`. */
export async function updateIpv6Lan(
  gatewayId: number,
  userId: number,
  network: string,
  patch: Ipv6LanPatch,
  options: { apply: boolean; requestIp?: string | null }
): Promise<WriteResult<Ipv6Lan>> {
  const ctx = await context(gatewayId)
  requireManaged(ctx.gateway)
  const lan = lanPools(ctx.states).find((x) => x.network === network)
  const iface = interfaceRow(ctx.states, network)
  if (!lan || !iface) throw planeError(404, 'network_not_found', `No LAN network "${network}".`)
  checkLanPatch(patch)
  const poolChange = (['ra', 'dhcpv6', 'ndp', 'raFlags', 'raSlaac', 'dns'] as const).some(
    (k) => patch[k] !== undefined
  )
  const ifaceChange = (['ip6assign', 'ip6hint', 'ip6class'] as const).some(
    (k) => patch[k] !== undefined
  )
  if (poolChange && lan.pool.scope !== 'synced') {
    throw planeError(
      409,
      'dhcp_pool_not_managed',
      `The DHCP pool of ${network} is the router's; include it first.`
    )
  }
  if (ifaceChange) requireSynced(iface, `The network ${network}`)
  // Turning RA/DHCPv6 off on the network this request came from over IPv6 cuts the admin off.
  const fromHere =
    options.requestIp?.includes(':') &&
    (ctx.facts.interfaces?.find((i) => i.network === network)?.ipv6 ?? []).some((cidr) => {
      const p = parsePrefix(cidr)
      return p !== null && prefixContains(p, options.requestIp!.replace(/^::ffff:/, ''))
    })
  const turnsOff = patch.ra === 'disabled' || patch.dhcpv6 === 'disabled'
  if (fromHere && turnsOff && patch.confirm?.trim() !== network) {
    throw planeError(
      409,
      'ipv6_admin_path',
      `You are connected over IPv6 on ${network}: type its name to turn RA or DHCPv6 off there.`,
      { confirm: network }
    )
  }
  const batches: DomainEditBatch[] = []
  if (poolChange) {
    await widenOwnership(ctx.gateway.id, lan.pool.perchId, DHCP_POOL_IPV6_OPTIONS)
    const po = contentOf(lan.pool)!.options
    const edit: SectionEdit = {
      op: 'put',
      perchId: lan.pool.perchId,
      config: 'dhcp',
      type: 'dhcp',
      options: withOptions(po, {
        ra: patch.ra,
        dhcpv6: patch.dhcpv6,
        ndp: patch.ndp,
        ra_flags: patch.raFlags,
        ra_slaac: patch.raSlaac === undefined ? undefined : patch.raSlaac ? '1' : '0',
        dns: patch.dns,
      }),
    }
    batches.push({ domain: 'dhcp_pools', edits: [edit] })
  }
  if (ifaceChange) {
    const io = contentOf(iface)!.options
    batches.push({
      domain: iface.domain ?? 'networks',
      edits: [
        {
          op: 'put',
          perchId: iface.perchId,
          config: 'network',
          type: 'interface',
          options: withOptions(io, {
            ip6assign:
              patch.ip6assign === undefined
                ? undefined
                : patch.ip6assign === null
                  ? null
                  : String(patch.ip6assign),
            ip6hint: patch.ip6hint,
            ip6class: patch.ip6class,
          }),
        },
      ],
    })
  }
  if (batches.length === 0) {
    return {
      gatewayId: ctx.gateway.id,
      object: lanView(ctx, network, lan.pool),
      issues: [],
      apply: null,
      applyError: null,
    }
  }
  const outcome = await editDomainSections(ctx.gateway.id, userId, batches)
  const touched = [...new Set(outcome.batches.flatMap((b) => b.perchIds))]
  const { apply, applyError } = await applyNow(ctx.gateway, userId, touched, options.apply)
  const after = await context(gatewayId)
  const pool = lanPools(after.states).find((x) => x.network === network)?.pool ?? null
  return {
    gatewayId: ctx.gateway.id,
    object: lanView(after, network, pool),
    issues: outcome.issues,
    apply,
    applyError,
  }
}
