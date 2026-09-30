import { ApiError, apiErrorCode } from '@/lib/api'
import { formatBytes } from '@/lib/format-bytes'
import type {
  AgentProduct,
  AgentRollout,
  AgentRolloutDevice,
  AgentUpdateDevice,
  AgentUpdateEvent,
  AgentUpdateJobSummary,
  AutoUpdate,
  Channel,
  InstallKind,
  JobState,
  RolloutDeviceState,
  UnsupportedReason,
  UpdateMethod,
} from '@/types/agent-updates'

/**
 * Words and order for Settings → Updates (docs/design/agent-updates). Version
 * order is protocol.md 1.4: SemVer precedence, build metadata ignored, and
 * anything unparsable ("dev") is unknown, below every version.
 */

// ── Versions ───────────────────────────────────────────────────────────────

type Parsed = { core: [number, number, number]; pre: (number | string)[] }

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parseVersion(version: string | null | undefined): Parsed | null {
  const match = version ? SEMVER.exec(version.trim()) : null
  if (!match) return null
  const pre = match[4] ? match[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : []
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre }
}

/** -1, 0 or 1. Unknown versions sort below every known one (and equal to each other). */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1
  }
  // A release outranks its pre-releases.
  if (pa.pre.length === 0 || pb.pre.length === 0) {
    return pa.pre.length === pb.pre.length ? 0 : pa.pre.length === 0 ? 1 : -1
  }
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    // Numeric identifiers rank below alphanumeric ones.
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return 0
}

/** `1.0.0~rc2-r1` / `1.0.0_rc2-r1` → `1.0.0-rc.2` (the package database's spelling to the release's). */
export function packageToReleaseVersion(pkg: string): string {
  return pkg
    .replace(/-r\d+$/, '')
    .replace(/[~_](alpha|beta|pre|rc)(\d+)$/, '-$1.$2')
}

// ── Names ──────────────────────────────────────────────────────────────────

export const PRODUCTS: AgentProduct[] = ['perch-apd', 'perch-collector']

export const PRODUCT_LABEL: Record<AgentProduct, string> = {
  'perch-apd': 'perch-apd',
  'perch-collector': 'perch-collector',
}

export const PRODUCT_DEVICES: Record<AgentProduct, string> = {
  'perch-apd': 'access points',
  'perch-collector': 'gateways and collectors',
}

export const ROLE_LABEL: Record<AgentUpdateDevice['role'], string> = {
  ap: 'Access point',
  gateway: 'Gateway',
  collector: 'Collector',
}

export const CHANNEL_LABEL: Record<Channel, string> = {
  stable: 'Stable',
  pre: 'Pre-release',
  local: 'Local builds',
}

export const CHANNEL_HINT: Record<Channel, string> = {
  stable: 'Final releases only.',
  pre: 'Final releases and pre-releases.',
  local: 'Everything, including builds uploaded to this controller.',
}

export const AUTO_UPDATE_LABEL: Record<AutoUpdate, string> = {
  off: 'Off',
  notify: 'Notify',
  auto: 'Automatic',
}

export const AUTO_UPDATE_HINT: Record<AutoUpdate, string> = {
  off: 'Nothing happens when a release appears.',
  notify: 'A badge and an event when a release appears; you start the update.',
  auto: 'A rollout starts on its own, inside the maintenance window only.',
}

export const METHOD_LABEL: Record<UpdateMethod, string> = {
  binary: 'Binary swap',
  package: 'Package',
}

export const METHOD_HINT: Record<UpdateMethod | 'auto', string> = {
  auto: 'The package manager when the device’s package record matches what runs, else a binary swap.',
  binary: 'Replaces the daemon’s binary (and its companion files) directly; works without a package record.',
  package: 'Installs the release’s package with opkg or apk, so the package record stays current.',
}

export const INSTALL_KIND_TEXT: Record<InstallKind, string> = {
  package: 'Installed from a package that matches what runs',
  swapped: 'A binary swapped in over an older package record',
  unowned: 'A binary no package owns',
  manual: 'Installed with install.sh (under /opt)',
  docker: 'A Docker container',
  other: 'Installed some other way (systemd, pm2, a binary elsewhere)',
}

