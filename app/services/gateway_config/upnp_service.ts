import type Gateway from '#models/gateway'
import type { GatewayApplyPostActions } from '#models/gateway_apply'
import { normalizeMac } from '#services/device_labels'
import { requestApply } from '#services/gateway_config/apply_lifecycle'
import type { SectionEdit } from '#services/gateway_config/domain'
import {
  normalizePorts,
  portRange,
  addrRange,
  shadowedRules,
  UPNP_KEY,
  UPNP_OWNED,
  UPNP_PACKAGES,
} from '#services/gateway_config/domains/upnp'
import { flagOf, scalarOption, withOptions } from '#services/gateway_config/domains/verbatim'
import { GatewayPlaneError, planeError } from '#services/gateway_config/errors'
import { recordGatewayEvent } from '#services/gateway_config/events'
import { placeInOrder, resolveDestination } from '#services/gateway_config/firewall_service'
import {
  editDomainSections,
  editSections,
  findGateway,
  setSectionOrder,
  type DomainEditBatch,
} from '#services/gateway_config/gateway_config_service'
import { normalizeMode } from '#services/gateway_config/gateway_registry'
import { loadSections } from '#services/gateway_config/gateway_store'
import {
  applyNow,
  contentOf,
  requireManaged,
  requireSynced,
  sectionsOf,
  syncOf,
  type SyncInfo,
  type WriteResult,
} from '#services/gateway_config/native_common'
import { findOrder } from '#services/gateway_config/order_store'
import { runtimeRequest } from '#services/gateway_config/runtime_rpc'
import { orderMembers, routerOrder, type OrderKey } from '#services/gateway_config/section_order'
import type { SectionState } from '#services/gateway_config/sync_engine'
import {
  configAllowed,
  hasFeature,
  packageInstalled,
  type UciOptions,
} from '#services/gateway_config/types'
import { readUpnp, type UpnpMapping } from '#services/gateway_observation_read'

/**
 * The UPnP REST layer (docs/design/gateway-sync/rest.md 8, domains.md 8,
 * owner decision D10): miniupnpd's switches and interfaces, its ordered ACL
 * (first match wins), deleting live mappings (runtime `gateway.upnp.delete`,
 * feature `upnp.delete`) and "block this device from UPnP": a deny rule for
 * the device's reserved address placed first, whose job deletes the device's
 * current mappings once it is live (a post action; earlier, the device would
 * just open them again).
 */

const ACL_KEY: OrderKey = { config: 'upnpd', type: 'perm_rule' }

export type DeviceRef = { mac: string; name: string | null }

export type UpnpAclRule = {
  id: string
  position: number | null
  action: 'allow' | 'deny'
  extPorts: string
  intAddr: string
  intPorts: string
  comment: string | null
  device: DeviceRef | null
  shadowedBy: string | null
  extra: Record<string, string | string[]>
  sync: SyncInfo
}

export type UpnpConfigView = {
  gatewayId: number
  installed: boolean
  available: boolean
  unavailableReason: 'not_installed' | 'router_access' | 'not_managed' | 'capability_missing' | null
  installPackages: string[]
  settings: {
    perchId: string
    enabled: boolean
    upnp: boolean | null
    natpmp: boolean | null
    secureMode: boolean
    internalInterfaces: string[]
    externalInterface: string | null
    extra: Record<string, string | string[]>
    sync: SyncInfo
  } | null
  acl: UpnpAclRule[]
  aclOrder: {
    status: 'in_sync' | 'ahead' | 'conflict' | 'drift'
    desired: string[]
    router: string[]
  } | null
  running: boolean | null
  mappings: UpnpMapping[]
  canDeleteMappings: boolean
}

export type UpnpConfigPatch = {
  enabled?: boolean
  upnp?: boolean
  natpmp?: boolean
  secureMode?: boolean
  internalInterfaces?: string[]
}

export type UpnpAclInput = {
  action?: 'allow' | 'deny'
  extPorts?: string
  intAddr?: string
  deviceMac?: string
  intPorts?: string
  comment?: string | null
  placement?: 'top' | 'bottom'
}

const RULE_MODELED = new Set(['action', 'ext_ports', 'int_addr', 'int_ports', 'comment'])

function flagOrNull(options: UciOptions, key: string): boolean | null {
  return options[key] === undefined ? null : flagOf(options, key, false)
}

