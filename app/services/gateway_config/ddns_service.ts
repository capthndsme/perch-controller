import type Gateway from '#models/gateway'
import {
  keptSecrets,
  secretStateOf,
  secretsTravelSecurely,
  stageSecret,
  storeStagedSecrets,
  type SecretState,
  type StagedSecret,
} from '#services/gateway_config/controller_secrets'
import type { SecretEdit } from '#services/gateway_config/domain'
import {
  DDNS_KEY,
  DDNS_PACKAGES,
  serviceOf,
  type DdnsService,
  type IpSource,
} from '#services/gateway_config/domains/ddns'
import { withOptions } from '#services/gateway_config/domains/verbatim'
import { planeError } from '#services/gateway_config/errors'
import { recordGatewayEvent } from '#services/gateway_config/events'
import { editSections, findGateway } from '#services/gateway_config/gateway_config_service'
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
import { readObservedFacts } from '#services/gateway_config/observed_facts'
import { runtimeRequest } from '#services/gateway_config/runtime_rpc'
import type { SectionState } from '#services/gateway_config/sync_engine'
import { configAllowed, packageInstalled, type UciOptions } from '#services/gateway_config/types'
import type { DdnsObservation, ObservedInterface } from '#services/gateway_observation_parts'
import { readDdns } from '#services/gateway_observation_read'

/**
 * The DDNS REST layer (docs/design/gateway-sync/rest.md 9, domains.md 9):
 * ddns-scripts services on the gateway. A password travels only over
 * verified TLS (a controller-set secret); without one the router keeps its
 * own. Installing ddns-scripts is the existing package job
 * (`POST /gateways/:id/packages` with `installPackages`). "Update now" is the
 * runtime `gateway.ddns.update` (feature `ddns.update`), which restarts the
 * service's updater: it checks at once and updates when the address changed
 * or the force interval passed.
 */

export type DdnsServiceView = DdnsService & {
  id: string
  password: SecretState
  live: {
    registeredIp: string | null
    lastUpdateAt: string | null
    running: boolean
    lastError: string | null
    /** The address of the network the service reads (the interfaces observation). */
    wanIp: string | null
    /** registeredIp = wanIp; null when either is unknown. */
    matches: boolean | null
    observedAt: string
  } | null
  extra: Record<string, string | string[]>
  sync: SyncInfo
}

export type DdnsOverview = {
  gatewayId: number
  installed: boolean
  available: boolean
  unavailableReason: 'not_installed' | 'router_access' | 'not_managed' | 'capability_missing' | null
  installPackages: string[]
  providers: string[]
  secureTransport: boolean
  canUpdateNow: boolean
  services: DdnsServiceView[]
}

export type DdnsServiceInput = {
  name?: string
  enabled?: boolean
  provider?: string | null
  updateUrl?: string | null
  domain?: string
  lookupHost?: string | null
  username?: string | null
  password?: string | null
  ipSource?: 'network' | 'web'
  ipNetwork?: string | null
  useIpv6?: boolean
  useHttps?: boolean
  checkIntervalMinutes?: number
  forceIntervalHours?: number
}

/** Options the API models; everything else shows as `extra` and is kept verbatim. */
const MODELED = new Set([
  'enabled',
  'service_name',
  'update_url',
  'domain',
  'lookup_host',
  'username',
  'password',
  'ip_source',
  'ip_network',
  'ip_interface',
  'interface',
  'use_ipv6',
  'use_https',
  'check_interval',
  'check_unit',
  'force_interval',
  'force_unit',
])

const NAME = /^[A-Za-z0-9_]{1,32}$/

function isInstalled(
  gateway: Gateway,
  observed: DdnsObservation | null,
  rows: SectionState[]
): boolean {
  const reported = packageInstalled(gateway.capabilities, ['ddns-scripts'], 'ddns.update')
  return reported ?? (observed?.installed === true || rows.length > 0)
}

function unavailable(gateway: Gateway, installed: boolean): DdnsOverview['unavailableReason'] {
  if (normalizeMode(gateway.mode) !== 'managed') return 'not_managed'
  if (!installed) return 'not_installed'
  if (!configAllowed(gateway.capabilities, 'ddns')) return 'router_access'
  return null
}