export const UNSUPPORTED_TEXT: Record<UnsupportedReason, string> = {
  agent_too_old: 'This version cannot update itself: install a newer one by hand once.',
  self_update_off: 'Self-update is turned off on the device (option self_update).',
  no_trusted_keys: 'The device trusts no release signing key yet.',
  install_kind_unsupported: 'Perch cannot update this kind of install from the dashboard.',
  not_openwrt: 'Updates from the dashboard need OpenWrt.',
  poll_transport: 'This collector is polled over HTTP: it updates by hand.',
  never_reported: 'The device has not reported its update status yet.',
}

export const GUARD_TEXT: Record<'installed' | 'missing' | 'outdated', string> = {
  installed: 'Installed',
  missing: 'Not yet (written before the first update)',
  outdated: 'Outdated (rewritten at the next update)',
}

// ── Jobs ───────────────────────────────────────────────────────────────────

const OPEN_STATES: ReadonlySet<JobState> = new Set(['queued', 'staging', 'staged', 'installing', 'probation', 'unknown'])

export function isOpenJob(state: JobState): boolean {
  return OPEN_STATES.has(state)
}

export const JOB_STATE_LABEL: Record<JobState, string> = {
  queued: 'Queued',
  staging: 'Downloading',
  staged: 'Downloaded',
  installing: 'Installing',
  probation: 'Checking',
  unknown: 'No word from the device',
  confirmed: 'Updated',
  failed: 'Failed',
  rolled_back: 'Rolled back',
  rollback_failed: 'Rollback failed',
  rollback_unavailable: 'No rollback copy',
  cancelled: 'Cancelled',
  expired: 'Expired',
}

export type Tone = 'neutral' | 'active' | 'good' | 'warning' | 'critical'

export const TONE_BG: Record<Tone, string> = {
  neutral: 'bg-muted-foreground/45',
  active: 'bg-brand',
  good: 'bg-status-good',
  warning: 'bg-status-warning',
  critical: 'bg-status-critical',
}

export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-muted-foreground',
  active: 'text-brand',
  good: 'text-status-good',
  warning: 'text-status-warning',
  critical: 'text-status-critical',
}

export const JOB_STATE_TONE: Record<JobState, Tone> = {
  queued: 'neutral',
  staging: 'active',
  staged: 'active',
  installing: 'active',
  probation: 'active',
  unknown: 'warning',
  confirmed: 'good',
  failed: 'warning',
  rolled_back: 'warning',
  rollback_failed: 'critical',
  rollback_unavailable: 'critical',
  cancelled: 'neutral',
  expired: 'neutral',
}

/** Reason codes of results and failures (protocol.md 5 and 6), in words. */
const REASON_TEXT: Record<string, string> = {
  download_failed: 'The download kept failing',
  url_expired: 'The download link expired',
  hash_mismatch: 'A downloaded file did not match the signed release',
  files_invalid: 'The companion files did not match the signed release',
  staged_corrupt: 'The downloaded files changed before the install',
  insufficient_flash: 'Not enough free flash',
  insufficient_ram: 'Not enough free memory',
  reboot_before_install: 'The device restarted before the install',
  confirm_timeout: 'The new version never checked in',
  crash_loop: 'The new version kept crashing',
  aborted: 'Stopped by an admin',
  reboot: 'The device restarted during the check',
  reboot_refetched: 'The device restarted during the check; the previous version was fetched again',
  post_write_space: 'Flash ran low after writing the new version',
  install_failed: 'The package manager failed',
  start_failed: 'The new version did not start',
  restore_failed: 'A restored file did not match',
  no_copy: 'The rollback copy was lost in a restart',
  lost_on_device: 'The device forgot the update',
  busy: 'Another update is running on the device',
  busy_pending_apply: 'A configuration change is waiting for its confirm',
  unknown_key: 'The release is signed with a key the device does not trust',
  bad_signature: 'The release signature is not valid',
  manifest_invalid: 'The release manifest is not valid',
  wrong_product: 'The release is for another product',
  below_floor: 'The version is below the device’s floor',
  same_version: 'The device already runs this version',
  from_too_old: 'The running version is too old to go straight to this one',
  target_mismatch: 'The release has nothing for this device',
  refetch_unavailable: 'The previous version cannot be fetched again',
  not_staged: 'Nothing was downloaded',
  staged_changed: 'The downloaded files changed',
  not_in_probation: 'The update was not being checked',
  wrong_process: 'Another process answered',
  self_update_off: 'Self-update is off on the device',
  no_trusted_keys: 'The device trusts no signing key',
  install_kind_unsupported: 'This kind of install cannot update itself',
  method_unsupported: 'The device cannot use that method',
  not_openwrt: 'The device is not OpenWrt',
  admin: 'Stopped by an admin',
}

