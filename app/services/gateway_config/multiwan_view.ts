import type Gateway from '#models/gateway'
import { itemsOf } from '#services/gateway_config/canonical'
import { findGateway } from '#services/gateway_config/gateway_config_service'
import { loadSections } from '#services/gateway_config/gateway_store'
import { readObservedFacts } from '#services/gateway_config/observed_facts'
import type { SectionState } from '#services/gateway_config/sync_engine'
import type { UciOptions, UciValue } from '#services/gateway_config/types'
import type { Mwan3Observation } from '#services/gateway_observation_parts'

/**
 * Multi-WAN, read only (docs/design/gateway-sync/rest.md 10, domains.md 10
 * "Profiles"; work package B7a). Owner decision 12 stands (answered again
 * 2026-09-30): mwan3 and pbr are shown, never written. This explains the
 * router's mwan3 config as a profile:
 *
 * - `balance`: the members of the default rule's policy share the lowest
 *   metric (traffic is spread over them, not failed over);
 * - `failover`: one member at the lowest metric, the rest at strictly
 *   increasing metrics;
 * - `custom`: anything else (tiers that share a metric below the top, no
 *   rule for all traffic, or rules that send traffic to another policy).
 *
 * Rules that use the default rule's policy (a sticky HTTPS/QUIC rule on the
 * live gateway) keep the profile and are listed. The config comes from the
 * plane's mirrors of `mwan3` (readable once the collector joins it read
 * only); the live status from the `mwan3` observation.
 */

export type Extra = Record<string, string | string[]>

export type MultiwanProfile = {
  kind: 'failover' | 'balance' | 'custom'
  /** The default rule's policy (null: no rule sends all traffic through mwan3). */
  policy: string | null
  members: Array<{ wan: string; metric: number; weight: number }>
  tracking: {
    targets: string[]
    reliability: number
    count: number
    timeout: number
    interval: number
    down: number
    up: number
  } | null
  lastResort: 'unreachable' | 'blackhole' | 'default' | null
  /** Rules beyond the default rule, in evaluation order. */
  rules: Array<{ name: string; summary: string; policy: string; sticky: boolean }>
  notes: string[]
}

export type MultiwanConfigSection = {
  perchId: string
  section: string
  type: string
  options: Extra
}

export type MultiwanView = {
  gatewayId: number
  package: 'mwan3' | 'pbr' | null
  installed: boolean
  service: { enabled: boolean | null; running: boolean | null }
  writable: boolean
  writeBlockedReason:
    | 'owner_decision_12'
    | 'router_read_only'
    | 'capability_missing'
    | 'not_installed'
    | null
  profile: MultiwanProfile | null
  config: MultiwanConfigSection[] | null
  live: Mwan3Observation | null
  pbr: { installed: boolean; config: MultiwanConfigSection[] | null }
}

/** A section as the profile reads it. */
export type Mwan3Section = { name: string; type: string; options: UciOptions }

// mwan3's own defaults (/etc/config/mwan3 documentation, mwan3 2.11).
const TRACK_DEFAULTS = { reliability: 1, count: 1, timeout: 4, interval: 10, down: 5, up: 5 }

function scalar(options: UciOptions, key: string): string | null {
  const value = options[key]
  if (value === undefined) return null
  return Array.isArray(value) ? value.join(' ') : value
}

function num(options: UciOptions, key: string, fallback: number): number {
  const value = Number(scalar(options, key))
  return Number.isFinite(value) && scalar(options, key) !== null ? value : fallback
}

function words(value: UciValue | undefined): string[] {
  return itemsOf(value)
    .flatMap((v) => v.split(/\s+/))
    .filter((v) => v.length > 0)
}

function flag(options: UciOptions, key: string, fallback: boolean): boolean {
  const value = scalar(options, key)?.trim().toLowerCase()
  if (value === undefined || value === null) return fallback
  return ['1', 'true', 'yes', 'on'].includes(value)
}

/** A rule that matches all traffic (no address, port or protocol narrowing). */
function matchesAll(options: UciOptions): boolean {
  const dest = scalar(options, 'dest_ip')
  const src = scalar(options, 'src_ip')
  const proto = scalar(options, 'proto')?.toLowerCase() ?? 'all'
  const everywhere = (v: string | null) => v === null || v === '0.0.0.0/0' || v === '::/0'
  return (
    everywhere(dest) &&
    everywhere(src) &&
    proto === 'all' &&
    scalar(options, 'dest_port') === null &&
    scalar(options, 'src_port') === null &&
    scalar(options, 'ipset') === null
  )
}