function listOf(value: UciOptions[string] | undefined): string[] {
  if (value === undefined) return []
  return (Array.isArray(value) ? value : value.split(/\s+/)).filter(Boolean)
}

async function context(gatewayId: number) {
  const gateway = await findGateway(gatewayId)
  const { states } = await loadSections(gateway.id)
  const live =
    gateway.collectorId !== null
      ? await readUpnp(gateway.collectorId, 0)
      : { installed: null, running: null, mappings: [] as UpnpMapping[], stale: true }
  return { gateway, states, live }
}

type Ctx = Awaited<ReturnType<typeof context>>

function settingsRow(states: SectionState[]): SectionState | null {
  return sectionsOf(states, 'upnpd', ['upnpd'])[0] ?? null
}

function aclRows(states: SectionState[], desired: string[] | null): SectionState[] {
  const rows = sectionsOf(states, 'upnpd', ['perm_rule'])
  if (!desired) return rows
  const index = new Map(desired.map((id, i) => [id, i]))
  return [...rows].sort(
    (a, b) =>
      (index.get(a.perchId) ?? Number.MAX_SAFE_INTEGER) -
      (index.get(b.perchId) ?? Number.MAX_SAFE_INTEGER)
  )
}

function isInstalled(ctx: Ctx): boolean {
  const reported = packageInstalled(
    ctx.gateway.capabilities,
    ['miniupnpd-nftables', 'miniupnpd', 'miniupnpd-iptables'],
    'upnp.delete'
  )
  return reported ?? (ctx.live.installed === true || settingsRow(ctx.states) !== null)
}

function unavailable(ctx: Ctx, installed: boolean): UpnpConfigView['unavailableReason'] {
  if (normalizeMode(ctx.gateway.mode) !== 'managed') return 'not_managed'
  if (!installed) return 'not_installed'
  if (!configAllowed(ctx.gateway.capabilities, 'upnpd')) return 'router_access'
  return null
}

/** Reserved addresses → devices (a DHCP host with one MAC and an IPv4). */
function devicesByIp(states: SectionState[]): Map<string, DeviceRef> {
  const out = new Map<string, DeviceRef>()
  for (const s of sectionsOf(states, 'dhcp', ['host'])) {
    const c = contentOf(s) ?? s.router
    if (!c) continue
    const ip = scalarOption(c.options, 'ip')
    const macs = listOf(c.options.mac)
    if (ip && macs.length === 1) {
      out.set(ip, { mac: macs[0].toLowerCase(), name: scalarOption(c.options, 'name') })
    }
  }
  return out
}

async function build(ctx: Ctx): Promise<UpnpConfigView> {
  const installed = isInstalled(ctx)
  const reason = unavailable(ctx, installed)
  const row = settingsRow(ctx.states)
  const order = await findOrder(ctx.gateway.id, ACL_KEY)
  const members = orderMembers(ctx.states, ACL_KEY)
  const rows = aclRows(ctx.states, order?.desired ?? null)
  const devices = devicesByIp(ctx.states)
  const shadows = shadowedRules(
    rows.map((r) => ({ id: r.perchId, options: (contentOf(r) ?? r.router)!.options }))
  )
  const ruleOrder = order?.desired ?? routerOrder(ctx.states, ACL_KEY)
  let settings: UpnpConfigView['settings'] = null
  if (row) {
    const o = (contentOf(row) ?? row.router)!.options
    const owned = new Set<string>(UPNP_OWNED)
    settings = {
      perchId: row.perchId,
      enabled: flagOf(o, 'enabled', false),
      upnp: flagOrNull(o, 'enable_upnp'),
      natpmp: flagOrNull(o, 'enable_natpmp'),
      secureMode: flagOf(o, 'secure_mode', true),
      internalInterfaces: listOf(o.internal_iface),
      externalInterface: scalarOption(o, 'external_iface'),
      extra: Object.fromEntries(
        Object.entries(o)
          .filter(([k]) => !owned.has(k))
          .map(([k, v]) => [k, Array.isArray(v) ? [...v] : v])
      ),
      sync: syncOf(row),
    }
  }
  return {
    gatewayId: ctx.gateway.id,
    installed,
    available: reason === null,
    unavailableReason: reason,
    installPackages: installed ? [] : [...UPNP_PACKAGES],
    settings,
    acl: rows.map((r) => {
      const o = (contentOf(r) ?? r.router)!.options
      const intAddr = scalarOption(o, 'int_addr') ?? ''
      const at = ruleOrder.indexOf(r.perchId)
      return {
        id: r.perchId,
        position: at >= 0 ? at : null,
        action: scalarOption(o, 'action')?.toLowerCase() === 'deny' ? 'deny' : 'allow',
        extPorts: scalarOption(o, 'ext_ports') ?? '',
        intAddr,
        intPorts: scalarOption(o, 'int_ports') ?? '',
        comment: scalarOption(o, 'comment'),
        device: devices.get(intAddr.replace(/\/32$/, '')) ?? null,
        shadowedBy: shadows.get(r.perchId) ?? null,
        extra: Object.fromEntries(
          Object.entries(o)
            .filter(([k]) => !RULE_MODELED.has(k))
            .map(([k, v]) => [k, Array.isArray(v) ? [...v] : v])
        ),
        sync: syncOf(r),
      }
    }),
    aclOrder:
      members.length > 0 || order
        ? {
            status: order?.status ?? 'in_sync',
            desired: order?.desired ?? routerOrder(ctx.states, ACL_KEY),
            router: routerOrder(ctx.states, ACL_KEY),
          }
        : null,
    running: ctx.live.running,
    mappings: ctx.live.mappings,
    canDeleteMappings: hasFeature(ctx.gateway.capabilities, 'upnp.delete'),
  }
}