export function reasonText(reason: string | null | undefined): string | null {
  if (!reason) return null
  return REASON_TEXT[reason] ?? reason.replace(/_/g, ' ')
}

/** Download progress 0–1, or null when unknown. */
export function jobFraction(job: Pick<AgentUpdateJobSummary, 'progress'>): number | null {
  const p = job.progress
  if (!p || p.totalBytes <= 0) return null
  return Math.min(1, Math.max(0, p.bytes / p.totalBytes))
}

/** "Downloading 45 %", "Checking", "Rolled back: the new version never checked in". */
export function jobStateText(job: AgentUpdateJobSummary): string {
  if (job.state === 'staging') {
    const f = jobFraction(job)
    return f === null ? 'Downloading' : `Downloading ${Math.floor(f * 100)} %`
  }
  if (job.state === 'probation') return 'Checking'
  const reason = reasonText(job.reason)
  if ((job.state === 'rolled_back' || job.state === 'failed') && reason) return `${JOB_STATE_LABEL[job.state]}: ${lower(reason)}`
  return JOB_STATE_LABEL[job.state]
}

function lower(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}

/** The steps of one update, in order (the device sheet's timeline and the rollout rows). */
export const JOB_STEPS = [
  { id: 'queued', label: 'Queued' },
  { id: 'download', label: 'Downloaded' },
  { id: 'install', label: 'Installed' },
  { id: 'reconnect', label: 'Reconnected' },
  { id: 'confirm', label: 'Confirmed' },
] as const

export type JobStepId = (typeof JOB_STEPS)[number]['id']

/** How many of JOB_STEPS are done for a job in `state` (confirmed = all five). */
export function jobStepsDone(state: JobState): number {
  switch (state) {
    case 'queued':
      return 1
    case 'staging':
      return 1
    case 'staged':
      return 2
    case 'installing':
    case 'unknown':
      return 3
    case 'probation':
      return 4
    case 'confirmed':
      return 5
    default:
      return 0
  }
}

// ── Rollouts ───────────────────────────────────────────────────────────────