function ruleSummary(options: UciOptions, policy: string, sticky: boolean): string {
  const proto = words(options.proto).join('/') || 'all'
  const parts = [proto]
  const destPort = scalar(options, 'dest_port')
  if (destPort) parts.push(`dest port ${destPort}`)
  const destIp = scalar(options, 'dest_ip')
  if (destIp && destIp !== '0.0.0.0/0' && destIp !== '::/0') parts.push(`to ${destIp}`)
  const srcIp = scalar(options, 'src_ip')
  if (srcIp) parts.push(`from ${srcIp}`)
  return `${parts.join(' ')} → ${policy}${sticky ? ' (sticky)' : ''}`
}

/**
 * The profile of an mwan3 config (pure). Null when there is nothing to
 * explain (no member or policy at all).
 */
export function multiwanProfile(sections: Mwan3Section[]): MultiwanProfile | null {
  const interfaces = new Map(
    sections.filter((s) => s.type === 'interface').map((s) => [s.name, s.options])
  )
  const members = new Map(
    sections
      .filter((s) => s.type === 'member')
      .map((s) => [
        s.name,
        {
          wan: scalar(s.options, 'interface') ?? '',
          metric: num(s.options, 'metric', 1),
          weight: num(s.options, 'weight', 1),
        },
      ])
  )
  const policies = new Map(
    sections.filter((s) => s.type === 'policy').map((s) => [s.name, s.options])
  )
  if (members.size === 0 && policies.size === 0) return null
  const rules = sections.filter((s) => s.type === 'rule')
  const notes: string[] = []

  const defaultRule = rules.find((r) => matchesAll(r.options)) ?? null
  const policy = defaultRule ? scalar(defaultRule.options, 'use_policy') : null
  const policyOptions = policy ? (policies.get(policy) ?? null) : null
  const chosen = policyOptions
    ? words(policyOptions.use_member)
        .map((name) => members.get(name))
        .filter((m): m is NonNullable<typeof m> => m !== undefined && m.wan !== '')
    : []

  let kind: MultiwanProfile['kind'] = 'custom'
  // By metric; ties keep the policy's member order.
  const sorted = [...chosen].sort((a, b) => a.metric - b.metric)
  if (!defaultRule) {
    notes.push('No rule sends all traffic through mwan3: only the listed rules are balanced.')
  } else if (!policyOptions) {
    notes.push(
      policy === 'default'
        ? 'The default rule uses the main routing table (policy "default").'
        : `The default rule names policy "${policy ?? ''}", which does not exist.`
    )
  } else if (sorted.length > 0) {
    const lowest = sorted[0].metric
    const top = sorted.filter((m) => m.metric === lowest)
    const rest = sorted.filter((m) => m.metric !== lowest)
    const restMetrics = rest.map((m) => m.metric)
    const strictly = restMetrics.every((m, i) => i === 0 || m > restMetrics[i - 1])
    if (top.length > 1 && strictly) {
      kind = 'balance'
      notes.push(
        `${top.map((m) => m.wan).join(' and ')} share metric ${lowest}: traffic is balanced, not failed over.`
      )
    } else if (top.length === 1 && strictly) {
      kind = 'failover'
      if (sorted.length === 1)
        notes.push(`Only ${sorted[0].wan} is in policy ${policy}: nothing to fail over to.`)
    } else {
      notes.push(
        'Several failover tiers share a metric: the policy is neither a plain failover nor a plain balance.'
      )
    }
  }

  // Rules beyond the default rule; one that sends traffic elsewhere makes it custom.
  const extraRules: MultiwanProfile['rules'] = []
  for (const rule of rules) {
    if (rule === defaultRule) continue
    const rulePolicy = scalar(rule.options, 'use_policy') ?? ''
    const sticky = flag(rule.options, 'sticky', false)
    extraRules.push({
      name: scalar(rule.options, 'name') ?? rule.name,
      summary: ruleSummary(rule.options, rulePolicy, sticky),
      policy: rulePolicy,
      sticky,
    })
    if (rulePolicy !== policy) {
      if (kind !== 'custom') {
        notes.push(
          `Rule ${scalar(rule.options, 'name') ?? rule.name} sends traffic to policy ${rulePolicy}.`
        )
      }
      kind = 'custom'
    }
  }

  // Members and policies nothing uses.
  const used = new Set(chosen.map((m) => m.wan))
  for (const [name, member] of members) {
    const inPolicy = policyOptions ? words(policyOptions.use_member).includes(name) : false
    if (!inPolicy && member.wan && !used.has(member.wan)) {
      notes.push(
        `${member.wan} (metric ${member.metric}) is configured but not in the default policy.`
      )
    }
  }
  const usedPolicies = new Set(rules.map((r) => scalar(r.options, 'use_policy')))
  for (const name of policies.keys()) {
    if (!usedPolicies.has(name)) notes.push(`Policy ${name} is not used by any rule.`)
  }
  for (const m of chosen) {
    const iface = interfaces.get(m.wan)
    if (!iface) notes.push(`${m.wan} has no mwan3 interface section: mwan3 ignores it.`)
    else if (!flag(iface, 'enabled', true)) notes.push(`${m.wan} is disabled in mwan3.`)
  }

  // Tracking of the policy's WANs (the first one's; a note when they differ).
  let tracking: MultiwanProfile['tracking'] = null
  const tracked = chosen
    .map((m) => interfaces.get(m.wan))
    .filter((o): o is UciOptions => o !== undefined)
  if (tracked.length > 0) {
    const of = (o: UciOptions) => ({
      targets: words(o.track_ip),
      reliability: num(o, 'reliability', TRACK_DEFAULTS.reliability),
      count: num(o, 'count', TRACK_DEFAULTS.count),
      timeout: num(o, 'timeout', TRACK_DEFAULTS.timeout),
      interval: num(o, 'interval', TRACK_DEFAULTS.interval),
      down: num(o, 'down', TRACK_DEFAULTS.down),
      up: num(o, 'up', TRACK_DEFAULTS.up),
    })
    tracking = of(tracked[0])
    if (tracked.some((o) => JSON.stringify(of(o)) !== JSON.stringify(tracking))) {
      notes.push('Tracking differs between the WANs; the first one is shown.')
    }
  }

  const lastResortText = policyOptions
    ? (scalar(policyOptions, 'last_resort') ?? 'unreachable')
    : null
  const lastResort =
    lastResortText === 'unreachable' ||
    lastResortText === 'blackhole' ||
    lastResortText === 'default'
      ? lastResortText
      : null

  return {
    kind,
    policy: policyOptions ? policy : null,
    members: sorted,
    tracking,
    lastResort,
    rules: extraRules,
    notes,
  }
}

