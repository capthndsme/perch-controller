import Collector from '#models/collector'
import Gateway from '#models/gateway'
import GatewayNetwork from '#models/gateway_network'
import GatewaySection from '#models/gateway_section'
import HotspotPriceTable from '#models/hotspot_price_table'
import Portal, { type PortalMethods, portalMethods } from '#models/portal'
import {
  type ClickThroughSettings,
  type PaymentSettings,
  normalizeClickThroughSettings,
  normalizePaymentSettings,
} from '#services/portal/hotspot'
import PortalGatewayState from '#models/portal_gateway_state'
import PortalGrant from '#models/portal_grant'
import PortalTemplate from '#models/portal_template'
import collectorHub from '#services/collector_agent_hub'
import {
  type PortalDelivery,
  type PortalPush,
  sendPortalPushes,
} from '#services/portal_agent_sender'
import {
  PortalError,
  gatewayNotFound,
  portalNotFound,
  templateNotFound,
} from '#services/portal_errors'
import { emptyPushes, endGrants, grantPushList } from '#services/portal_grants'
import { runInPortalQueue } from '#services/portal_queue'
import {
  type PortalGatewayRef,
  type PortalNetworkRef,
  type PortalView,
  iso,
  portalView,
} from '#transformers/portal'
import { firstOf } from '#services/portal_params'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * Guest portals (docs/gateway/portal.md section 11.4): several per gateway
 * (decision 19), one live portal per network. The row holds Perch's
 * application data; the router's enforcement is Perch's own (decision 27)
 * and gets everything it needs in `portal.configure`. Every change bumps
 * `revision` and hands the router a `configure` push.
 */

export type PortalInput = {
  name?: string
  networkPerchId?: string
  methods?: Partial<PortalMethods>
  /** The payment method's settings (section 14.3); merged into the stored ones. */
  payment?: Partial<PaymentSettings>
  /** The click-through method's limits (section 14.7); merged into the stored ones. */
  clickThrough?: Partial<ClickThroughSettings>
  templateId?: number | null
  cspConnectSrc?: string[]
  privacyNotice?: string | null
  force?: boolean
}

/**
 * The stored payment and click-through settings after an input: merged,
 * normalized; the payment method needs an existing price table
 * (422 `price_table_required`, 404 `price_table_not_found`).
 */
async function methodSettings(
  methods: ReturnType<typeof portalMethods>,
  current: { payment: unknown; clickThrough: unknown },
  input: PortalInput
): Promise<{ payment: PaymentSettings; clickThrough: ClickThroughSettings }> {
  const payment = normalizePaymentSettings({
    ...normalizePaymentSettings(current.payment),
    ...(input.payment ?? {}),
  })
  const clickThrough = normalizeClickThroughSettings({
    ...normalizeClickThroughSettings(current.clickThrough),
    ...(input.clickThrough ?? {}),
  })
  if (payment.priceTableId !== null) {
    const table = await HotspotPriceTable.find(payment.priceTableId)
    if (!table) {
      throw new PortalError(
        404,
        'price_table_not_found',
        `There is no price table ${payment.priceTableId}.`
      )
    }
  }
  if (methods.payment && payment.priceTableId === null) {
    throw new PortalError(
      422,
      'price_table_required',
      'The payment method needs a price table (`payment.priceTableId`).'
    )
  }
  return { payment, clickThrough }
}

export async function builtinTemplateId(): Promise<number | null> {
  const row = await PortalTemplate.query().where('builtin', true).orderBy('id').first()
  return row?.id ?? null
}

async function resolveNetwork(
  gatewayId: number,
  perchId: string
): Promise<PortalNetworkRef | null> {
  const section = await GatewaySection.query()
    .where('gateway_id', gatewayId)
    .where('config', 'network')
    .where('section_type', 'interface')
    .where('perch_id', perchId)
    .first()
  const network = await GatewayNetwork.query()
    .where('gateway_id', gatewayId)
    .where('interface_perch_id', perchId)
    .first()
  if (!section && !network) return null
  return {
    perchId,
    name: section?.sectionName ?? null,
    label: network?.label ?? null,
    purpose: network?.purpose ?? null,
  }
}

