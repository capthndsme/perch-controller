import type Gateway from '#models/gateway'
import GatewaySection from '#models/gateway_section'
import { requestApply } from '#services/gateway_config/apply_lifecycle'
import type { SyncedSection } from '#services/gateway_config/domain'
import { GatewayPlaneError, planeError } from '#services/gateway_config/errors'
import { normalizeMode } from '#services/gateway_config/gateway_registry'
import type { ObservedFacts } from '#services/gateway_config/observed_facts'
import type { SectionState } from '#services/gateway_config/sync_engine'
import type { Issue, SectionContent } from '#services/gateway_config/types'
import env from '#start/env'
import { isIP } from 'node:net'

/**
 * Shared pieces of the native-sync REST layer (docs/gateway/native-sync.md,
 * plan 2 phase 4: DHCP options and tags, DNS settings, routes, system).
 * Every write goes into the draft through `editSections` and, unless
 * `?apply=0`, straight into an apply of the touched sections; the response
 * carries the apply or why it did not start (`applyError`).
 */

/** Per-object sync info (plan 2 section 5 `SyncInfo`, the firewall's shape). */
export type SyncInfo = {
  perchId: string
  section: string
  owner: 'perch' | 'router'
  scope: SectionState['scope']
  issue: SectionState['issue']
  status: SectionState['status']
  applied: boolean
  conflict: boolean
  driftSince: string | null
}

export type WriteResult<T> = {
  gatewayId: number
  object: T
  issues: Issue[]
  apply: unknown | null
  applyError: { error: string; message: string } | null
}

export function syncOf(s: SectionState): SyncInfo {
  return {
    perchId: s.perchId,
    section: s.name,
    owner: s.scope === 'synced' ? 'perch' : 'router',
    scope: s.scope,
    issue: s.issue,
    status: s.status,
    applied: s.router !== null && s.status === 'in_sync',
    conflict: s.conflict !== null,
    driftSince: s.driftSince,
  }
}

/** What a page shows for a section: C for synced sections, else the router's. */
export function contentOf(s: SectionState): SectionContent | null {
  return s.scope === 'synced' ? (s.desired ?? s.router) : s.router
}

export function asSynced(s: SectionState): SyncedSection[] {
  const c = contentOf(s)
  return c
    ? [
        {
          perchId: s.perchId,
          config: s.config,
          name: s.name,
          type: c.type,
          anonymous: s.anonymous,
          options: c.options,
          ...(c.secrets ? { secrets: c.secrets } : {}),
        },
      ]
    : []
}

/** Sections of a config and type the page shows (a draft delete keeps showing until applied). */
export function sectionsOf(
  states: SectionState[],
  config: string,
  types: string[]
): SectionState[] {
  return states
    .filter((s) => {
      const c = contentOf(s) ?? s.router
      return s.config === config && c !== null && types.includes(c.type)
    })
    .sort(
      (a, b) =>
        (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) ||
        a.perchId.localeCompare(b.perchId)
    )
}

export function requireManaged(gateway: Gateway) {
  if (normalizeMode(gateway.mode) !== 'managed') {
    throw planeError(409, 'not_managed', 'The gateway is not in managed mode.')
  }
}

export function requireSynced(s: SectionState, what = 'This section') {
  if (s.scope !== 'synced') {
    throw planeError(409, 'not_synced', `${what} is the router’s; include it first.`, {
      perchId: s.perchId,
      issue: s.issue,
    })
  }
}

export async function applyNow(
  gateway: Gateway,
  userId: number,
  perchIds: string[],
  wanted: boolean
): Promise<{ apply: unknown | null; applyError: WriteResult<unknown>['applyError'] }> {
  if (!wanted || perchIds.length === 0) return { apply: null, applyError: null }
  try {
    const apply = await requestApply(gateway.id, { userId, perchIds })
    return { apply, applyError: null }
  } catch (error) {
    if (error instanceof GatewayPlaneError) {
      return { apply: null, applyError: { error: error.code, message: error.message } }
    }
    throw error
  }
}

/**
 * Adds options to a synced row's option-level ownership (a row claimed
 * before its domain owned them, e.g. `dhcp_hosts` `tag`): without this the
 * merge would keep taking the router's value for them and the edit would be
 * lost. Only ever widens; item ownership is kept.
 */
export async function widenOwnership(
  gatewayId: number,
  perchId: string,
  options: readonly string[]
): Promise<void> {
  const row = await GatewaySection.query()
    .where('gateway_id', gatewayId)
    .where('perch_id', perchId)
    .first()
  const ownership = row?.ownership
  if (!row || !ownership || ownership.kind !== 'options') return
  const missing = options.filter((o) => !ownership.options.includes(o))
  if (missing.length === 0) return
  row.ownership = { ...ownership, options: [...ownership.options, ...missing] }
  await row.save()
}

// ── the controller's own name (plan 2 section 4.2 "Controller name pin") ──

/**
 * The name and addresses the gateway agents reach the controller by: the
 * resolver observation's `controllerHost` (the name the agent dials, as the
 * router resolves it), else the host of `APP_URL`, with the management
 * path's controller address.
 */
export function controllerHostOf(
  gateway: Gateway,
  facts: ObservedFacts
): { name: string | null; addresses: string[]; error: string | null; source: string } {
  const observed = facts.resolver?.controllerHost ?? null
  const pathAddress = gateway.managementPath?.controllerAddress ?? null
  if (observed?.name) {
    return {
      name: observed.name.toLowerCase(),
      addresses: observed.addresses,
      error: observed.error,
      source: 'resolver',
    }
  }
  let name: string | null = null
  try {
    const host = new URL(env.get('APP_URL')).hostname
    if (host && isIP(host.replace(/^\[|\]$/g, '')) === 0) name = host.toLowerCase()
  } catch {
    // no usable APP_URL
  }
  return {
    name,
    addresses: pathAddress && isIP(pathAddress) ? [pathAddress] : [],
    error: null,
    source: name ? 'app_url' : 'none',
  }
}

/**
 * Names the router's dnsmasq answers from its own records: `domain` records,
 * and host names with the local domain appended (dnsmasq `expandhosts`).
 */
export function localDnsNames(states: SectionState[], localDomain: string | null): string[] {
  const out = new Set<string>()
  const domain = localDomain?.replace(/^\/|\/$/g, '').toLowerCase() || null
  for (const s of states) {
    const c = contentOf(s)
    if (s.config !== 'dhcp' || !c) continue
    const add = (name: unknown) => {
      if (typeof name !== 'string' || name.length === 0) return
      const n = name.toLowerCase()
      out.add(n)
      if (domain && !n.includes('.')) out.add(`${n}.${domain}`)
    }
    if (c.type === 'domain') add(c.options.name)
    if (c.type === 'cname') add(c.options.cname)
    if (c.type === 'host') add(c.options.name)
  }
  return [...out]
}
