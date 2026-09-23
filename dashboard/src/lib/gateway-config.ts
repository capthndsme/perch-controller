import { ApiError, apiErrorCode } from '@/lib/api'
import type {
  ActorRef,
  ApplyKind,
  ApplyState,
  ConfigDiffEntry,
  Gateway,
  GatewayApply,
  GatewayMode,
  GatewaySection,
  GatewaySyncState,
  RevisionSource,
  RouterAuthor,
  SectionScope,
  SectionStatus,
  SyncBlocker,
  SystemActorVia,
  UciValue,
  WriteBlockedReason,
} from '@/types/gateway-config'

/**
 * Pure helpers of the gateway config pages: labels, tones, value formatting,
 * refusal messages. Tones map to the `--status-*` tokens.
 */

export type Tone = 'good' | 'warning' | 'serious' | 'critical' | 'neutral' | 'info'

export const TONE_CLASS: Record<Tone, string> = {
  good: 'border-status-good/40 bg-status-good/10 text-status-good',
  warning: 'border-status-warning/50 bg-status-warning/10 text-foreground',
  serious: 'border-status-serious/50 bg-status-serious/10 text-foreground',
  critical: 'border-status-critical/40 bg-status-critical/10 text-status-critical',
  neutral: 'border-border bg-muted/40 text-muted-foreground',
  info: 'border-primary/30 bg-primary/5 text-foreground',
}

export const TONE_DOT: Record<Tone, string> = {
  good: 'bg-status-good',
  warning: 'bg-status-warning',
  serious: 'bg-status-serious',
  critical: 'bg-status-critical',
  neutral: 'bg-muted-foreground/50',
  info: 'bg-primary',
}

export const MODE_META: Record<GatewayMode, { label: string; tone: Tone; hint: string }> = {
  off: { label: 'Off', tone: 'neutral', hint: 'Perch does not read the router’s configuration.' },
  observe: {
    label: 'Observe',
    tone: 'info',
    hint: 'Read-only mirror: Perch reads the configuration, the router always wins.',
  },
  managed: {
    label: 'Managed',
    tone: 'good',
    hint: 'Two-way: edits made in Perch apply to the router, router edits flow back.',
  },
}

export const SYNC_META: Record<GatewaySyncState, { label: string; tone: Tone }> = {
  unknown: { label: 'Not read yet', tone: 'neutral' },
  in_sync: { label: 'In sync', tone: 'good' },
  ahead: { label: 'Changes to apply', tone: 'info' },
  conflict: { label: 'Conflicts', tone: 'critical' },
  drift: { label: 'Drift', tone: 'serious' },
  applying: { label: 'Applying', tone: 'warning' },
}

export const STATUS_META: Record<SectionStatus, { label: string; tone: Tone }> = {
  in_sync: { label: 'In sync', tone: 'good' },
  ahead: { label: 'Draft', tone: 'info' },
  pending: { label: 'Applying', tone: 'warning' },
  conflict: { label: 'Conflict', tone: 'critical' },
  drift: { label: 'Drift', tone: 'serious' },
  reverting: { label: 'Reverting', tone: 'warning' },
}

export const SCOPE_META: Record<SectionScope, { label: string; tone: Tone; hint: string }> = {
  synced: { label: 'Synced', tone: 'good', hint: 'Managed by Perch, two-way.' },
  excluded: {
    label: 'Excluded',
    tone: 'neutral',
    hint: 'Router-only: Perch mirrors and logs it but never writes it.',
  },
  unmodeled: {
    label: 'Unmodeled',
    tone: 'neutral',
    hint: 'Perch has no model for it (or it is ambiguous): mirrored and logged, never written.',
  },
}

export const ISSUE_LABEL: Record<NonNullable<GatewaySection['issue']>, string> = {
  ambiguous: 'Ambiguous: two router sections share an identity (e.g. the same MAC)',
  no_round_trip: 'Perch cannot write it back unchanged',
  duplicate: 'Duplicate',
}