function configOf(states: SectionState[], config: string): MultiwanConfigSection[] | null {
  const rows = states
    .filter((s) => s.config === config && s.router !== null)
    .sort(
      (a, b) =>
        (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) ||
        a.perchId.localeCompare(b.perchId)
    )
  if (rows.length === 0) return null
  return rows.map((s) => ({
    perchId: s.perchId,
    section: s.name,
    type: s.router!.type,
    options: Object.fromEntries(
      Object.entries(s.router!.options).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v])
    ),
  }))
}

/** The view, from the rows and the observation (pure apart from its inputs). */
export function buildMultiwanView(
  gateway: Pick<Gateway, 'id' | 'capabilities'>,
  states: SectionState[],
  live: Mwan3Observation | null
): MultiwanView {
  const packages = (gateway.capabilities?.packages ?? {}) as Record<string, string>
  const config = configOf(states, 'mwan3')
  const pbrConfig = configOf(states, 'pbr')
  const installed = 'mwan3' in packages || live?.service?.installed === true || config !== null
  const pbrInstalled = 'pbr' in packages || pbrConfig !== null
  const profile = config
    ? multiwanProfile(config.map((c) => ({ name: c.section, type: c.type, options: c.options })))
    : null
  if (profile && live?.service && live.service.enabled === false && live.service.running !== true) {
    profile.notes.push('mwan3 is installed but disabled: none of this is in effect.')
  }
  return {
    gatewayId: gateway.id,
    package: installed ? 'mwan3' : pbrInstalled ? 'pbr' : null,
    installed,
    service: { enabled: live?.service?.enabled ?? null, running: live?.service?.running ?? null },
    writable: false,
    writeBlockedReason: installed || pbrInstalled ? 'owner_decision_12' : 'not_installed',
    profile,
    config,
    live,
    pbr: { installed: pbrInstalled, config: pbrConfig },
  }
}

/** `GET /gateways/:id/multiwan`. */
export async function multiwanView(gatewayId: number): Promise<MultiwanView> {
  const gateway = await findGateway(gatewayId)
  const { states } = await loadSections(gateway.id)
  const facts = await readObservedFacts(gateway.collectorId)
  return buildMultiwanView(gateway, states, facts.mwan3)
}
