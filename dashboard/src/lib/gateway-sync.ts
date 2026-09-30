import { ApiError, apiErrorCode } from '@/lib/api'
import { refusalMessage } from '@/lib/gateway-config'
import type { GatewayApply } from '@/types/gateway-config'
import type {
  AmbiguityAction,
  AmbiguityGroup,
  AmbiguityMember,
  CheckItem,
  CheckItemState,
  ChecksState,
  ApplyChecks,
  GatewayApplyWithChecks,
  SyncUnavailableReason,
} from '@/types/gateway-sync'

/**
 * Words and small rules of the gateway-sync area (design
 * docs/design/gateway-sync/): apply checks, the ambiguity flow, refusals.
 */

// ── Apply checks ────────────────────────────────────────────────────────────

export const CHECKS_STATE_LABEL: Record<ChecksState, string> = {
  pending: 'Waiting for the router',
  running: 'The router is checking',
  passed: 'Checks passed',
  failed: 'Checks failed',
  overridden: 'Kept without the checks',
}

export const CHECK_ITEM_STATE_LABEL: Record<CheckItemState, string> = {
  pending: 'waiting',
  running: 'checking',
  passed: 'passed',
  failed: 'failed',
  skipped: 'skipped',
}

/** A check target as people say it: `$gateway:wan` = "wan’s gateway". */
export function checkTargetLabel(target: string): string {
  if (target === '$gateway') return 'the gateway'
  const m = /^\$gateway:(.+)$/.exec(target)
  if (m) return `${m[1]}’s gateway`
  return target
}

function family(item: CheckItem): string {
  return item.family === 6 ? ' (IPv6)' : ''
}

/** One line per check: what the router verifies. */
export function checkItemTitle(item: CheckItem): string {
  switch (item.kind) {
    case 'interface_up':
      return `${item.network ?? 'The interface'} is up${family(item)}`
    case 'default_route':
      return `Default route${item.network ? ` through ${item.network}` : ''}${family(item)}`
    case 'reach': {
      const targets = (item.targets ?? []).map(checkTargetLabel)
      if (targets.length === 0) return `Reaches the internet${family(item)}`
      const list = targets.length > 1 ? `${targets.slice(0, -1).join(', ')} or ${targets.at(-1)}` : targets[0]
      return `Reaches ${list}${family(item)}`
    }
    case 'resolve':
      return `Resolves ${item.name ?? 'a name'}`
    case 'wg_handshake':
      return `WireGuard handshake on ${item.network ?? 'the tunnel'}`
  }
}

/** `apply.checks` when the controller sends it (older controllers do not). */
export function checksOf(apply: GatewayApply): ApplyChecks | null {
  return (apply as Partial<GatewayApplyWithChecks>).checks ?? null
}

/** The failed items of a rolled-back job (`outcome.checks`). */
export function failedChecksOf(apply: GatewayApply): CheckItem[] {
  return (apply as GatewayApplyWithChecks).outcome?.checks ?? []
}

/** Whether the admin may still wait for the checks (Keep changes stays off meanwhile). */
export function checksOpen(state: ChecksState): boolean {
  return state === 'pending' || state === 'running'
}

/** Whether the checks let a confirm through. */
export function checksDone(state: ChecksState): boolean {
  return state === 'passed' || state === 'overridden'
}

/** `outcome.reason` values this area adds to `OUTCOME_REASON`. */
export const SYNC_OUTCOME_REASON: Record<string, string> = {
  checks_failed: 'The router’s checks failed, so it undid the change by itself',
}

/**
 * Where a failed-checks job is fixed ("Back to the draft"): the page its checks
 * point at. The apply does not say which page made it (contract gap), so this
 * goes by the kinds of its checks.
 */
export function draftPathForChecks(gatewayId: number, items: CheckItem[] | undefined): string {
  const kinds = new Set((items ?? []).map((i) => i.kind))
  if (kinds.has('wg_handshake')) return `/gateway/vpn?gateway=${gatewayId}`
  if (kinds.size > 0) return `/gateway/internet?gateway=${gatewayId}`
  return `/gateway/config/${gatewayId}?tab=changes`
}

// ── Refusals ────────────────────────────────────────────────────────────────

