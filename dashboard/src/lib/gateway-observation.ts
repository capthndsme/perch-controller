import { apiErrorCode, ApiError } from '@/lib/api'
import type {
  DhcpLease,
  GatewayDeviceRef,
  GatewayFeatureDecision,
  GatewayObservationOverview,
  GatewayObservationPart,
  GatewayWanStatus,
} from '@/types/api'

/**
 * Pure wording and shaping for the gateway observation views (the Gateway
 * page, the device page's Network card). The API decides every fact; these
 * only say it.
 */

export const PART_LABELS: Record<GatewayObservationPart, string> = {
  interfaces: 'Interfaces',
  neighbors: 'Neighbours',
  dhcp: 'DHCP leases',
  upnp: 'UPnP',
  mwan3: 'mwan3',
  resolver: 'Resolver',
  system: 'System',
  wireguard: 'WireGuard',
  packages: 'Packages',
}

/** The order the freshness list shows parts in. */
export const PART_ORDER: GatewayObservationPart[] = [
  'interfaces',
  'dhcp',
  'neighbors',
  'upnp',
  'mwan3',
  'resolver',
  'system',
  'wireguard',
  'packages',
]

/** The one capability an on-demand refresh needs (hello `capabilities`). */
export const OBSERVE_CAPABILITY = 'gateway.observe'
export const BACKUP_CAPABILITY = 'gateway.backup'

/**
 * What the Gateway agent can tell: `full` reports router state, `none` is an
 * older collector that only sends traffic and gateway stats, `unknown` when
 * nothing says either way (offline or polled, and nothing observed yet).
 */
export type ObservationSupport = 'full' | 'none' | 'unknown'

export function observationSupport(overview: GatewayObservationOverview): ObservationSupport {
  const reported = Object.keys(overview.parts).length > 0
  if (reported) return 'full'
  const caps = overview.capabilities
  if (caps === null) return 'unknown'
  return caps.some((c) => c.startsWith('observe.')) ? 'full' : 'none'
}

/** The session announced the capability; null while offline or polled (nothing to ask). */
export function hasCapability(overview: GatewayObservationOverview | undefined, capability: string): boolean | null {
  if (!overview || overview.capabilities === null) return null
  return overview.capabilities.includes(capability)
}

/** "just now", "in 12 h", "in 1187 d", "3 min ago": a time relative to now. */
export function formatRelative(timestamp: string | null | undefined, now = Date.now()): string {
  if (!timestamp) return '—'
  const at = Date.parse(timestamp)
  if (!Number.isFinite(at)) return '—'
  const seconds = (at - now) / 1000
  const abs = Math.abs(seconds)
  let span: string
  if (abs < 10) return 'just now'
  if (abs < 90) span = `${Math.round(abs)} s`
  else if (abs < 3600) span = `${Math.round(abs / 60)} min`
  else if (abs < 86_400) span = `${(abs / 3600).toFixed(1)} h`
  else span = `${Math.round(abs / 86_400)} d`
  return seconds > 0 ? `in ${span}` : `${span} ago`
}

/** "Mar 4, 2029, 10:12". */
export function formatDateTime(timestamp: string | null | undefined): string {
  if (!timestamp) return '—'
  const at = Date.parse(timestamp)
  if (!Number.isFinite(at)) return timestamp
  return new Intl.DateTimeFormat([], { dateStyle: 'medium', timeStyle: 'short' }).format(at)
}

/** A lease's expiry: "never" for an infinite lease, "expired …" for one in the past. */
export function formatLeaseExpiry(lease: Pick<DhcpLease, 'expiresAt' | 'infinite' | 'family'>, now = Date.now()): string {
  if (lease.infinite) return 'never (infinite)'
  if (!lease.expiresAt) return lease.family === 6 ? '—' : 'unknown'
  const at = Date.parse(lease.expiresAt)
  if (Number.isFinite(at) && at < now) return `expired ${formatRelative(lease.expiresAt, now)}`
  return formatRelative(lease.expiresAt, now)
}