export const APPLY_STATE_META: Record<ApplyState, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'info' },
  sending: { label: 'Sending', tone: 'warning' },
  pending_confirm: { label: 'Waiting for confirmation', tone: 'warning' },
  confirmed: { label: 'Confirmed', tone: 'good' },
  rolled_back: { label: 'Rolled back', tone: 'serious' },
  failed: { label: 'Failed', tone: 'critical' },
  expired: { label: 'Expired', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
}

export const APPLY_KIND_LABEL: Record<ApplyKind, string> = {
  apply: 'Apply',
  revert: 'Revert (Authoritative Mode)',
  adopt: 'Adopt sections',
  package: 'Package install',
}

export const REVISION_SOURCE_LABEL: Record<RevisionSource, string> = {
  import: 'Imported',
  router: 'Router edit',
  controller: 'Applied from Perch',
  merge: 'Merged',
  revert: 'Reverted',
  rollback: 'Rolled back',
}

export function isOpenApply(state: ApplyState): boolean {
  return state === 'queued' || state === 'sending' || state === 'pending_confirm'
}

/** What part of Perch made a change by itself, for the "Perch (system)" badge. */
export const SYSTEM_VIA_META: Record<SystemActorVia, { label: string; hint: string }> = {
  qos: { label: 'QoS', hint: 'Written by traffic shaping (the WAN queues and the shaper package).' },
  portal: { label: 'Portal', hint: 'Written by the guest portal.' },
  enforcement: { label: 'Enforcement', hint: 'Authoritative Mode put Perch’s version back.' },
  system: { label: 'System', hint: 'Written by Perch itself.' },
}

/** An actor as plain text (no badge): the user’s email, "Perch (system) · QoS", or null. */
export function actorText(actor: ActorRef | undefined): string | null {
  if (!actor) return null
  if (actor.system) return `${actor.name || 'Perch (system)'} · ${SYSTEM_VIA_META[actor.via]?.label ?? actor.via}`
  return actor.email
}

export function routerAuthorLabel(author: RouterAuthor | null | undefined): string | null {
  if (!author) return null
  const who =
    author.kind === 'luci'
      ? 'LuCI'
      : author.kind === 'cli'
        ? 'the command line'
        : author.kind === 'perch'
          ? 'Perch'
          : 'someone on the router'
  const user = author.user ? ` (${author.user})` : ''
  // A change found by the periodic poll has no trigger to name its tool for sure.
  const likely = author.via === 'poll' && author.kind !== 'perch' ? ' (likely)' : ''
  return `${who}${user}${likely}`
}

/** A UCI value (or a conflict side, which may be absent) for display. */
export function formatUciValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (Array.isArray(value)) return value.length === 0 ? '[]' : value.map((v) => String(v)).join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

export type OptionRow = {
  name: string
  base: UciValue | null
  router: UciValue | null
  desired: UciValue | null
  secret: boolean
  /** Perch owns it (whole-section ownership, or listed). */
  owned: boolean
}

/** Every option of a section across B, R and C, owned ones first. */
export function optionRows(section: GatewaySection): OptionRow[] {
  const names = new Set<string>()
  for (const c of [section.base, section.router, section.desired]) {
    if (!c) continue
    for (const n of Object.keys(c.options)) names.add(n)
    for (const n of Object.keys(c.secrets ?? {})) names.add(n)
  }
  const owned = (name: string) => section.ownership === null || section.ownership.options.includes(name)
  const pick = (c: GatewaySection['base'], name: string): UciValue | null => {
    if (!c) return null
    if (c.secrets?.[name]) return `secret ${c.secrets[name].fingerprint}`
    return c.options[name] ?? null
  }
  return [...names]
    .map((name) => ({
      name,
      base: pick(section.base, name),
      router: pick(section.router, name),
      desired: pick(section.desired, name),
      secret: Boolean(
        section.base?.secrets?.[name] || section.router?.secrets?.[name] || section.desired?.secrets?.[name],
      ),
      owned: owned(name),
    }))
    .sort((a, b) => Number(b.owned) - Number(a.owned) || a.name.localeCompare(b.name))
}