/** `GET /gateways/:id/upnp/config`. */
export async function upnpConfigView(gatewayId: number): Promise<UpnpConfigView> {
  return build(await context(gatewayId))
}

function requireWritable(ctx: Ctx) {
  requireManaged(ctx.gateway)
  if (!isInstalled(ctx)) {
    throw planeError(409, 'upnp_not_installed', 'miniupnpd is not installed on the gateway.', {
      packages: [...UPNP_PACKAGES],
    })
  }
  if (!configAllowed(ctx.gateway.capabilities, 'upnpd')) {
    throw planeError(
      409,
      'router_access_insufficient',
      'The router does not let Perch write its UPnP config (upnpd is not on its allowlist).'
    )
  }
}

const flag = (value: boolean | undefined) => (value === undefined ? undefined : value ? '1' : '0')

/** `PATCH /gateways/:id/upnp/config[?apply=0]`. */
export async function updateUpnpConfig(
  gatewayId: number,
  userId: number,
  patch: UpnpConfigPatch,
  options: { apply: boolean }
): Promise<WriteResult<UpnpConfigView>> {
  const ctx = await context(gatewayId)
  requireWritable(ctx)
  const row = settingsRow(ctx.states)
  if (!row)
    throw planeError(404, 'upnp_settings_not_found', 'The router has no UPnP settings section.')
  requireSynced(row, 'The UPnP settings')
  if (patch.internalInterfaces) {
    const networks = new Set(
      ctx.states
        .filter((s) => s.config === 'network' && (contentOf(s) ?? s.router)?.type === 'interface')
        .map((s) => s.name)
    )
    const unknown = patch.internalInterfaces.find((n) => !networks.has(n))
    if (unknown) {
      throw planeError(422, 'upnp_interface_unknown', `The router has no network "${unknown}".`, {
        network: unknown,
      })
    }
  }
  const content = contentOf(row)!
  const wasEnabled = flagOf(content.options, 'enabled', false)
  // D10: turning UPnP on also turns secure mode on, unless the request says otherwise.
  const secure =
    patch.secureMode !== undefined
      ? patch.secureMode
      : patch.enabled === true && !wasEnabled
        ? true
        : undefined
  const optionsAfter = withOptions(content.options, {
    enabled: flag(patch.enabled),
    enable_upnp: flag(patch.upnp),
    enable_natpmp: flag(patch.natpmp),
    secure_mode: flag(secure),
    internal_iface:
      patch.internalInterfaces === undefined
        ? undefined
        : patch.internalInterfaces.length === 1
          ? patch.internalInterfaces[0]
          : patch.internalInterfaces,
  })
  const outcome = await editSections(ctx.gateway.id, userId, UPNP_KEY, [
    { op: 'put', perchId: row.perchId, config: 'upnpd', type: 'upnpd', options: optionsAfter },
  ])
  const { apply, applyError } = await applyNow(ctx.gateway, userId, [row.perchId], options.apply)
  return {
    gatewayId: ctx.gateway.id,
    object: await upnpConfigView(ctx.gateway.id),
    issues: outcome.issues,
    apply,
    applyError,
  }
}