/** "3 d 4 h", "5 h 12 min", "42 min", "18 s". */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—'
  const s = Math.max(0, Math.floor(seconds))
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d} d ${h} h`
  if (h > 0) return `${h} h ${m} min`
  if (m > 0) return `${m} min`
  return `${s} s`
}

/** The name a row shows: Perch's device name, then the router's static name, then the lease's hostname. */
export function hostDisplayName(
  device: GatewayDeviceRef | null,
  staticName: string | null,
  hostname: string | null,
): string | null {
  return device?.name ?? staticName ?? hostname ?? null
}

/** A byte count as "20 KB" for backups (1024-based, one decimal). */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// ── multi-WAN ──────────────────────────────────────────────────────────────

export type WanMode = 'none' | 'single' | 'metric' | 'mwan3'

export type WanSummary = {
  mode: WanMode
  title: string
  detail: string
  /** mwan3 is installed and something about it deserves attention. */
  mwan3Warning: { title: string; detail: string } | null
  mwan3Installed: boolean
}

const METRIC_FAILOVER_DETAIL =
  'The route with the lowest metric carries all traffic; the next one takes over only when that link goes down. There are no health checks: an upstream that dies while its link stays up does not move traffic.'

/**
 * How the router spreads or fails over WAN traffic, from what it reports:
 * several default routes with metrics ("failover by route metric"), mwan3
 * running, or one WAN. mwan3's config and service state are reported apart:
 * installed and configured but disabled is a common, quiet trap, so it gets
 * its own warning (the live network runs exactly that).
 */
export function wanSummary(status: GatewayWanStatus): WanSummary {
  const routes = status.defaultRoutes
  const mwan3 = status.mwan3
  const service = mwan3?.service ?? null
  const installed = mwan3 !== null && service?.installed !== false
  const running = service?.running === true
  const enabled = service?.enabled === true
  const configured = (mwan3?.configInterfaces.length ?? 0) > 0

  let mwan3Warning: WanSummary['mwan3Warning'] = null
  if (installed && !running) {
    const fallback =
      routes.length >= 2
        ? ` Failover is by route metric only (${routes.join(' → ')}).`
        : ' It does nothing until it runs.'
    if (enabled) {
      mwan3Warning = {
        title: 'mwan3 is enabled but not running',
        detail: `mwan3 starts at boot but its tracker is not running now.${fallback}`,
      }
    } else {
      mwan3Warning = {
        title: configured ? 'mwan3 is configured but disabled' : 'mwan3 is installed but disabled',
        detail: `The mwan3 service neither starts at boot nor runs, so its interfaces and policies${configured ? '' : ' (none configured)'} have no effect.${fallback} Perch shows mwan3 read-only and does not change it.`,
      }
    }
  } else if (installed && running && !enabled) {
    mwan3Warning = {
      title: 'mwan3 runs but will not start at boot',
      detail: 'mwan3 is running now, but its service is disabled: after a reboot the router falls back to plain route metrics.',
    }
  }

  if (installed && running) {
    const policies = Object.keys(mwan3?.policies ?? {})
    return {
      mode: 'mwan3',
      title: 'mwan3 load balancing / failover',
      detail:
        policies.length > 0
          ? `mwan3 tracks each WAN and routes by policy (${policies.join(', ')}).`
          : 'mwan3 tracks each WAN; no live policy is reported.',
      mwan3Warning,
      mwan3Installed: true,
    }
  }
  if (routes.length >= 2) {
    return {
      mode: 'metric',
      title: 'Failover by route metric',
      detail: `${routes.length} default routes, lowest metric first: ${routes.join(' → ')}. ${METRIC_FAILOVER_DETAIL}`,
      mwan3Warning,
      mwan3Installed: installed,
    }
  }
  if (routes.length === 1) {
    return {
      mode: 'single',
      title: 'One WAN',
      detail: `All internet traffic leaves through ${routes[0]}.`,
      mwan3Warning,
      mwan3Installed: installed,
    }
  }
  return {
    mode: 'none',
    title: 'No default route reported',
    detail: 'The router reported no interface with a default route.',
    mwan3Warning,
    mwan3Installed: installed,
  }
}

/** "yes" / "no" / "unknown" for a tri-state flag. */
export function yesNo(value: boolean | null | undefined): string {
  if (value === true) return 'yes'
  if (value === false) return 'no'
  return 'unknown'
}

// ── features ───────────────────────────────────────────────────────────────

export const FEATURE_LABELS: Record<string, string> = {
  upnp: 'UPnP (miniupnpd)',
  mwan3: 'mwan3',
  pbr: 'Policy-based routing (pbr)',
  sqm: 'SQM',
  opennds: 'openNDS',
  wireguard: 'WireGuard',
  ddns: 'Dynamic DNS',
  adguardhome: 'AdGuard Home',
  adblock: 'adblock',
  banip: 'banIP',
  unbound: 'Unbound',
  nlbwmon: 'nlbwmon',
  vnstat: 'vnStat',
  natmap: 'natmap',
  luci: 'LuCI',
}

export const DECISION_LABELS: Record<GatewayFeatureDecision, { label: string; hint: string }> = {
  observe: { label: 'Observed', hint: 'Perch reads it and never changes it.' },
  manage: { label: 'Managed later', hint: 'Perch will manage it once gateway management ships.' },
  never: { label: 'Left alone', hint: 'Perch never touches it.' },
  later: { label: 'Later', hint: 'Not read yet.' },
}

// ── errors ─────────────────────────────────────────────────────────────────

const UPDATE_COLLECTOR =
  'Update perch-collector on the router to a release with the gateway observation channel.'

/** An on-demand refresh's failure, in words an admin can act on. */
export function observeErrorMessage(error: unknown): string {
  const code = apiErrorCode(error)
  if (code === 'gateway_capability_missing') {
    const capability =
      error instanceof ApiError && typeof error.body === 'object' && error.body !== null && 'capability' in error.body
        ? String((error.body as { capability: unknown }).capability)
        : null
    return capability && capability !== OBSERVE_CAPABILITY
      ? `The Gateway agent does not report ${capability.replace(/^observe\./, '')}. ${UPDATE_COLLECTOR}`
      : `This Gateway agent cannot refresh on demand. ${UPDATE_COLLECTOR}`
  }
  if (code === 'gateway_offline') return 'The Gateway agent is not connected, so it cannot be asked now. The page shows its last report.'
  if (code === 'agent_timeout') return 'The router did not answer within 20 s. Try again in a moment.'
  if (code === 'observe_failed') return 'The router answered with an error. Its last report stays on screen.'
  if (error instanceof ApiError && error.status === 403) return 'Only admins can refresh the gateway.'
  return error instanceof Error ? error.message : 'Refresh failed.'
}

/** A backup's failure, in words an admin can act on. */
export function backupErrorMessage(error: unknown): string {
  const code = apiErrorCode(error)
  if (code === 'gateway_capability_missing') return `This Gateway agent cannot take backups. ${UPDATE_COLLECTOR}`
  if (code === 'gateway_offline') return 'The Gateway agent is not connected. Backups are taken live from the router.'
  if (code === 'backup_redaction_required')
    return "The router only allows redacted backups. Leave \"Remove secrets\" on, or set gateway_backup 'full' in the router's /etc/config/perch-collector to allow full ones."
  if (code === 'backup_too_large') return 'The backup is larger than 8 MiB, the most Perch stores.'
  if (code === 'agent_timeout') return 'The router did not finish the backup within 60 s.'
  if (code === 'backup_failed') return 'The router could not create the backup (sysupgrade -b failed).'
  if (error instanceof ApiError && error.status === 403) return 'Only admins can take backups.'
  return error instanceof Error ? error.message : 'Backup failed.'
}