/** The first IPv4 (or IPv6) address of a network, without its prefix length. */
function addressOf(
  interfaces: ObservedInterface[] | null,
  network: string | null,
  ipv6: boolean
): string | null {
  if (!interfaces || !network) return null
  const iface = interfaces.find((i) => i.network === network)
  const cidr = (ipv6 ? iface?.ipv6 : iface?.ipv4)?.[0]
  return cidr ? cidr.split('/')[0] : null
}

/** The network a new service reads by default: the default-route uplink with the lowest metric. */
function primaryUplink(
  interfaces: ObservedInterface[] | null,
  states: SectionState[]
): string | null {
  const up = (interfaces ?? [])
    .filter((i) => i.up && i.defaultRoute)
    .sort((a, b) => (a.metric ?? 0) - (b.metric ?? 0))
  if (up.length > 0) return up[0].network
  const hasWan = states.some(
    (s) =>
      s.config === 'network' && s.name === 'wan' && (contentOf(s) ?? s.router)?.type === 'interface'
  )
  return hasWan ? 'wan' : null
}

function viewOf(
  row: SectionState,
  observed: { value: DdnsObservation | null; observedAt: string | null },
  interfaces: ObservedInterface[] | null
): DdnsServiceView {
  const content = contentOf(row) ?? row.router!
  const svc = serviceOf(row.name, content.options)
  const extra: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(content.options)) {
    if (!MODELED.has(key)) extra[key] = Array.isArray(value) ? [...value] : value
  }
  const live = observed.value?.services.find((s) => s.name === row.name)
  const wanIp = addressOf(interfaces, svc.ipNetwork ?? svc.interface, svc.useIpv6)
  return {
    id: row.perchId,
    ...svc,
    password: secretStateOf(row, 'password'),
    live:
      live && observed.observedAt
        ? {
            registeredIp: live.registeredIp,
            lastUpdateAt: live.lastUpdate,
            running: live.running,
            lastError: live.lastError,
            wanIp,
            matches: live.registeredIp && wanIp ? live.registeredIp === wanIp : null,
            observedAt: observed.observedAt,
          }
        : null,
    extra,
    sync: syncOf(row),
  }
}

async function context(gatewayId: number) {
  const gateway = await findGateway(gatewayId)
  const { states } = await loadSections(gateway.id)
  const rows = sectionsOf(states, 'ddns', ['service'])
  const [observed, facts] = await Promise.all([
    gateway.collectorId !== null
      ? readDdns(gateway.collectorId)
      : Promise.resolve({ value: null, observedAt: null, stale: true }),
    readObservedFacts(gateway.collectorId),
  ])
  const fresh = observed.stale ? { value: null, observedAt: null } : observed
  return { gateway, states, rows, observed: fresh, interfaces: facts.interfaces }
}

/** `GET /gateways/:id/ddns`. */
export async function ddnsOverview(gatewayId: number): Promise<DdnsOverview> {
  const ctx = await context(gatewayId)
  const installed = isInstalled(ctx.gateway, ctx.observed.value, ctx.rows)
  const reason = unavailable(ctx.gateway, installed)
  const features = (ctx.gateway.capabilities?.features ?? []) as string[]
  return {
    gatewayId: ctx.gateway.id,
    installed,
    available: reason === null,
    unavailableReason: reason,
    installPackages: installed ? [] : [...DDNS_PACKAGES],
    providers: ctx.observed.value?.providers ?? [],
    secureTransport: await secretsTravelSecurely(ctx.gateway),
    canUpdateNow: Array.isArray(features) && features.includes('ddns.update'),
    services: ctx.rows.map((row) => viewOf(row, ctx.observed, ctx.interfaces)),
  }
}

async function serviceView(gatewayId: number, perchId: string): Promise<DdnsServiceView> {
  const ctx = await context(gatewayId)
  const row = ctx.rows.find((r) => r.perchId === perchId)
  if (!row) throw planeError(404, 'ddns_service_not_found', 'No such DDNS service.')
  return viewOf(row, ctx.observed, ctx.interfaces)
}

function requireWritable(ctx: Awaited<ReturnType<typeof context>>) {
  requireManaged(ctx.gateway)
  const installed = isInstalled(ctx.gateway, ctx.observed.value, ctx.rows)
  if (!installed) {
    throw planeError(409, 'ddns_not_installed', 'ddns-scripts is not installed on the gateway.', {
      packages: [...DDNS_PACKAGES],
    })
  }
  if (!configAllowed(ctx.gateway.capabilities, 'ddns')) {
    throw planeError(
      409,
      'router_access_insufficient',
      'The router does not let Perch write its DDNS config (ddns is not on its allowlist).'
    )
  }
}