function checkRuleFields(options: UciOptions) {
  const action = scalarOption(options, 'action')
  if (action !== 'allow' && action !== 'deny') {
    throw planeError(422, 'upnp_action_invalid', 'A UPnP rule allows or denies.')
  }
  for (const key of ['ext_ports', 'int_ports']) {
    if (!portRange(scalarOption(options, key))) {
      throw planeError(
        422,
        'upnp_ports_invalid',
        'Ports are a number or a range like 1024-65535.',
        {
          field: key === 'ext_ports' ? 'extPorts' : 'intPorts',
        }
      )
    }
  }
  if (!addrRange(scalarOption(options, 'int_addr'))) {
    throw planeError(
      422,
      'upnp_addr_invalid',
      'The internal address is an IPv4 address or range like 192.168.1.0/24.'
    )
  }
}

async function ruleAddress(
  ctx: Ctx,
  input: UpnpAclInput
): Promise<{ addr: string; reservationEdits: SectionEdit[]; reservationId: string | null }> {
  if (input.deviceMac) {
    const dest = await resolveDestination(ctx.gateway, ctx.states, { deviceMac: input.deviceMac })
    return {
      addr: dest.ip,
      reservationEdits: dest.reservationEdits,
      reservationId: dest.reservationId,
    }
  }
  return { addr: (input.intAddr ?? '').trim(), reservationEdits: [], reservationId: null }
}

async function writeRule(
  ctx: Ctx,
  userId: number,
  existing: SectionState | null,
  input: UpnpAclInput,
  options: { apply: boolean; postActions?: (ruleId: string) => GatewayApplyPostActions }
): Promise<{
  id: string
  issues: WriteResult<unknown>['issues']
  apply: unknown
  applyError: WriteResult<unknown>['applyError']
}> {
  const base = existing ? contentOf(existing)!.options : {}
  const address =
    input.deviceMac !== undefined || input.intAddr !== undefined
      ? await ruleAddress(ctx, input)
      : { addr: scalarOption(base, 'int_addr') ?? '', reservationEdits: [], reservationId: null }
  const optionsAfter = withOptions(base, {
    action: input.action,
    ext_ports: input.extPorts === undefined ? undefined : normalizePorts(input.extPorts),
    int_ports: input.intPorts === undefined ? undefined : normalizePorts(input.intPorts),
    int_addr: address.addr,
    comment: input.comment === undefined ? undefined : input.comment || null,
  })
  checkRuleFields(optionsAfter)
  const batches: DomainEditBatch[] = []
  if (address.reservationEdits.length > 0) {
    batches.push({ domain: 'dhcp_hosts', edits: address.reservationEdits })
  }
  batches.push({
    domain: UPNP_KEY,
    edits: [
      {
        op: 'put',
        perchId: existing?.perchId ?? null,
        config: 'upnpd',
        type: 'perm_rule',
        options: optionsAfter,
      },
    ],
  })
  const outcome = await editDomainSections(ctx.gateway.id, userId, batches)
  const upnpBatch = outcome.batches[outcome.batches.length - 1]
  const id = existing?.perchId ?? upnpBatch.perchIds[0]
  const reservationIds = address.reservationEdits.length > 0 ? outcome.batches[0].perchIds : []
  if (!existing) {
    await placeInOrder(ctx.gateway, userId, ACL_KEY, [id], (desired) =>
      input.placement === 'top' ? 0 : desired.length
    )
  }
  const touched = [...reservationIds, id, ...(existing ? [] : await orderIds(ctx.gateway))]
  let apply: unknown = null
  let applyError: WriteResult<unknown>['applyError'] = null
  if (options.apply) {
    try {
      apply = await requestApply(ctx.gateway.id, {
        userId,
        perchIds: [...new Set(touched)],
        postActions: options.postActions?.(id),
      })
    } catch (error) {
      if (!(error instanceof GatewayPlaneError)) throw error
      applyError = { error: error.code, message: error.message }
    }
  }
  return { id, issues: outcome.issues, apply, applyError }
}

