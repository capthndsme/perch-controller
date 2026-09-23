import type Gateway from '#models/gateway'
import { lanNetworks } from '#services/gateway_config/apply_lifecycle'
import {
  managementPathPrefix,
  prefixText,
  ROUTE_KINDS,
  routeFacts,
  ROUTES_DOMAIN_KEY,
  routesDomain,
  routeStealsPath,
  type RouteFacts,
} from '#services/gateway_config/domains/routes'
import {
  isIpAddress,
  parsePrefix,
  prefixContains,
  scalarOption,
  withOptions,
  type VerbatimSection,
} from '#services/gateway_config/domains/verbatim'
import { planeError } from '#services/gateway_config/errors'
import { editSections, findGateway } from '#services/gateway_config/gateway_config_service'
import { loadSections } from '#services/gateway_config/gateway_store'
import {
  applyNow,
  asSynced,
  contentOf,
  requireManaged,
  requireSynced,
  sectionsOf,
  syncOf,
  type SyncInfo,
  type WriteResult,
} from '#services/gateway_config/native_common'
import { readObservedFacts, type ObservedFacts } from '#services/gateway_config/observed_facts'
import type { SectionState } from '#services/gateway_config/sync_engine'
import type { UciOptions } from '#services/gateway_config/types'

/**
 * Routing on the managed gateway (plan 2 sections 4.4 and 5;
 * docs/gateway/native-sync.md section 4): static routes observed and
 * managed; policy rules, mwan3 and pbr shown read-only (decision 12).
 */

export type RouteView = {
  id: string
  family: 4 | 6
  interface: string | null
  target: string | null
  gateway: string | null
  metric: number | null
  table: string | null
  type: string
  enabled: boolean
  /** The route covers the controller's address (its apply is protected). */
  managementPath: boolean
  /** Whether the kernel has it: not reported by the agent yet (null). */
  installed: boolean | null
  /** Options the page does not model (`mtu`, `onlink`, `source`, …), verbatim. */
  extra: UciOptions
  sync: SyncInfo
}

export type PolicyRuleView = {
  id: string
  family: 4 | 6
  section: string
  options: UciOptions
  priority: number | null
  lookup: string | null
}

export type RoutingView = {
  gatewayId: number
  routes: RouteView[]
  policyRules: PolicyRuleView[]
  /** Network interfaces a route can leave by (every `interface` section). */
  interfaces: Array<{ name: string; up: boolean | null; lan: boolean }>
  management: { network: string | null; controllerAddress: string | null }
  mwan3: {
    /** The router's mwan3 config sections, as read (null = not installed or not allowlisted). */
    config: Array<{ id: string; section: string; type: string; options: UciOptions }> | null
    /** mwan3's live status (observation channel). */
    observed: ObservedFacts['mwan3']
  }
  pbr: { config: Array<{ id: string; section: string; type: string; options: UciOptions }> | null }
}

const ROUTE_OWNED_KEYS = new Set([
  'interface',
  'target',
  'netmask',
  'gateway',
  'metric',
  'table',
  'type',
  'disabled',
])

function routeView(s: SectionState, pathAddress: string | null): RouteView {
  const c = contentOf(s)!
  const facts = routeFacts(c.type, c.options)
  const extra: UciOptions = {}
  for (const [k, v] of Object.entries(c.options)) {
    if (!ROUTE_OWNED_KEYS.has(k)) extra[k] = v
  }
  const covers = pathAddress !== null && facts.prefix !== null && pathCovers(facts, pathAddress)
  return {
    id: s.perchId,
    family: facts.family,
    interface: facts.interface,
    target: prefixText(facts.prefix) ?? scalarOption(c.options, 'target'),
    gateway: facts.gateway,
    metric: facts.metric,
    table: facts.table,
    type: facts.kind,
    enabled: facts.enabled,
    managementPath: covers,
    installed: null,
    extra,
    sync: syncOf(s),
  }
}

function pathCovers(facts: RouteFacts, address: string): boolean {
  return facts.prefix !== null && prefixContains(facts.prefix, address)
}

function configSections(states: SectionState[], config: string) {
  const rows = states.filter((s) => s.config === config && s.router !== null)
  if (rows.length === 0) return null
  return rows.map((s) => ({
    id: s.perchId,
    section: s.name,
    type: s.router!.type,
    options: s.router!.options,
  }))
}