function managementNetwork(gateway: Gateway): string | null {
  return gateway.managementPath?.network ?? gateway.capabilities?.management?.network ?? null
}

/**
 * From the router's last hello (`portal_gateway_states.capabilities_at` set:
 * capable when it listed `portal`), else the config plane's capability
 * report, else unknown.
 */
function portalCapable(gateway: Gateway, state: PortalGatewayState | undefined): boolean | null {
  if (state?.capabilitiesAt) return state.capabilities !== null
  const value = gateway.capabilities?.portal
  if (value === undefined || value === null) return null
  return Boolean(value)
}

/** Views of the given portals (one query per kind, not per portal). */
export async function portalViews(portals: Portal[]): Promise<PortalView[]> {
  if (!portals.length) return []
  const gatewayIds = [...new Set(portals.map((p) => p.gatewayId))]
  const gatewayRows = await Gateway.query().whereIn('id', gatewayIds)
  const gateways = new Map(gatewayRows.map((g) => [g.id, g]))
  const collectorIds = [...gateways.values()]
    .map((g) => g.collectorId)
    .filter((id): id is number => id !== null)
  const collectors = new Map(
    (collectorIds.length ? await Collector.query().whereIn('id', collectorIds) : []).map((c) => [
      c.id,
      c,
    ])
  )
  const stateRows = await PortalGatewayState.query().whereIn('gateway_id', gatewayIds)
  const states = new Map(stateRows.map((s) => [s.gatewayId, s]))
  const perchIds = [...new Set(portals.map((p) => p.networkPerchId))]
  const sections = await GatewaySection.query()
    .whereIn('gateway_id', gatewayIds)
    .where('config', 'network')
    .where('section_type', 'interface')
    .whereIn('perch_id', perchIds)
  const networks = await GatewayNetwork.query()
    .whereIn('gateway_id', gatewayIds)
    .whereIn('interface_perch_id', perchIds)
  const counts = (await db
    .from('portal_grants')
    .whereIn(
      'portal_id',
      portals.map((p) => p.id)
    )
    .whereNot('state', 'ended')
    .groupBy('portal_id', 'state')
    .select('portal_id', 'state')
    .count('* as n')) as Array<{ portal_id: number; state: string; n: number | string }>

  return portals.map((p) => {
    const gateway = gateways.get(p.gatewayId) ?? null
    const collector = gateway?.collectorId ? (collectors.get(gateway.collectorId) ?? null) : null
    const gatewayRef: PortalGatewayRef | null = gateway
      ? {
          id: gateway.id,
          collectorId: gateway.collectorId,
          name: collector?.name ?? null,
          online: gateway.collectorId !== null && collectorHub.isOnline(gateway.collectorId),
          mode: gateway.mode,
          authoritative: Boolean(gateway.authoritative),
          portalCapable: portalCapable(gateway, states.get(gateway.id)),
        }
      : null
    const section = sections.find(
      (s) => s.gatewayId === p.gatewayId && s.perchId === p.networkPerchId
    )
    const network = networks.find(
      (n) => n.gatewayId === p.gatewayId && n.interfacePerchId === p.networkPerchId
    )
    const clients = { authenticated: 0, pending: 0, paused: 0, queued: 0 }
    for (const row of counts) {
      if (row.portal_id !== p.id) continue
      const n = Number(row.n)
      if (row.state === 'active') clients.authenticated += n
      else if (row.state === 'pending_device') clients.pending += n
      else if (row.state === 'paused') clients.paused += n
      else if (row.state === 'queued') clients.queued += n
    }
    return portalView(p, {
      gateway: gatewayRef,
      network: {
        perchId: p.networkPerchId,
        name: section?.sectionName ?? null,
        label: network?.label ?? null,
        purpose: network?.purpose ?? null,
      },
      clients,
      lastReportAt: iso(states.get(p.gatewayId)?.lastReportAt),
    })
  })
}