export function diffActionLabel(action: ConfigDiffEntry['action']): string {
  switch (action) {
    case 'create':
      return 'Add'
    case 'delete':
      return 'Remove'
    case 'adopt':
      return 'Adopt'
    case 'order':
      return 'Reorder'
    default:
      return 'Change'
  }
}

export function sectionTitle(entry: { config: string; section: string; type?: string }): string {
  return `${entry.config}.${entry.section}`
}

// ── Time ───────────────────────────────────────────────────────────────────

export function secondsUntil(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.round((t - now) / 1000)
}

export function formatCountdown(seconds: number): string {
  const s = Math.max(0, seconds)
  const m = Math.floor(s / 60)
  const rest = s % 60
  return m > 0 ? `${m}:${String(rest).padStart(2, '0')}` : `${rest} s`
}

export function formatAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  const s = Math.round((now - t) / 1000)
  if (s < 0) return 'just now'
  if (s < 45) return `${s} s ago`
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

// ── Access and refusals ────────────────────────────────────────────────────

export const WRITE_BLOCK_TEXT: Record<WriteBlockedReason, string> = {
  offline: 'The gateway’s agent is not connected.',
  no_capability: 'This collector has no config plane (update perch-collector on the router).',
  router_access:
    'The router does not allow writes: set `config_access` to `write` in /etc/config/perch-collector.',
  insecure_transport:
    'The connection is plain HTTP. Writes need verified TLS, or both opt-ins (Settings → Gateway config and the router’s `config_allow_insecure`) and a pairing.',
  not_paired: 'Plain HTTP with both opt-ins: pair the controller with the router to sign writes.',
  sign_key_unknown:
    'The router signs with its own `config_sign_key`: enter that key here, or pair instead.',
}

const REFUSALS: Record<string, string> = {
  invalid_password: 'That password is not right.',
  admin_required: 'Only admins can do this.',
  agent_offline: 'The gateway’s agent is not connected.',
  agent_timeout: 'The gateway’s agent did not answer in time.',
  gateway_busy: 'Too much work is queued for this gateway; try again in a moment.',
  gateway_not_found: 'No such gateway.',
  router_access_insufficient: 'The router’s `config_access` does not allow this.',
  insecure_transport: 'Writes over plain HTTP need both opt-ins and a pairing.',
  not_paired: 'Pair the controller with the router first.',
  no_capability: 'This collector has no config plane.',
  apply_in_flight: 'Another change is still being applied.',
  not_managed: 'The gateway is not in managed mode.',
  not_in_sync: 'The router and Perch are not in sync yet.',
  sync_changed: 'The router changed while you were looking: review the list again.',
  expect_revision_required: 'Reload the sync status and try again.',
  conflicts_open: 'Resolve the open conflicts first.',
  nothing_to_apply: 'There is nothing to apply.',
  invalid_config: 'The change does not validate.',
  not_pending: 'That change is no longer waiting for a confirmation.',
  deadline_passed: 'Too late: the confirm window closed and the router rolls back.',
  not_revertible: 'That change can no longer be reverted.',
  no_drift: 'There is no drift to act on.',
  enforcement_suspended: 'Enforcement is suspended: resume it first.',
  nothing_to_resolve: 'Nothing to resolve.',
  resolution_incomplete: 'Pick a value for every conflicting option.',
  pairing_not_needed: 'This gateway uses verified TLS: no pairing needed.',
  already_paired: 'Already paired: unpair first.',
  no_pairing: 'There is no pairing waiting for a code.',
  pairing_code_mismatch: 'That code does not match.',
  pairing_malformed: 'The router answered the pairing with something unexpected.',
  pairing_commitment_mismatch:
    'The router’s answer did not match its commitment. Someone may be between the controller and the router.',
  package_not_allowed: 'Not on the router’s install allowlist.',
  invalid_packages: 'Name 1 to 16 packages.',
  insufficient_flash: 'Not enough free flash on the router.',
  unmodeled: 'Perch has no model for this section.',
  pending_apply: 'The section is part of a change being applied.',
  not_on_router: 'The section is not on the router.',
  dns_name_reserved: 'That name is reserved.',
  dns_name_invalid: 'That is not a valid host name.',
  dns_name_taken: 'That name is already in use.',
  dns_value_invalid: 'That value is not valid for this record type.',
  dns_label_names_off: 'Label names are off for this gateway.',
  dhcp_ip_invalid: 'That is not a valid IPv4 address.',
  dhcp_host_empty: 'Give an address or a name.',
  dhcp_host_exists: 'The router already has a host entry for this device that it owns.',
  device_no_lease: 'The device has no current lease to reserve.',
  dhcp_reservation_not_found: 'There is no reservation to remove.',
  gateway_ambiguous: 'Several gateways are managed: pick one.',
  mode_off: 'The gateway is off.',
  not_detached: 'The gateway is not detached.',
}