export function routingView(
  gateway: Gateway,
  states: SectionState[],
  facts: ObservedFacts
): RoutingView {
  const pathAddress = gateway.managementPath?.controllerAddress ?? null
  const lan = new Set(lanNetworks(states).map((n) => n.name))
  const observed = new Map((facts.interfaces ?? []).map((i) => [i.network, i.up]))
  return {
    gatewayId: gateway.id,
    routes: sectionsOf(states, 'network', ['route', 'route6']).map((s) =>
      routeView(s, pathAddress && isIpAddress(pathAddress) ? pathAddress : null)
    ),
    policyRules: sectionsOf(states, 'network', ['rule', 'rule6']).map((s) => {
      const o = contentOf(s)!.options
      const priority = scalarOption(o, 'priority')
      return {
        id: s.perchId,
        family: contentOf(s)!.type === 'rule6' ? 6 : 4,
        section: s.name,
        options: o,
        priority: priority && /^\d+$/.test(priority) ? Number(priority) : null,
        lookup: scalarOption(o, 'lookup'),
      }
    }),
    interfaces: sectionsOf(states, 'network', ['interface'])
      .filter((s) => s.name !== 'loopback')
      .map((s) => ({ name: s.name, up: observed.get(s.name) ?? null, lan: lan.has(s.name) })),
    management: {
      network: gateway.managementPath?.network ?? null,
      controllerAddress: pathAddress,
    },
    mwan3: { config: configSections(states, 'mwan3'), observed: facts.mwan3 },
    pbr: { config: configSections(states, 'pbr') },
  }
}

/** `GET /gateways/:id/routing`. */
export async function routingOverview(gatewayId: number): Promise<RoutingView> {
  const gateway = await findGateway(gatewayId)
  const { states } = await loadSections(gateway.id)
  return routingView(gateway, states, await readObservedFacts(gateway.collectorId))
}

export type RouteInput = {
  family?: 4 | 6
  interface?: string | null
  target?: string
  gateway?: string | null
  metric?: number | null
  table?: string | null
  type?: string
  enabled?: boolean
  apply?: boolean
}

/**
 * The management-path guard of a route edit (plan 2 section 4.4): 422
 * `routing_controller_path` when the route (as it would be) takes the
 * traffic to the controller away from the path the agent uses today.
 */
export function checkRoutePath(
  gateway: Gateway,
  states: SectionState[],
  facts: RouteFacts,
  exceptId: string | null
) {
  const path = gateway.managementPath
  const address = path?.controllerAddress ?? null
  if (!path || !address || !isIpAddress(address)) return
  const others = sectionsOf(states, 'network', ['route', 'route6'])
    .filter((s) => s.perchId !== exceptId)
    .map((s) => routeFacts(contentOf(s)!.type, contentOf(s)!.options))
  const pathPrefix = managementPathPrefix(path, lanNetworks(states), others)
  if (routeStealsPath(facts, { network: path.network, controllerAddress: address, pathPrefix })) {
    throw planeError(
      422,
      'routing_controller_path',
      `This route covers the controller (${address}) and would take the gateway agent's path away from ${path.network ?? path.device}.`,
      { controllerAddress: address, managementNetwork: path.network }
    )
  }
}

function routeOptions(base: UciOptions, input: RouteInput, family: 4 | 6): UciOptions {
  const set: Record<string, string | null | undefined> = {}
  if (input.interface !== undefined) set.interface = input.interface || null
  if (input.target !== undefined) {
    const prefix = parsePrefix(input.target)
    if (!prefix || prefix.family !== family) {
      throw planeError(
        422,
        'routing_target_invalid',
        `"${input.target}" is not an IPv${family} prefix.`
      )
    }
    set.target = `${prefix.address}/${prefix.prefix}`
    set.netmask = null
  }
  if (input.gateway !== undefined) {
    if (
      input.gateway &&
      !(isIpAddress(input.gateway) && parsePrefix(input.gateway)!.family === family)
    ) {
      throw planeError(
        422,
        'routing_gateway_invalid',
        `"${input.gateway}" is not an IPv${family} address.`
      )
    }
    set.gateway = input.gateway || null
  }
  if (input.metric !== undefined) set.metric = input.metric === null ? null : String(input.metric)
  if (input.table !== undefined) set.table = input.table || null
  if (input.type !== undefined) {
    if (!(ROUTE_KINDS as readonly string[]).includes(input.type)) {
      throw planeError(422, 'routing_type_invalid', `"${input.type}" is not a route type.`)
    }
    set.type = input.type === 'unicast' ? null : input.type
  }
  if (input.enabled !== undefined) set.disabled = input.enabled ? null : '1'
  return withOptions(base, set)
}

function checkInterface(states: SectionState[], name: string | null | undefined) {
  if (name === undefined || name === null) return
  const known = sectionsOf(states, 'network', ['interface']).some((s) => s.name === name)
  if (!known) {
    throw planeError(422, 'routing_interface_unknown', `The router has no interface "${name}".`)
  }
}

