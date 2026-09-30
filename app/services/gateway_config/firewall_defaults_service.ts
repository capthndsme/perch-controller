import {
  defaultsOf,
  DEFAULT_POLICIES,
  FIREWALL_DEFAULTS_KEY,
  FIREWALL_DEFAULTS_OWNED,
  OFFLOADING_WARNING,
} from '#services/gateway_config/domains/firewall_defaults'
import { withOptions } from '#services/gateway_config/domains/verbatim'
import { planeError } from '#services/gateway_config/errors'
import { editSections, findGateway } from '#services/gateway_config/gateway_config_service'
import { loadSections } from '#services/gateway_config/gateway_store'
import {
  applyNow,
  contentOf,
  gatewayDisplayName,
  requireManaged,
  requireSynced,
  sectionsOf,
  syncOf,
  type SyncInfo,
  type WriteResult,
} from '#services/gateway_config/native_common'
import { readObservedFacts } from '#services/gateway_config/observed_facts'
import type { SectionState } from '#services/gateway_config/sync_engine'

/**
 * The firewall `defaults` REST layer (docs/design/gateway-sync/rest.md 7,
 * domains.md 5, owner decision D7). The section is always planned in the
 * protected job (the management-path rule for firewall `defaults`), so a
 * change applies with the longer confirm window. REJECT or DROP on `input`
 * or `output` needs the gateway's name typed (`confirm`): it can cut the
 * router off from its own LAN services.
 */

export type FirewallDefaultsView = {
  perchId: string
  input: string | null
  output: string | null
  forward: string | null
  synfloodProtect: boolean
  dropInvalid: boolean
  flowOffloading: boolean
  flowOffloadingHw: boolean
  /** What the router runs (the `system` observation); null when not reported or stale. */
  live: { flowOffloading: boolean | null; flowOffloadingHw: boolean | null } | null
  /** "Perch cannot count offloaded traffic" while hardware offloading is on (D7). */
  collectorWarning: string | null
  /** Router-owned options, read only. */
  extra: Record<string, string | string[]>
  sync: SyncInfo
}

export type FirewallDefaultsPatch = {
  input?: string
  output?: string
  forward?: string
  synfloodProtect?: boolean
  dropInvalid?: boolean
  flowOffloading?: boolean
  flowOffloadingHw?: boolean
  /** The gateway's name: confirms REJECT/DROP on input or output. */
  confirm?: string
}

/** The `defaults` section the page shows: the first one (a second is ambiguous). */
function defaultsRow(states: SectionState[]): SectionState | null {
  return sectionsOf(states, 'firewall', ['defaults'])[0] ?? null
}

function viewOf(row: SectionState, live: FirewallDefaultsView['live']): FirewallDefaultsView {
  const content = contentOf(row) ?? row.router!
  const d = defaultsOf(content.options)
  const owned = new Set<string>(FIREWALL_DEFAULTS_OWNED)
  const extra: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(content.options)) {
    if (!owned.has(key)) extra[key] = Array.isArray(value) ? [...value] : value
  }
  return {
    perchId: row.perchId,
    ...d,
    live,
    collectorWarning: d.flowOffloadingHw || live?.flowOffloadingHw ? OFFLOADING_WARNING : null,
    extra,
    sync: syncOf(row),
  }
}

/** `GET /gateways/:id/firewall/defaults`. */
export async function firewallDefaultsView(gatewayId: number): Promise<FirewallDefaultsView> {
  const gateway = await findGateway(gatewayId)
  const { states } = await loadSections(gateway.id)
  const row = defaultsRow(states)
  if (!row) {
    throw planeError(404, 'firewall_defaults_not_found', 'The router has no firewall defaults.')
  }
  const facts = await readObservedFacts(gateway.collectorId)
  const live = facts.system
    ? {
        flowOffloading: facts.system.flowOffloading,
        flowOffloadingHw: facts.system.flowOffloadingHw,
      }
    : null
  return viewOf(row, live)
}

function policy(value: string | undefined, option: string): string | undefined {
  if (value === undefined) return undefined
  const text = value.trim().toUpperCase()
  if (!(DEFAULT_POLICIES as readonly string[]).includes(text)) {
    throw planeError(
      422,
      'firewall_policy_invalid',
      `The ${option} policy must be ACCEPT, REJECT or DROP.`,
      {
        option,
      }
    )
  }
  return text
}

const flag = (value: boolean | undefined) => (value === undefined ? undefined : value ? '1' : '0')

/** `PATCH /gateways/:id/firewall/defaults[?apply=0]`. */
export async function updateFirewallDefaults(
  gatewayId: number,
  userId: number,
  patch: FirewallDefaultsPatch,
  options: { apply: boolean }
): Promise<WriteResult<FirewallDefaultsView>> {
  const gateway = await findGateway(gatewayId)
  requireManaged(gateway)
  const { states } = await loadSections(gateway.id)
  const row = defaultsRow(states)
  if (!row) {
    throw planeError(404, 'firewall_defaults_not_found', 'The router has no firewall defaults.')
  }
  requireSynced(row, 'The firewall defaults')
  const next = {
    input: policy(patch.input, 'input'),
    output: policy(patch.output, 'output'),
    forward: policy(patch.forward, 'forward'),
  }
  const content = contentOf(row)!
  const current = defaultsOf(content.options)
  const closes = (['input', 'output'] as const).some(
    (k) => next[k] !== undefined && next[k] !== 'ACCEPT' && next[k] !== current[k]
  )
  if (closes) {
    const name = await gatewayDisplayName(gateway)
    if (patch.confirm === undefined) {
      throw planeError(
        409,
        'firewall_defaults_confirm_required',
        `Type the gateway's name (${name}) to set REJECT or DROP on input or output.`,
        { confirm: name }
      )
    }
    if (patch.confirm.trim() !== name) {
      throw planeError(422, 'confirm_mismatch', `Type the gateway's name (${name}) exactly.`)
    }
  }
  const optionsAfter = withOptions(content.options, {
    input: next.input,
    output: next.output,
    forward: next.forward,
    synflood_protect: flag(patch.synfloodProtect),
    drop_invalid: flag(patch.dropInvalid),
    flow_offloading: flag(patch.flowOffloading),
    flow_offloading_hw: flag(patch.flowOffloadingHw),
  })
  const outcome = await editSections(gateway.id, userId, FIREWALL_DEFAULTS_KEY, [
    {
      op: 'put',
      perchId: row.perchId,
      config: 'firewall',
      type: 'defaults',
      options: optionsAfter,
    },
  ])
  const { apply, applyError } = await applyNow(gateway, userId, [row.perchId], options.apply)
  return {
    gatewayId: gateway.id,
    object: await firewallDefaultsView(gateway.id),
    issues: outcome.issues,
    apply,
    applyError,
  }
}