/** The ACL's members when its desired order differs from the router's (they go with the job). */
async function orderIds(gateway: Gateway): Promise<string[]> {
  const order = await findOrder(gateway.id, ACL_KEY)
  return order && order.status !== 'in_sync' ? order.desired : []
}

async function ruleView(gatewayId: number, id: string): Promise<UpnpAclRule> {
  const view = await upnpConfigView(gatewayId)
  const rule = view.acl.find((r) => r.id === id)
  if (!rule) throw planeError(404, 'upnp_rule_not_found', 'No such UPnP rule.')
  return rule
}

function findRule(ctx: Ctx, perchId: string): SectionState {
  const row = sectionsOf(ctx.states, 'upnpd', ['perm_rule']).find((r) => r.perchId === perchId)
  if (!row) throw planeError(404, 'upnp_rule_not_found', 'No such UPnP rule.')
  return row
}

/**
 * Shadow warnings from the ACL's final order (validation runs before a new
 * rule is placed): every rule an earlier opposite rule covers.
 */
async function withShadowIssues(
  gatewayId: number,
  issues: WriteResult<unknown>['issues']
): Promise<WriteResult<unknown>['issues']> {
  const view = await upnpConfigView(gatewayId)
  const out = issues.filter((i) => i.code !== 'upnp_acl_shadowed')
  for (const rule of view.acl) {
    if (!rule.shadowedBy) continue
    out.push({
      severity: 'warning',
      code: 'upnp_acl_shadowed',
      message: 'An earlier rule with the opposite action already matches everything this one does.',
      perchId: rule.id,
      config: 'upnpd',
    })
  }
  return out
}

/** `POST /gateways/:id/upnp/acl[?apply=0]`. */
export async function createUpnpRule(
  gatewayId: number,
  userId: number,
  input: UpnpAclInput,
  options: { apply: boolean }
): Promise<WriteResult<UpnpAclRule>> {
  const ctx = await context(gatewayId)
  requireWritable(ctx)
  const written = await writeRule(ctx, userId, null, input, options)
  return {
    gatewayId: ctx.gateway.id,
    object: await ruleView(ctx.gateway.id, written.id),
    issues: await withShadowIssues(ctx.gateway.id, written.issues),
    apply: written.apply,
    applyError: written.applyError,
  }
}

/** `PATCH /gateways/:id/upnp/acl/:perchId[?apply=0]`. */
export async function updateUpnpRule(
  gatewayId: number,
  userId: number,
  perchId: string,
  input: UpnpAclInput,
  options: { apply: boolean }
): Promise<WriteResult<UpnpAclRule>> {
  const ctx = await context(gatewayId)
  requireWritable(ctx)
  const row = findRule(ctx, perchId)
  requireSynced(row, 'This UPnP rule')
  const written = await writeRule(ctx, userId, row, input, options)
  return {
    gatewayId: ctx.gateway.id,
    object: await ruleView(ctx.gateway.id, written.id),
    issues: await withShadowIssues(ctx.gateway.id, written.issues),
    apply: written.apply,
    applyError: written.applyError,
  }
}

/** `DELETE /gateways/:id/upnp/acl/:perchId[?apply=0]`. */
export async function deleteUpnpRule(
  gatewayId: number,
  userId: number,
  perchId: string,
  options: { apply: boolean }
): Promise<WriteResult<null>> {
  const ctx = await context(gatewayId)
  requireWritable(ctx)
  const row = findRule(ctx, perchId)
  requireSynced(row, 'This UPnP rule')
  const outcome = await editSections(ctx.gateway.id, userId, UPNP_KEY, [
    { op: 'delete', perchId: row.perchId },
  ])
  const { apply, applyError } = await applyNow(ctx.gateway, userId, [row.perchId], options.apply)
  return { gatewayId: ctx.gateway.id, object: null, issues: outcome.issues, apply, applyError }
}

/** `PUT /gateways/:id/upnp/acl/order[?apply=0]`. */
export async function reorderUpnpAcl(
  gatewayId: number,
  userId: number,
  ids: string[],
  options: { apply: boolean }
): Promise<WriteResult<UpnpConfigView>> {
  const ctx = await context(gatewayId)
  requireWritable(ctx)
  let order
  try {
    order = await setSectionOrder(ctx.gateway.id, userId, ACL_KEY, ids)
  } catch (error) {
    if (error instanceof GatewayPlaneError && error.code === 'order_incomplete') {
      throw planeError(422, 'upnp_order_incomplete', error.message, error.data)
    }
    throw error
  }
  const { apply, applyError } = await applyNow(
    ctx.gateway,
    userId,
    order.status === 'in_sync' ? [] : order.desired,
    options.apply
  )
  return {
    gatewayId: ctx.gateway.id,
    object: await upnpConfigView(ctx.gateway.id),
    issues: [],
    apply,
    applyError,
  }
}