async function writeRoute(
  gatewayId: number,
  userId: number,
  perchId: string | null,
  input: RouteInput
): Promise<WriteResult<RouteView | null>> {
  const gateway = await findGateway(gatewayId)
  requireManaged(gateway)
  const { states } = await loadSections(gateway.id)
  const existing = perchId
    ? sectionsOf(states, 'network', ['route', 'route6']).find((s) => s.perchId === perchId)
    : null
  if (perchId && !existing) throw planeError(404, 'routing_route_not_found', `No route ${perchId}.`)
  if (existing) requireSynced(existing, 'This route')
  const type = existing ? contentOf(existing)!.type : input.family === 6 ? 'route6' : 'route'
  const family: 4 | 6 = type === 'route6' ? 6 : 4
  if (!existing && !input.target) {
    throw planeError(422, 'routing_target_invalid', 'A route needs its target.')
  }
  if (
    !existing &&
    !input.interface &&
    !['unreachable', 'prohibit', 'blackhole', 'throw'].includes(input.type ?? '')
  ) {
    throw planeError(422, 'routing_interface_required', 'Pick the interface the route leaves by.')
  }
  checkInterface(states, input.interface)
  const options = routeOptions(existing ? contentOf(existing)!.options : {}, input, family)
  checkRoutePath(gateway, states, routeFacts(type, options), existing?.perchId ?? null)
  const obj: VerbatimSection = existing
    ? { ...routesDomain.parse(asSynced(existing))[0], options }
    : { perchId: null, section: '', type, options, secretNames: [] }
  const outcome = await editSections(
    gateway.id,
    userId,
    ROUTES_DOMAIN_KEY,
    routesDomain.render(obj, existing ? asSynced(existing) : [])
  )
  const id = existing?.perchId ?? outcome.perchIds[0]
  const { apply, applyError } = await applyNow(gateway, userId, [id], input.apply !== false)
  const { states: after } = await loadSections(gateway.id)
  const row = after.find((s) => s.perchId === id)
  const pathAddress = gateway.managementPath?.controllerAddress ?? null
  return {
    gatewayId: gateway.id,
    object:
      row && contentOf(row)
        ? routeView(row, pathAddress && isIpAddress(pathAddress) ? pathAddress : null)
        : null,
    issues: outcome.issues,
    apply,
    applyError,
  }
}

export function createRoute(gatewayId: number, userId: number, input: RouteInput) {
  return writeRoute(gatewayId, userId, null, input)
}

export function updateRoute(gatewayId: number, userId: number, perchId: string, input: RouteInput) {
  return writeRoute(gatewayId, userId, perchId, input)
}

/** `DELETE /gateways/:id/routing/routes/:perchId`. */
export async function deleteRoute(
  gatewayId: number,
  userId: number,
  perchId: string,
  input: { apply?: boolean } = {}
): Promise<WriteResult<null>> {
  const gateway = await findGateway(gatewayId)
  requireManaged(gateway)
  const { states } = await loadSections(gateway.id)
  const row = sectionsOf(states, 'network', ['route', 'route6']).find((s) => s.perchId === perchId)
  if (!row) throw planeError(404, 'routing_route_not_found', `No route ${perchId}.`)
  requireSynced(row, 'This route')
  // Dropping a route the path runs on is a path change too.
  const facts = routeFacts(contentOf(row)!.type, contentOf(row)!.options)
  const path = gateway.managementPath
  if (
    path?.controllerAddress &&
    isIpAddress(path.controllerAddress) &&
    facts.enabled &&
    facts.interface === path.network &&
    facts.prefix &&
    pathCovers(facts, path.controllerAddress)
  ) {
    const lan = lanNetworks(states).find((n) => n.name === path.network)
    const onLink = (lan?.ipv4 ?? []).some((c) => {
      const p = parsePrefix(c)
      return p !== null && prefixContains(p, path.controllerAddress!)
    })
    if (!onLink) {
      throw planeError(
        422,
        'routing_controller_path',
        `The gateway agent reaches the controller (${path.controllerAddress}) through this route.`
      )
    }
  }
  const outcome = await editSections(gateway.id, userId, ROUTES_DOMAIN_KEY, [
    { op: 'delete', perchId },
  ])
  const { apply, applyError } = await applyNow(
    gateway,
    userId,
    outcome.deleted.includes(perchId) ? [] : [perchId],
    input.apply !== false
  )
  return { gatewayId: gateway.id, object: null, issues: outcome.issues, apply, applyError }
}