export const ROLLOUT_STATE_LABEL: Record<AgentRollout['state'], string> = {
  canary: 'Canary',
  observing: 'Observing',
  rolling: 'Rolling out',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

export function isOpenRollout(state: AgentRollout['state']): boolean {
  return state !== 'completed' && state !== 'cancelled'
}

export const ROLLOUT_DEVICE_LABEL: Record<RolloutDeviceState, string> = {
  pending: 'Waiting',
  running: 'Updating',
  confirmed: 'Updated',
  failed: 'Failed',
  skipped: 'Skipped',
}

export const WAITING_TEXT: Record<NonNullable<AgentRollout['waitingFor']>, string> = {
  window: 'Waiting for the maintenance window',
  gap: 'Pausing between batches',
  observe: 'Watching the canary',
  online: 'Waiting for a device to come online',
  busy: 'Waiting for a configuration change to be confirmed',
}

const PAUSED_TEXT: Record<string, string> = {
  device_failed: 'A device did not update',
  admin: 'Paused by an admin',
  release_withdrawn: 'The release was withdrawn',
  controller_too_old: 'This controller is too old for the release',
}

export function pausedText(reason: string | null): string | null {
  if (!reason) return null
  return PAUSED_TEXT[reason] ?? reason.replace(/_/g, ' ')
}

const SKIP_TEXT: Record<string, string> = {
  offline: 'Offline too long',
  pinned: 'Held at its version',
  unsupported: 'Cannot update itself',
  up_to_date: 'Already up to date',
  admin: 'Skipped by an admin',
  failed: 'Failed, skipped on resume',
}

export function skipText(reason: string | null): string | null {
  if (!reason) return null
  return SKIP_TEXT[reason] ?? reason.replace(/_/g, ' ')
}

/** One device's cell in a rollout's track (components/agent-updates/rollout-sheet.tsx). */
export type TrackCell = { key: string; state: RolloutDeviceState; fraction: number | null; sweep: boolean; label: string }

/** Cells from a rollout with its devices (the sheet), in rollout order. */
export function cellsOfDevices(devices: AgentRolloutDevice[]): TrackCell[] {
  return [...devices]
    .sort((a, b) => a.position - b.position)
    .map((d) => {
      const job = d.job
      const downloading = job?.state === 'staging' || job?.state === 'queued'
      return {
        key: d.device.key,
        state: d.state,
        fraction: d.state === 'running' && job ? (job.state === 'queued' ? 0 : downloading ? (jobFraction(job) ?? 0) : null) : null,
        sweep: d.state === 'running' && job !== null && isOpenJob(job.state) && !downloading,
        label: `${d.device.name}${d.isCanary ? ' (canary)' : ''}: ${ROLLOUT_DEVICE_LABEL[d.state]}`,
      }
    })
}

/** Cells from a list row's counts: done first, then running, then waiting. */
export function cellsOfCounts(rollout: AgentRollout): TrackCell[] {
  const order: RolloutDeviceState[] = ['confirmed', 'failed', 'skipped', 'running', 'pending']
  return order.flatMap((state) =>
    Array.from({ length: rollout.counts[state] }, (_, i) => ({
      key: `${state}-${i}`,
      state,
      fraction: null,
      sweep: state === 'running',
      label: ROLLOUT_DEVICE_LABEL[state],
    })),
  )
}

// ── Events ─────────────────────────────────────────────────────────────────

function str(detail: Record<string, unknown> | null, key: string): string | null {
  const value = detail?.[key]
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null
}

/** One line per audit event, in words. */
export function eventTitle(event: AgentUpdateEvent): string {
  const d = event.detail
  const who = event.device?.name ?? str(d, 'deviceName') ?? 'A device'
  const to = str(d, 'toVersion')
  const version = str(d, 'version')
  const product = str(d, 'product')
  const reason = reasonText(str(d, 'reason'))
  switch (event.event) {
    case 'agent_update.available':
      return `${product ?? 'A release'} ${version ?? ''} is available`.trim()
    case 'agent_update.started':
      return `${who}: update to ${to ?? 'a new version'} started`
    case 'agent_update.confirmed':
      return `${who} updated to ${to ?? 'the new version'}`
    case 'agent_update.failed':
      return `${who}: update to ${to ?? 'the new version'} failed${reason ? ` (${lower(reason)})` : ''}`
    case 'agent_update.rolled_back':
      return `${who} rolled back to ${str(d, 'fromVersion') ?? 'the previous version'}${reason ? `: ${lower(reason)}` : ''}`
    case 'agent_update.unknown':
      return `${who} went quiet during its update`
    case 'agent_update.rollback_failed':
      return `${who}: the rollback failed`
    case 'agent_update.rollback_unavailable':
      return `${who}: no rollback copy after a restart`
    case 'agent_update.rollout_paused':
      return `Rollout of ${product ?? ''} ${version ?? ''} paused${pausedText(str(d, 'reason')) ? `: ${lower(pausedText(str(d, 'reason'))!)}` : ''}`.replace(/\s+/g, ' ')
    case 'agent_update.rollout_completed':
      return `Rollout of ${product ?? ''} ${version ?? ''} completed`.replace(/\s+/g, ' ')
    case 'agent_update.release_rejected':
      return `Release ${product ?? ''} ${version ?? ''} rejected${reason ? `: ${lower(reason)}` : ''}`.replace(/\s+/g, ' ')
    case 'agent_update.version_changed':
      return `${who} now runs ${to ?? 'another version'} (updated outside Perch)`
    case 'settings_changed':
      return 'Update settings changed'
    case 'device_settings_changed':
      return `${who}: update settings changed`
    case 'release_imported':
      return `Release ${product ?? ''} ${version ?? ''} imported`.replace(/\s+/g, ' ')
    case 'release_withdrawn':
      return `Release ${product ?? ''} ${version ?? ''} withdrawn`.replace(/\s+/g, ' ')
    case 'release_deleted':
      return `Release ${product ?? ''} ${version ?? ''} deleted`.replace(/\s+/g, ' ')
    case 'preflight':
      return `${who}: dry run for ${to ?? version ?? 'an update'}`
    case 'job_created':
      return `${who}: update to ${to ?? 'a new version'} requested`
    case 'job_aborted':
      return `${who}: update stopped`
    case 'rollout_created':
      return `Rollout of ${product ?? ''} ${version ?? ''} created`.replace(/\s+/g, ' ')
    case 'rollout_resumed':
      return 'Rollout resumed'
    case 'rollout_cancelled':
      return 'Rollout cancelled'
    default:
      return event.event.replace(/^agent_update\./, '').replace(/_/g, ' ')
  }
}

export function actorText(actor: AgentUpdateEvent['actor']): string | null {
  if (!actor) return null
  if ('name' in actor) return actor.name
  switch (actor.system) {
    case 'rollout':
      return 'Rollout'
    case 'auto_update':
      return 'Auto-update'
    case 'github_check':
      return 'GitHub check'
    case 'agent':
      return 'Device'
    default:
      return actor.system.replace(/_/g, ' ')
  }
}

// ── API refusals ───────────────────────────────────────────────────────────

const REFUSALS: Record<string, string> = {
  device_not_found: 'That device no longer exists.',
  job_not_found: 'That update no longer exists.',
  release_not_found: 'That release is not on this controller.',
  rollout_not_found: 'That rollout no longer exists.',
  agent_offline: 'The device is offline.',
  agent_timeout: 'The device did not answer in time.',
  self_update_unsupported: 'The device cannot update itself.',
  no_matching_artefact: 'The release has no file for this device.',
  release_not_offerable: 'This release cannot be offered.',
  agent_refused: 'The device refused.',
  update_in_progress: 'An update is already running on this device.',
  same_version: 'The device already runs this version.',
  rollout_owns_device: 'A rollout is updating this device.',
  no_previous: 'There is no previous version on the device.',
  job_final: 'That update has already finished.',
  github_unreachable: 'GitHub could not be reached.',
  unknown_key: 'The release is signed with a key this controller does not trust.',
  bad_signature: 'The signature does not match the manifest.',
  manifest_invalid: 'The manifest is not a valid Perch release manifest.',
  release_exists_different: 'This version already exists with a different manifest.',
  artefact_not_in_manifest: 'The manifest does not list this file.',
  hash_mismatch: 'The file does not match the hash in the manifest.',
  size_mismatch: 'The file’s size does not match the manifest.',
  too_large: 'The file is larger than 64 MiB.',
  release_in_use: 'Devices, updates or rollouts still use this release.',
  rollout_open: 'Another rollout of this product is still open.',
  no_eligible_devices: 'No device can take this release.',
  canary_not_in_rollout: 'The canary must be one of the rollout’s devices.',
  rollout_final: 'That rollout has finished.',
  rollout_not_paused: 'That rollout is not paused.',
}

function body(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof ApiError)) return null
  return typeof error.body === 'object' && error.body !== null ? (error.body as Record<string, unknown>) : null
}