const SYNC_REFUSALS: Record<string, string> = {
  not_built: 'This controller does not have this part of gateway sync yet.',
  checks_pending: 'The router is still checking the change. Wait for the checks, or keep it anyway.',
  checks_failed: 'The router’s checks failed. Keep it anyway only if you are sure the change is right.',
  confirm_mismatch: 'The name you typed does not match.',
  sync_changed: 'The router’s configuration changed while you were choosing. The list is reloaded: check your choices.',
  not_ambiguous: 'One of these sections is no longer a name clash.',
  ambiguity_incomplete: 'Every section of a clash needs a choice.',
  ambiguity_unresolved: 'Two sections would still share a name.',
  ambiguity_rename_unsupported: 'This kind of section cannot be renamed here.',
  firewall_defaults_confirm_required: 'Type the gateway’s name to reject or drop traffic by default.',
  firewall_policy_invalid: 'A policy must be ACCEPT, REJECT or DROP.',
  firewall_defaults_not_found: 'The router has no firewall defaults section.',
  upnp_not_installed: 'UPnP (miniupnpd) is not installed on the router.',
  upnp_interface_unknown: 'One of the networks is not known on the router.',
  upnp_action_invalid: 'The rule must allow or deny.',
  upnp_ports_invalid: 'Ports are a number or a range like 1024-65535.',
  upnp_addr_invalid: 'The address must be an IPv4 address or a subnet.',
  upnp_rule_not_found: 'That rule is gone from the router.',
  upnp_order_incomplete: 'The new order must list every rule once.',
  upnp_failed: 'The router could not remove the mappings.',
  device_no_lease: 'That device has no address from the router yet.',
  invalid_mac: 'That is not a MAC address.',
  gateway_capability_missing: 'The gateway agent is too old for this. Update it (Settings → Collectors).',
  agent_offline: 'The gateway agent is offline.',
  agent_timeout: 'The gateway agent did not answer in time.',
  not_managed: 'The gateway is not managed by Perch.',
  not_synced: 'That section is the router’s: include it in sync first.',
  pending_apply: 'Another change is still being applied. Try again once it is kept or rolled back.',
  insecure_transport: 'Secrets travel only over verified TLS. Set this in LuCI on the router.',
  sync_conflict: 'The router changed this too. Resolve the conflict first.',
  gateway_busy: 'The gateway is busy. Try again in a moment.',
  invalid_password: 'That password is not right.',
}

/** A refusal of this area, said plainly; the config plane's words otherwise. */
export function syncRefusalMessage(error: unknown): string {
  const code = apiErrorCode(error)
  if (code && SYNC_REFUSALS[code]) return SYNC_REFUSALS[code]
  if (error instanceof ApiError && error.status === 501) return SYNC_REFUSALS.not_built
  return refusalMessage(error)
}

/** A read this controller cannot serve yet (route missing or a B8 stub): the component stays away. */
export function isNotBuilt(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false
  if (error.status === 501) return true
  return error.status === 404 && apiErrorCode(error) !== 'gateway_not_found'
}

/** Why an area feature cannot be changed, for the read-only line. */
export function unavailableText(reason: SyncUnavailableReason | null, gatewayName: string): string | null {
  switch (reason) {
    case 'capability_missing':
      return `The gateway agent on ${gatewayName} is too old for this. Update it (Settings → Collectors).`
    case 'not_installed':
      return `The package is not installed on ${gatewayName}.`
    case 'router_access':
      return `The router lets Perch read this but not change it (its agent's config access is read-only).`
    case 'not_managed':
      return `${gatewayName} is not managed by Perch: shown read-only.`
    default:
      return null
  }
}

// ── The ambiguity flow ──────────────────────────────────────────────────────

export type MemberChoice = { action: AmbiguityAction; name: string }

export const ACTION_LABEL: Record<AmbiguityAction, string> = {
  keep: 'Keep',
  rename: 'Rename',
  delete: 'Delete',
  exclude: 'Router-only',
}

export const ACTION_HINT: Record<AmbiguityAction, string> = {
  keep: 'Perch manages it with the name it has.',
  rename: 'Perch renames it on the router and manages it.',
  delete: 'Removed from the router.',
  exclude: 'Stays on the router as it is; Perch never changes it.',
}