export async function listPortals(filter: { gatewayId?: number }): Promise<PortalView[]> {
  const query = Portal.query().whereNull('deleted_at').orderBy('id')
  if (filter.gatewayId) query.where('gateway_id', filter.gatewayId)
  return portalViews(await query)
}

/** A live (not deleted) portal, or 404 `portal_not_found`. */
export async function findPortal(id: number): Promise<Portal> {
  const portal = await Portal.query().where('id', id).whereNull('deleted_at').first()
  if (!portal) throw portalNotFound(id)
  return portal
}

export async function showPortal(id: number): Promise<PortalView> {
  const [view] = await portalViews([await findPortal(id)])
  return view
}

async function checkTemplate(templateId: number | null | undefined): Promise<void> {
  if (templateId === undefined || templateId === null) return
  const template = await PortalTemplate.find(templateId)
  if (!template) throw templateNotFound(templateId)
}

async function checkNetwork(
  gateway: Gateway,
  perchId: string,
  force: boolean,
  exceptPortalId: number | null
): Promise<void> {
  const network = await resolveNetwork(gateway.id, perchId)
  if (!network) {
    throw new PortalError(
      422,
      'network_not_found',
      `Gateway ${gateway.id} has no network ${perchId}.`,
      { networkPerchId: perchId }
    )
  }
  const taken = await Portal.query()
    .where('gateway_id', gateway.id)
    .where('network_perch_id', perchId)
    .whereNull('deleted_at')
    .if(exceptPortalId !== null, (q) => q.whereNot('id', exceptPortalId!))
    .first()
  if (taken) {
    throw new PortalError(
      409,
      'portal_exists',
      `Network ${perchId} already has portal ${taken.id}.`,
      {
        portalId: taken.id,
      }
    )
  }
  const management = managementNetwork(gateway)
  if (!force && management !== null && network.name === management) {
    throw new PortalError(
      422,
      'network_hosts_controller',
      `The gateway reaches the controller through network "${management}": a portal there would cut the controller off. Send force: true to do it anyway.`,
      { networkPerchId: perchId, network: management }
    )
  }
}

export type PortalChange = { portal: PortalView; delivery: PortalDelivery }

export async function createPortal(
  input: Required<Pick<PortalInput, 'name' | 'networkPerchId'>> &
    PortalInput & { gatewayId: number }
): Promise<PortalChange> {
  const gateway = await Gateway.find(input.gatewayId)
  if (!gateway) throw gatewayNotFound(input.gatewayId)
  await checkTemplate(input.templateId)
  const templateId = input.templateId === undefined ? await builtinTemplateId() : input.templateId

  const methods = {
    voucher: input.methods?.voucher ?? true,
    password: input.methods?.password ?? false,
    payment: input.methods?.payment ?? false,
    clickThrough: input.methods?.clickThrough ?? false,
  }
  const settings = await methodSettings(methods, { payment: null, clickThrough: null }, input)

  return runInPortalQueue(gateway.id, async () => {
    await checkNetwork(gateway, input.networkPerchId, Boolean(input.force), null)
    let portal: Portal
    try {
      portal = await Portal.create({
        gatewayId: gateway.id,
        name: input.name,
        networkPerchId: input.networkPerchId,
        methods,
        payment: settings.payment,
        clickThrough: settings.clickThrough,
        templateId,
        cspConnectSrc: input.cspConnectSrc ?? [],
        privacyNotice: input.privacyNotice ?? null,
        revision: 1,
        appliedRevision: null,
        status: null,
        deletedAt: null,
      })
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') {
        throw new PortalError(
          409,
          'portal_exists',
          `Network ${input.networkPerchId} already has a portal.`
        )
      }
      throw error
    }
    const delivery = await sendPortalPushes(gateway.id, [
      { kind: 'configure', portalId: portal.id },
      { kind: 'template', portalId: portal.id },
    ])
    return { portal: await firstOf(portalViews([portal])), delivery }
  })
}