const flag = (value: boolean | undefined) => (value === undefined ? undefined : value ? '1' : '0')

/** The options a create or patch sets (undefined = leave, null = remove). */
function optionsFor(
  input: DdnsServiceInput,
  current: DdnsService | null,
  defaults: { network: string | null }
): Record<string, string | null | undefined> {
  const set: Record<string, string | null | undefined> = {
    enabled: flag(input.enabled),
    use_ipv6: flag(input.useIpv6),
    use_https: flag(input.useHttps),
  }
  if (input.provider !== undefined) set.service_name = input.provider || null
  if (input.updateUrl !== undefined) set.update_url = input.updateUrl || null
  if (input.domain !== undefined) {
    set.domain = input.domain.trim()
    // ddns-scripts needs lookup_host to compare the published address.
    if (
      input.lookupHost === undefined &&
      (!current?.lookupHost || current.lookupHost === current.domain)
    ) {
      set.lookup_host = input.domain.trim().replace(/^.*@/, '').replace(/^\*\./, '')
    }
  }
  if (input.lookupHost !== undefined) set.lookup_host = input.lookupHost || null
  if (input.username !== undefined) set.username = input.username || null
  const source: IpSource = input.ipSource ?? current?.ipSource ?? 'network'
  if (input.ipSource !== undefined) set.ip_source = input.ipSource
  if (source === 'network') {
    const network =
      input.ipNetwork !== undefined
        ? input.ipNetwork
        : (current?.ipNetwork ?? defaults.network ?? undefined)
    if (network !== undefined) {
      set.ip_network = network
      // Update on this network's ifup as well as on the timer.
      if (current === null || input.ipNetwork !== undefined) set.interface = network
    }
  } else if (input.ipSource !== undefined) {
    set.ip_network = null
  }
  if (input.checkIntervalMinutes !== undefined) {
    set.check_interval = String(input.checkIntervalMinutes)
    set.check_unit = 'minutes'
  }
  if (input.forceIntervalHours !== undefined) {
    set.force_interval = String(input.forceIntervalHours)
    set.force_unit = 'hours'
  }
  return set
}

function checkProvider(options: UciOptions) {
  if (!options.service_name && !options.update_url) {
    throw planeError(
      422,
      'ddns_provider_required',
      'Choose a provider or enter the update URL your provider documents.'
    )
  }
}

/** `POST /gateways/:id/ddns/services[?apply=0]`. */
export async function createDdnsService(
  gatewayId: number,
  userId: number,
  input: DdnsServiceInput & { name: string; domain: string },
  options: { apply: boolean }
): Promise<WriteResult<DdnsServiceView>> {
  const ctx = await context(gatewayId)
  requireWritable(ctx)
  if (!NAME.test(input.name)) {
    throw planeError(422, 'ddns_name_invalid', 'Names are letters, digits and _ (1–32).')
  }
  const taken = sectionsOf(ctx.states, 'ddns', ['service', 'ddns']).find(
    (r) => r.name === input.name
  )
  if (taken) {
    throw planeError(409, 'ddns_service_exists', `A DDNS service named ${input.name} exists.`, {
      id: taken.perchId,
    })
  }
  const base: UciOptions = {}
  const optionsAfter = withOptions(base, {
    ...optionsFor(
      {
        enabled: true,
        useIpv6: false,
        useHttps: false,
        checkIntervalMinutes: 10,
        forceIntervalHours: 72,
        ...input,
      },
      null,
      { network: primaryUplink(ctx.interfaces, ctx.states) }
    ),
  })
  if (optionsAfter.use_https === '1' && !optionsAfter.cacert) optionsAfter.cacert = '/etc/ssl/certs'
  checkProvider(optionsAfter)
  const staged: StagedSecret[] = []
  const secrets: Record<string, SecretEdit> = {}
  if (input.password) {
    const s = await stageSecret(
      ctx.gateway,
      { config: 'ddns', section: input.name, option: 'password' },
      input.password,
      'DDNS passwords'
    )
    secrets.password = s.edit
    staged.push(s.staged)
  }
  await storeStagedSecrets(ctx.gateway.id, staged)
  const outcome = await editSections(ctx.gateway.id, userId, DDNS_KEY, [
    {
      op: 'put',
      perchId: null,
      config: 'ddns',
      type: 'service',
      name: input.name,
      options: optionsAfter,
      ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
    },
  ])
  const perchId = outcome.perchIds[0]
  const { apply, applyError } = await applyNow(ctx.gateway, userId, outcome.perchIds, options.apply)
  return {
    gatewayId: ctx.gateway.id,
    object: await serviceView(ctx.gateway.id, perchId),
    issues: outcome.issues,
    apply,
    applyError,
  }
}