/** `POST /gateways/:id/upnp/mappings/delete` (runtime, no apply). */
export async function deleteUpnpMappings(
  gatewayId: number,
  userId: number,
  mappings: Array<{ proto: 'TCP' | 'UDP'; externalPort: number }>
): Promise<{ deleted: number; notFound: number; restarted: boolean }> {
  const gateway = await findGateway(gatewayId)
  const answer = await runtimeRequest<Record<string, unknown>>(
    gateway,
    'gateway.upnp.delete',
    { mappings: mappings.map((m) => ({ proto: m.proto, extPort: m.externalPort })) },
    { feature: 'upnp.delete' }
  )
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const result = {
    deleted: num(answer?.deleted),
    notFound: num(answer?.notFound),
    restarted: answer?.restarted === true,
  }
  await recordGatewayEvent(gateway.id, 'upnp_mappings_deleted', {
    userId,
    detail: { mappings: mappings.length, ...result },
  })
  return result
}

/**
 * `PUT /gateways/:id/upnp/devices/:mac[?apply=0]`: a deny rule for the
 * device's reserved address, first in the ACL (a reservation from its lease
 * joins the same job); its current mappings go once the job is live.
 * Unblocking deletes Perch's deny rule for that address.
 */
export async function setUpnpDeviceBlocked(
  gatewayId: number,
  userId: number,
  macIn: string,
  blocked: boolean,
  options: { apply: boolean }
): Promise<WriteResult<UpnpAclRule | null> & { deletedMappings: number | null }> {
  const mac = normalizeMac(macIn)
  if (!mac) throw planeError(400, 'invalid_mac', `"${macIn}" is not a MAC address.`)
  const ctx = await context(gatewayId)
  requireWritable(ctx)
  const address = await ruleAddress(ctx, { deviceMac: mac })
  const existing = sectionsOf(ctx.states, 'upnpd', ['perm_rule']).find((r) => {
    const o = (contentOf(r) ?? r.router)!.options
    const addr = (scalarOption(o, 'int_addr') ?? '').replace(/\/32$/, '')
    return r.scope === 'synced' && addr === address.addr && scalarOption(o, 'action') === 'deny'
  })
  if (!blocked) {
    if (!existing) {
      return {
        gatewayId: ctx.gateway.id,
        object: null,
        issues: [],
        apply: null,
        applyError: null,
        deletedMappings: null,
      }
    }
    const result = await deleteUpnpRule(gatewayId, userId, existing.perchId, options)
    return { ...result, deletedMappings: null }
  }
  if (existing) {
    return {
      gatewayId: ctx.gateway.id,
      object: await ruleView(ctx.gateway.id, existing.perchId),
      issues: [],
      apply: null,
      applyError: null,
      deletedMappings: null,
    }
  }
  const mappings = ctx.live.mappings
    .filter((m) => m.internalIp === address.addr || m.device?.mac === mac)
    .map((m) => ({
      proto: (m.proto.toUpperCase() === 'UDP' ? 'UDP' : 'TCP') as 'TCP' | 'UDP',
      extPort: m.externalPort,
    }))
  const written = await writeRule(
    ctx,
    userId,
    null,
    {
      action: 'deny',
      deviceMac: mac,
      extPorts: '0-65535',
      intPorts: '0-65535',
      comment: 'Blocked from UPnP (Perch)',
      placement: 'top',
    },
    {
      apply: options.apply,
      // Runs once the deny rule itself is live on the router.
      postActions: (ruleId) => ({ upnpDelete: { mac, mappings, perchIds: [ruleId] } }),
    }
  )
  return {
    gatewayId: ctx.gateway.id,
    object: await ruleView(ctx.gateway.id, written.id),
    issues: written.issues,
    apply: written.apply,
    applyError: written.applyError,
    deletedMappings: options.apply ? mappings.length : null,
  }
}