export async function updatePortal(id: number, input: PortalInput): Promise<PortalChange> {
  const current = await findPortal(id)
  return runInPortalQueue(current.gatewayId, async () => {
    const portal = await findPortal(id)
    const gateway = await Gateway.findOrFail(portal.gatewayId)
    const pushes: PortalPush[] = []
    let changed = false
    if (input.networkPerchId !== undefined && input.networkPerchId !== portal.networkPerchId) {
      await checkNetwork(gateway, input.networkPerchId, Boolean(input.force), portal.id)
      portal.networkPerchId = input.networkPerchId
      changed = true
    }
    if (input.name !== undefined && input.name !== portal.name) {
      portal.name = input.name
      changed = true
    }
    const stored = portalMethods(portal.methods)
    const methods = {
      voucher: input.methods?.voucher ?? stored.voucher,
      password: input.methods?.password ?? stored.password,
      payment: input.methods?.payment ?? stored.payment,
      clickThrough: input.methods?.clickThrough ?? stored.clickThrough,
    }
    if (input.methods !== undefined && JSON.stringify(methods) !== JSON.stringify(stored)) {
      portal.methods = methods
      changed = true
    }
    if (
      input.methods !== undefined ||
      input.payment !== undefined ||
      input.clickThrough !== undefined
    ) {
      const settings = await methodSettings(methods, portal, input)
      if (
        JSON.stringify(settings.payment) !==
        JSON.stringify(normalizePaymentSettings(portal.payment))
      ) {
        portal.payment = settings.payment
        changed = true
      }
      if (
        JSON.stringify(settings.clickThrough) !==
        JSON.stringify(normalizeClickThroughSettings(portal.clickThrough))
      ) {
        portal.clickThrough = settings.clickThrough
        changed = true
      }
    }
    if (input.templateId !== undefined && input.templateId !== portal.templateId) {
      await checkTemplate(input.templateId)
      portal.templateId = input.templateId ?? (await builtinTemplateId())
      pushes.push({ kind: 'template', portalId: portal.id })
      changed = true
    }
    if (
      input.cspConnectSrc !== undefined &&
      JSON.stringify(input.cspConnectSrc) !== JSON.stringify(portal.cspConnectSrc ?? [])
    ) {
      portal.cspConnectSrc = input.cspConnectSrc
      changed = true
    }
    if (input.privacyNotice !== undefined && input.privacyNotice !== portal.privacyNotice) {
      portal.privacyNotice = input.privacyNotice
      changed = true
    }
    let delivery: PortalDelivery =
      portal.appliedRevision === portal.revision ? 'applied' : 'pending'
    if (changed) {
      portal.revision += 1
      await portal.save()
      delivery = await sendPortalPushes(portal.gatewayId, [
        { kind: 'configure', portalId: portal.id },
        ...pushes,
      ])
    }
    return { portal: await firstOf(portalViews([portal])), delivery }
  })
}

/**
 * Soft-deletes a portal: its history stays, its network is free for a new
 * one. Live grants block it unless `force`, which ends them (`revoked`).
 */
export async function deletePortal(id: number, force: boolean): Promise<PortalDelivery> {
  const current = await findPortal(id)
  return runInPortalQueue(current.gatewayId, async () => {
    const now = Date.now()
    const pushes = emptyPushes()
    await db.transaction(async (trx) => {
      const portal = await Portal.query({ client: trx })
        .where('id', id)
        .whereNull('deleted_at')
        .forUpdate()
        .first()
      if (!portal) throw portalNotFound(id)
      const grants = await PortalGrant.query({ client: trx })
        .where('portal_id', id)
        .whereNot('state', 'ended')
        .forUpdate()
      const live = grants.filter((g) => g.state !== 'queued').length
      if (live && !force) {
        throw new PortalError(
          409,
          'portal_active_grants',
          `Portal ${id} has ${live} device(s) online. Delete with force=1 to end their access.`,
          { activeGrants: live }
        )
      }
      await endGrants(trx, grants, 'revoked', now, pushes, { promote: false })
      portal.deletedAt = DateTime.utc()
      portal.revision += 1
      portal.useTransaction(trx)
      await portal.save()
    })
    return sendPortalPushes(current.gatewayId, [
      ...grantPushList(pushes),
      { kind: 'configure', portalId: id },
    ])
  })
}