/** A refusal in words: the known code's text plus what its body adds, else the server's message. */
export function refusalMessage(error: unknown): string {
  const code = apiErrorCode(error)
  const b = body(error)
  if (code && REFUSALS[code]) {
    let text = REFUSALS[code]
    if (code === 'agent_refused' || code === 'self_update_unsupported' || code === 'release_not_offerable') {
      const inner = str(b, 'code') ?? str(b, 'reason')
      const said = reasonText(inner) ?? (typeof b?.message === 'string' ? b.message : null)
      if (said && inner) text = `${text} ${said}.`
    }
    if (code === 'no_matching_artefact') {
      const parts = ['method', 'arch', 'pkgArch', 'manager', 'series'].map((k) => str(b, k)).filter(Boolean)
      if (parts.length > 0) text = `${text} (${parts.join(', ')})`
    }
    if (code === 'unknown_key' && str(b, 'keyId')) text = `${text} Key ${str(b, 'keyId')}.`
    if (code === 'manifest_invalid' && str(b, 'detail')) text = `${text} ${str(b, 'detail')}`
    if (code === 'release_in_use') {
      const n = ['devices', 'jobs', 'rollouts']
        .map((k) => [k, Number(b?.[k] ?? 0)] as const)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${v} ${k}`)
      if (n.length > 0) text = `${text} (${n.join(', ')})`
    }
    const need = b?.needBytes
    const free = b?.freeBytes
    if (typeof need === 'number' && typeof free === 'number') {
      text = `${text} Needs ${formatBytes(need)}, ${formatBytes(free)} free.`
    }
    return text
  }
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}

export function refusalField<T>(error: unknown, field: string): T | undefined {
  return (body(error)?.[field] as T | undefined) ?? undefined
}

// ── Time ───────────────────────────────────────────────────────────────────

export function secondsUntil(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : Math.round((t - now) / 1000)
}

export function formatCountdown(seconds: number): string {
  const s = Math.max(0, seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
  return `${m}:${String(rest).padStart(2, '0')}`
}

export function formatAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  const s = Math.round((now - t) / 1000)
  if (s < 10) return 'just now'
  if (s < 60) return `${s} s ago`
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

/** "in 5 h", "in 12 min", "now". */
export function formatIn(iso: string | null | undefined, now = Date.now()): string | null {
  const s = secondsUntil(iso, now)
  if (s === null) return null
  if (s <= 0) return 'now'
  if (s < 90) return `in ${s} s`
  if (s < 90 * 60) return `in ${Math.round(s / 60)} min`
  if (s < 36 * 3600) return `in ${Math.round(s / 3600)} h`
  return `in ${Math.round(s / 86400)} d`
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** A time as the instance time zone's wall clock ("Tue 02:00"). */
export function formatInZone(iso: string | null | undefined, timeZone: string): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  try {
    return d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone })
  } catch {
    return d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
  }
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

// ── Devices ────────────────────────────────────────────────────────────────

/** Where the device's own page is (the AP page or the gateway overview). */
export function devicePagePath(device: Pick<AgentUpdateDevice, 'kind' | 'id' | 'role'>): string | null {
  if (device.kind === 'ap') return `/wifi/aps/${device.id}`
  if (device.role === 'gateway') return '/gateway'
  return '/settings/collectors'
}

export type FleetFilter = 'all' | 'current' | 'update_available' | 'updating' | 'manual'

export function deviceMatchesFilter(device: AgentUpdateDevice, filter: FleetFilter): boolean {
  switch (filter) {
    case 'current':
      return device.activeJob === null && device.selfUpdate.supported && device.available === null
    case 'update_available':
      return device.activeJob === null && device.available !== null
    case 'updating':
      return device.activeJob !== null
    case 'manual':
      return !device.selfUpdate.supported
    default:
      return true
  }
}

/** Whether the version is older than what this controller pins for fresh installs. */
export function isBelowController(device: AgentUpdateDevice): boolean {
  return device.versionState === 'below_controller'
}