function findRow(ctx: Awaited<ReturnType<typeof context>>, perchId: string): SectionState {
  const row = ctx.rows.find((r) => r.perchId === perchId)
  if (!row) throw planeError(404, 'ddns_service_not_found', 'No such DDNS service.')
  return row
}

/** `PATCH /gateways/:id/ddns/services/:perchId[?apply=0]`. */
export async function updateDdnsService(
  gatewayId: number,
  userId: number,
  perchId: string,
  input: DdnsServiceInput,
  options: { apply: boolean }
): Promise<WriteResult<DdnsServiceView>> {
  const ctx = await context(gatewayId)
  requireWritable(ctx)
  const row = findRow(ctx, perchId)
  requireSynced(row, 'This DDNS service')
  const content = contentOf(row)!
  const current = serviceOf(row.name, content.options)
  const optionsAfter = withOptions(
    content.options,
    optionsFor(input, current, { network: primaryUplink(ctx.interfaces, ctx.states) })
  )
  if (optionsAfter.use_https === '1' && !optionsAfter.cacert) optionsAfter.cacert = '/etc/ssl/certs'
  checkProvider(optionsAfter)
  const staged: StagedSecret[] = []
  const secrets = keptSecrets(row, ['password'])
  const had = content.secrets?.password
  if (input.password === null) {
    // Removed: nothing to send.
  } else if (input.password !== undefined) {
    const s = await stageSecret(
      ctx.gateway,
      { config: 'ddns', section: row.name, option: 'password' },
      input.password,
      'DDNS passwords'
    )
    secrets.password = s.edit
    staged.push(s.staged)
  } else if (had) {
    secrets.password = { keep: true }
  }
  await storeStagedSecrets(ctx.gateway.id, staged)
  const outcome = await editSections(ctx.gateway.id, userId, DDNS_KEY, [
    {
      op: 'put',
      perchId: row.perchId,
      config: 'ddns',
      type: 'service',
      options: optionsAfter,
      ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
    },
  ])
  const { apply, applyError } = await applyNow(ctx.gateway, userId, [row.perchId], options.apply)
  return {
    gatewayId: ctx.gateway.id,
    object: await serviceView(ctx.gateway.id, row.perchId),
    issues: outcome.issues,
    apply,
    applyError,
  }
}

/** `DELETE /gateways/:id/ddns/services/:perchId[?apply=0]`. */
export async function deleteDdnsService(
  gatewayId: number,
  userId: number,
  perchId: string,
  options: { apply: boolean }
): Promise<WriteResult<null>> {
  const ctx = await context(gatewayId)
  requireWritable(ctx)
  const row = findRow(ctx, perchId)
  requireSynced(row, 'This DDNS service')
  const outcome = await editSections(ctx.gateway.id, userId, DDNS_KEY, [
    { op: 'delete', perchId: row.perchId },
  ])
  const { apply, applyError } = await applyNow(ctx.gateway, userId, [row.perchId], options.apply)
  return { gatewayId: ctx.gateway.id, object: null, issues: outcome.issues, apply, applyError }
}

/** `POST /gateways/:id/ddns/services/:perchId/update-now` (runtime, no apply). */
export async function ddnsUpdateNow(
  gatewayId: number,
  userId: number,
  perchId: string
): Promise<{ started: boolean }> {
  const ctx = await context(gatewayId)
  const row = findRow(ctx, perchId)
  const answer = await runtimeRequest<{ started?: unknown }>(
    ctx.gateway,
    'gateway.ddns.update',
    { service: row.name },
    { feature: 'ddns.update' }
  )
  await recordGatewayEvent(ctx.gateway.id, 'ddns_update_requested', {
    userId,
    detail: { service: row.name, perchId: row.perchId },
  })
  return { started: answer?.started !== false }
}
