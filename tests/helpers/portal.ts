import Collector from '#models/collector'
import Gateway from '#models/gateway'
import GatewayNetwork from '#models/gateway_network'
import GatewaySection from '#models/gateway_section'
import Portal from '#models/portal'
import PortalGrant from '#models/portal_grant'
import PortalTemplate from '#models/portal_template'
import User from '#models/user'
import Voucher from '#models/voucher'
import VoucherBatch from '#models/voucher_batch'
import { OutboxPortalAgentSender, setPortalAgentSender } from '#services/portal_agent_sender'
import { createApiClient } from '#services/portal_api_clients'
import { _resetPortalApiRateLimits } from '#services/portal_api_rate_limit'
import { hashVoucherCode } from '#services/portal_keys'
import { EMPTY_SET_SHA256 } from '#services/portal/templates'
import { voucherHint } from '#services/portal/codes'
import { seedSetupComplete } from '#tests/helpers/ap_agent'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import type { ApiClient } from '@japa/api-client'
import { DateTime } from 'luxon'

/**
 * Seeds for the guest portal REST suites (docs/gateway/portal.md section
 * 11): a finished setup (admin, operator, viewer tokens), one gateway with a
 * `lan` network (the management path) and a `guest` network, the builtin
 * template row (truncation removes the migration's seed).
 */

export const MAC_A = '02:00:00:00:aa:01'
export const MAC_B = '02:00:00:00:aa:02'
export const GUEST_NET = 'n_guest'
export const IOT_NET = 'n_iot'
export const LAN_NET = 'n_lan'

export async function resetPortalTests() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  _resetPortalApiRateLimits()
  setPortalAgentSender(new OutboxPortalAgentSender())
  return teardown
}

export type PortalWorld = {
  adminToken: string
  operatorToken: string
  viewerToken: string
  adminId: number
  gatewayId: number
  builtinTemplateId: number
}

export async function seedPortalWorld(): Promise<PortalWorld> {
  const setup = await seedSetupComplete()
  const viewer = await User.create({
    fullName: 'Viewer',
    email: 'viewer@example.com',
    password: 'viewer-pass-123',
    role: 'viewer',
  })
  const viewerAccess = await User.accessTokens.create(viewer)
  const viewerToken = viewerAccess.value!.release()
  const template = await PortalTemplate.create({
    name: 'Perch default',
    builtin: true,
    sha256: EMPTY_SET_SHA256,
    totalBytes: 0,
    createdByUserId: null,
  })
  const collector = await Collector.create({
    name: 'gateway',
    baseUrl: null,
    pollIntervalSeconds: 5,
    enabled: true,
    lifecycle: 'adopted',
    source: 'announced',
  } as Partial<Collector>)
  const gateway = await Gateway.create({
    collectorId: collector.id,
    mode: 'managed',
    managementPath: { network: 'lan', device: 'br-lan' },
  })
  for (const [perchId, name] of [
    [LAN_NET, 'lan'],
    [GUEST_NET, 'guest'],
    [IOT_NET, 'iot'],
  ]) {
    await GatewaySection.create({
      gatewayId: gateway.id,
      perchId,
      config: 'network',
      sectionName: name,
      sectionType: 'interface',
      anonymous: false,
      scope: 'synced',
      domain: 'networks',
      status: 'in_sync',
    } as Partial<GatewaySection>)
  }
  await GatewayNetwork.create({
    gatewayId: gateway.id,
    interfacePerchId: GUEST_NET,
    label: 'Guests',
    purpose: 'guest',
    capture: false,
  })
  return {
    ...setup,
    viewerToken,
    gatewayId: gateway.id,
    builtinTemplateId: template.id,
  }
}

export async function seedPortal(
  gatewayId: number,
  network = GUEST_NET,
  patch: Partial<Portal> = {}
): Promise<Portal> {
  return Portal.create({
    gatewayId,
    name: `Portal ${network}`,
    networkPerchId: network,
    methods: { voucher: true, password: false },
    cspConnectSrc: [],
    ...patch,
  })
}