/** A refusal as one sentence: the known code's text, else the server's message. */
export function refusalMessage(error: unknown): string {
  const code = apiErrorCode(error)
  if (code && REFUSALS[code]) {
    const extra = refusalExtra(error)
    return extra ? `${REFUSALS[code]} ${extra}` : REFUSALS[code]
  }
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}

function refusalExtra(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null
  const body = error.body as Record<string, unknown> | null
  if (!body) return null
  if (typeof body.attemptsLeft === 'number') return `${body.attemptsLeft} attempt(s) left.`
  if (Array.isArray(body.packages)) return `(${body.packages.join(', ')})`
  if (typeof body.needBytes === 'number' && typeof body.freeBytes === 'number') {
    return `Needs ${Math.ceil(body.needBytes / 1024)} KiB, ${Math.floor(body.freeBytes / 1024)} KiB free.`
  }
  return null
}

/** A field of the refusal body (`blockers`, `issues`, `headRevision`, …). */
export function refusalField<T>(error: unknown, field: string): T | undefined {
  if (!(error instanceof ApiError)) return undefined
  const body = error.body as Record<string, unknown> | null
  return (body?.[field] as T | undefined) ?? undefined
}

// ── Blockers of Authoritative Mode ─────────────────────────────────────────

export function blockerText(blocker: SyncBlocker): string {
  switch (blocker.kind) {
    case 'offline':
      return 'The gateway’s agent is offline: Perch cannot read the router.'
    case 'mode_not_managed':
      return 'The gateway is not in managed mode.'
    case 'apply_in_flight':
      return 'A change is being applied: wait for it to finish.'
    case 'enforcement_suspended':
      return 'Enforcement is suspended after failed reverts.'
    case 'conflict':
      return 'Conflict: both sides changed the same option.'
    case 'controller_ahead':
      return 'Perch has a draft for this section that is not on the router yet.'
    case 'router_ahead':
      return 'The router’s version differs from Perch’s.'
    case 'unimported_section':
      return 'A router section Perch has not taken into its ledger yet.'
    case 'order':
      return `The order of ${blocker.config} ${blocker.type} sections differs between the router and Perch.`
    case 'feature':
      return `${FEATURE_LABEL[blocker.feature] ?? blocker.feature}: ${blocker.message}`
  }
}

/** Feature names of the "in sync" checks (docs/gateway/native-sync.md section 6). */
const FEATURE_LABEL: Record<string, string> = {
  system: 'System',
  routes: 'Routing',
  dns_settings: 'DNS',
  dns_records: 'DNS records',
  dhcp_hosts: 'DHCP reservations',
  dhcp_pools: 'DHCP pools',
  dhcp_tags: 'DHCP tags',
  networks: 'Networks',
  firewall: 'Firewall',
}