/** What `type` a group's sections are, in words ("port forward"). */
export function groupNoun(group: Pick<AmbiguityGroup, 'config' | 'type'>, count = 1): string {
  const one =
    group.config === 'firewall' && group.type === 'redirect'
      ? 'port forward'
      : group.config === 'firewall' && group.type === 'rule'
        ? 'traffic rule'
        : group.config === 'dhcp' && group.type === 'host'
          ? 'DHCP host'
          : `${group.config} ${group.type}`
  return count === 1 ? one : `${one}s`
}

/** The member's current name (the group's `nameOption`), or null. */
export function memberName(group: AmbiguityGroup, member: AmbiguityMember): string | null {
  if (!group.nameOption) return null
  const value = member.options[group.nameOption]
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

/**
 * The choice a member starts with: router-only if it already is, else a
 * rename to the suggested name (owner decision D6: rename all, delete
 * nothing), else keep.
 */
export function defaultChoice(group: AmbiguityGroup, member: AmbiguityMember): MemberChoice {
  if (member.excluded) return { action: 'exclude', name: '' }
  if (group.nameOption && member.suggestedName) return { action: 'rename', name: member.suggestedName }
  return { action: 'keep', name: '' }
}

export const NAME_MAX = 64

export type ResolveProblems = {
  /** perchId → what is wrong with its name. */
  members: Record<string, string>
  /** group key → what still clashes. */
  groups: Record<string, string>
}

/**
 * The local check of the resolve dialog (the server has the last word): a
 * rename needs a name; within one config and type, the members that stay
 * (kept or renamed) must end with names that differ ignoring case, as the
 * identity key compares them.
 */
export function validateResolution(
  groups: AmbiguityGroup[],
  choices: Record<string, MemberChoice>,
): ResolveProblems {
  const problems: ResolveProblems = { members: {}, groups: {} }
  const byType = new Map<string, Array<{ group: AmbiguityGroup; member: AmbiguityMember; name: string }>>()
  for (const group of groups) {
    for (const member of group.members) {
      const choice = choices[member.perchId] ?? defaultChoice(group, member)
      if (choice.action === 'rename') {
        const name = choice.name.trim()
        if (!name) problems.members[member.perchId] = 'Give it a name.'
        else if (name.length > NAME_MAX) problems.members[member.perchId] = `At most ${NAME_MAX} characters.`
      }
      if (choice.action !== 'keep' && choice.action !== 'rename') continue
      const name = choice.action === 'rename' ? choice.name.trim() : (memberName(group, member) ?? '')
      if (!name) continue
      const typeKey = `${group.config}.${group.type}`
      byType.set(typeKey, [...(byType.get(typeKey) ?? []), { group, member, name }])
    }
  }
  for (const entries of byType.values()) {
    const seen = new Map<string, (typeof entries)[number]>()
    for (const entry of entries) {
      const key = entry.name.toLowerCase()
      const first = seen.get(key)
      if (!first) {
        seen.set(key, entry)
        continue
      }
      for (const clash of [first, entry]) {
        const choice = choices[clash.member.perchId] ?? defaultChoice(clash.group, clash.member)
        if (choice.action === 'rename' && !problems.members[clash.member.perchId]) {
          problems.members[clash.member.perchId] = `“${clash.name}” is taken by another one here (names ignore case).`
        }
        problems.groups[clash.group.key] ??= `Two would still be called “${clash.name}”: rename one, delete one or leave one router-only.`
      }
    }
  }
  return problems
}

export function hasProblems(problems: ResolveProblems): boolean {
  return Object.keys(problems.members).length > 0 || Object.keys(problems.groups).length > 0
}

/** "2 renamed · 1 router-only", in the order the actions read. */
export function resolutionSummary(choices: MemberChoice[]): string {
  const count = (action: AmbiguityAction) => choices.filter((c) => c.action === action).length
  const parts = [
    [count('rename'), 'renamed'],
    [count('keep'), 'kept'],
    [count('delete'), 'deleted'],
    [count('exclude'), 'router-only'],
  ] as const
  return parts
    .filter(([n]) => n > 0)
    .map(([n, what]) => `${n} ${what}`)
    .join(' · ')
}