/** A voucher with a known code (`K7Q2M9XH4D` style), in a batch of one. */
export async function seedVoucher(
  portalId: number | null,
  code: string,
  batchPatch: Partial<VoucherBatch> = {},
  voucherPatch: Partial<Voucher> = {}
): Promise<{ batch: VoucherBatch; voucher: Voucher }> {
  const batch = await VoucherBatch.create({
    portalId,
    name: 'Seeded',
    count: 1,
    codeLength: code.length,
    durationMinutes: 60,
    durationMode: 'wall_clock',
    startMode: 'first_use',
    maxDevices: 1,
    ...batchPatch,
  })
  const voucher = new Voucher()
  voucher.fill({
    batchId: batch.id,
    hint: voucherHint(code),
    boundPortalId: null,
    timeUsedSeconds: 0,
    bytesUsed: 0,
    revision: 1,
    ...voucherPatch,
  })
  voucher.codeHash = hashVoucherCode(code)!
  voucher.code = code
  await voucher.save()
  return { batch, voucher }
}

/** A grant row as reconciliation would have left it. */
export async function seedGrant(
  patch: Partial<PortalGrant> & { portalId: number }
): Promise<PortalGrant> {
  const grant = await PortalGrant.create({
    mac: MAC_A,
    source: 'admin',
    groupKey: 'g:0',
    durationMode: 'wall_clock',
    state: 'active',
    delivery: 'applied',
    revision: 1,
    timeUsedSeconds: 0,
    bytesUp: 0,
    bytesDown: 0,
    startedAt: DateTime.utc().minus({ minutes: 5 }),
    ...patch,
  })
  if (grant.groupKey === 'g:0') {
    grant.groupKey = `g:${grant.id}`
    await grant.save()
  }
  return grant
}

export async function seedApiClient(
  portalIds: number[],
  scopes: Array<'authorize' | 'read'> = ['authorize', 'read'],
  caps: { maxMinutesPerCall?: number; maxBytesPerCall?: number; maxActiveGrants?: number } = {}
): Promise<{ id: number; token: string }> {
  const { client, token } = await createApiClient(
    { name: 'Coin box', portalIds, scopes, ...caps },
    null
  )
  return { id: client.id, token }
}

export type OutboxRow = {
  kind: string
  dedupe_key: string
  portal_id: number | null
  grant_ids: number[]
}

export async function outbox(gatewayId: number): Promise<OutboxRow[]> {
  const rows = await db.from('portal_outbox').where('gateway_id', gatewayId).orderBy('id')
  return rows.map((r) => ({
    kind: r.kind,
    dedupe_key: r.dedupe_key,
    portal_id: r.portal_id,
    grant_ids: r.grant_ids ? JSON.parse(r.grant_ids) : [],
  }))
}

export async function outboxKinds(gatewayId: number): Promise<string[]> {
  const rows = await outbox(gatewayId)
  return rows.map((r) => r.kind)
}

export async function outboxKeys(gatewayId: number): Promise<string[]> {
  const rows = await outbox(gatewayId)
  return rows.map((r) => r.dedupe_key)
}

export async function outboxPairs(gatewayId: number): Promise<Array<[string, number[]]>> {
  const rows = await outbox(gatewayId)
  return rows.map((r) => [r.kind, r.grant_ids])
}

/** Grant ids of the gateway's first outbox row. */
export async function outboxFirstIds(gatewayId: number): Promise<number[]> {
  const [first] = await outbox(gatewayId)
  return first?.grant_ids ?? []
}

export async function clearOutbox(): Promise<void> {
  await db.from('portal_outbox').delete()
}

type Method = 'get' | 'post' | 'patch' | 'delete' | 'put'

export function call(client: ApiClient, method: Method, path: string, token?: string) {
  const request = client[method](path)
  return token ? request.bearerToken(token) : request
}

/** Response bodies are untyped JSON. */
export function bodyOf(response: { body(): unknown }): any {
  return response.body()
}