// ── The gateway at a glance ─────────────────────────────────────────────────

/** Decision 7/26: "Enable full management" only once Perch holds observed data. */
export function canOfferFullManagement(gateway: Gateway): boolean {
  return gateway.mode === 'observe' && gateway.observedAt !== null
}

/** The protected job's window, in words. */
export function applyWindowText(apply: GatewayApply): string {
  const minutes = Math.round(apply.confirmTimeoutSeconds / 60)
  return apply.confirmTimeoutSeconds >= 120 ? `${minutes} min` : `${apply.confirmTimeoutSeconds} s`
}

export const EVENT_LABEL: Record<string, string> = {
  mode_changed: 'Mode changed',
  authoritative_changed: 'Authoritative Mode changed',
  read: 'Configuration read',
  imported: 'Router edit imported',
  conflict_opened: 'Conflict opened',
  conflict_resolved: 'Conflict resolved',
  drift_detected: 'Drift detected',
  drift_accepted: 'Drift accepted',
  apply_requested: 'Apply requested',
  applied: 'Applied on the router',
  confirmed: 'Confirmed',
  rolled_back: 'Rolled back',
  failed: 'Failed',
  expired: 'Queued change expired',
  enforcement_suspended: 'Enforcement suspended',
  enforcement_resumed: 'Enforcement resumed',
  section_excluded: 'Section excluded',
  section_included: 'Section included',
  section_removed: 'Section removed',
  section_ambiguous: 'Ambiguous section',
  read_refused: 'Read refused',
  revision_restored: 'Revision restored into the draft',
  unmodeled_changed: 'Unmodeled section changed',
  rejoin_offered: 'Rejoin offered',
  rejoin_dismissed: 'Rejoin dismissed',
  cancelled: 'Cancelled',
  draft_discarded: 'Draft discarded',
  draft_edited: 'Draft edited',
  bound: 'Bound to a collector',
  dns_label_names_changed: 'Label names policy changed',
  sign_key_changed: 'Sign key changed',
  pairing_started: 'Pairing started',
  pairing_code_rejected: 'Pairing code rejected',
  pairing_code_accepted: 'Pairing code accepted',
  pairing_router_confirmed: 'Router confirmed the pairing',
  paired: 'Paired',
  pairing_failed: 'Pairing failed',
  pairing_lost: 'Pairing lost',
  unpaired: 'Unpaired',
  router_paused: 'Paused on the router',
  router_resumed: 'Resumed on the router',
}

/** Events the router caused (no user, and not Perch either). */
export const ROUTER_EVENTS = new Set(['router_paused', 'router_resumed', 'imported', 'drift_detected', 'unmodeled_changed'])

export function eventTone(event: string): Tone {
  if (['failed', 'rolled_back', 'enforcement_suspended', 'read_refused', 'pairing_failed', 'pairing_lost', 'conflict_opened'].includes(event)) {
    return event === 'failed' || event === 'read_refused' || event === 'pairing_lost' ? 'critical' : 'serious'
  }
  if (['confirmed', 'paired', 'conflict_resolved', 'enforcement_resumed', 'drift_accepted'].includes(event)) return 'good'
  if (['drift_detected', 'expired', 'pairing_code_rejected', 'section_ambiguous', 'router_paused'].includes(event)) return 'warning'
  if (event === 'router_resumed') return 'good'
  return 'neutral'
}

export const OUTCOME_REASON: Record<string, string> = {
  confirm_timeout: 'No confirmation arrived before the deadline',
  admin: 'An admin reverted it',
  reboot: 'The router rebooted during the confirm window',
  commit_failed: 'The router could not commit the change',
  reload_failed: 'A service failed to reload with the change',
  install_failed: 'The package install failed',
  no_answer: 'The agent never answered',
}
