import { ApiError } from '@/lib/api'
import { formatLastSeen } from '@/lib/collectors'
import type {
  ApAgentAsset,
  ApAgentInstallInfo,
  ApJoinToken,
  ApJoinTokenStatus,
  WifiApControls,
} from '@/types/api'

/**
 * Presentation helpers for Perch AP Daemon (`perch-apd`): join tokens, install
 * commands and the AP command controls. Pure: no fetching, no React.
 */

/** The `{ "error": "code" }` the API returns for domain failures. */
export function apiErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null
  const body = error.body
  if (typeof body !== 'object' || body === null || !('error' in body)) return null
  const code = (body as { error: unknown }).error
  return typeof code === 'string' ? code : null
}

const COMMAND_ERROR_FALLBACKS: Record<string, string> = {
  agent_offline: 'The Perch AP Daemon on this AP is offline.',
  agent_timeout: 'The agent did not answer in time.',
  wifi_client_not_associated: 'The client is not associated with this AP any more.',
  wifi_command_unsupported: 'This AP cannot do that.',
  wifi_commands_not_enabled: 'This AP has no command channel.',
  wifi_client_not_found: 'No WiFi data has been recorded for this client.',
  wifi_source_not_found: 'This AP no longer exists.',
}

/**
 * The server's own message when it sent one (it names the client, the AP or
 * the failing command), else a line for the error code, else `fallback`.
 */
export function wifiCommandErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const code = apiErrorCode(error)
    const body = error.body
    const hasServerMessage =
      typeof body === 'object' &&
      body !== null &&
      'message' in body &&
      typeof (body as { message: unknown }).message === 'string'
    if (hasServerMessage) return error.message
    if (code && COMMAND_ERROR_FALLBACKS[code]) return COMMAND_ERROR_FALLBACKS[code]
    if (error.status === 403) return 'Only admins can send AP commands.'
    return error.message
  }
  return fallback
}

export type WifiApAction = 'kick' | 'steer' | 'locate' | 'reboot'

const UNSUPPORTED: Record<WifiApAction, string> = {
  kick: 'Its agent cannot disconnect clients (hostapd on the AP has no ubus interface).',
  steer: 'Its agent cannot disconnect clients (hostapd on the AP has no ubus interface).',
  locate: 'Its agent found no LEDs to blink.',
  reboot: 'Its agent cannot reboot this device.',
}

/** Why `action` is unavailable on an AP, or `null` when it is available. */
export function controlDisabledReason(controls: WifiApControls, action: WifiApAction): string | null {
  if (controls[action]) return null
  if (controls.via === null) {
    return 'No command channel. Install Perch AP Daemon (perch-apd) on this AP, or enable SSH commands under Settings → WiFi sources.'
  }
  if (controls.via === 'agent' && !controls.online) {
    return 'The Perch AP Daemon on this AP is offline.'
  }
  return UNSUPPORTED[action]
}

export const JOIN_TOKEN_EXPIRY_OPTIONS = [
  { id: '1h', label: '1 h', hours: 1 },
  { id: '24h', label: '24 h', hours: 24 },
  { id: '7d', label: '7 d', hours: 24 * 7 },
  { id: '30d', label: '30 d', hours: 24 * 30 },
  { id: 'never', label: 'Never', hours: null },
] as const

export type JoinTokenExpiryId = (typeof JOIN_TOKEN_EXPIRY_OPTIONS)[number]['id']

export function expiryHours(id: JoinTokenExpiryId): number | null {
  return JOIN_TOKEN_EXPIRY_OPTIONS.find((option) => option.id === id)?.hours ?? null
}

export function joinTokenStatusLabel(status: ApJoinTokenStatus): string {
  if (status === 'active') return 'Active'
  if (status === 'expired') return 'Expired'
  if (status === 'exhausted') return 'Used up'
  return 'Revoked'
}

export function joinTokenStatusDotClass(status: ApJoinTokenStatus): string {
  if (status === 'active') return 'bg-status-good'
  if (status === 'revoked') return 'bg-status-critical'
  return 'bg-muted-foreground/50'
}

/** "2 / ∞", "1 / 1". */
export function formatTokenUses(token: Pick<ApJoinToken, 'useCount' | 'maxUses'>): string {
  return `${token.useCount} / ${token.maxUses ?? '∞'}`
}

/** "never", "in 23 h", "expired 2 h ago". */
export function formatTokenExpiry(expiresAt: string | null, now = Date.now()): string {
  if (!expiresAt) return 'never'
  const at = Date.parse(expiresAt)
  if (!Number.isFinite(at)) return 'never'
  const seconds = (at - now) / 1000
  if (seconds <= 0) return `expired ${formatLastSeen(expiresAt, now)}`
  if (seconds < 90) return `in ${Math.round(seconds)} s`
  if (seconds < 3600) return `in ${Math.round(seconds / 60)} min`
  if (seconds < 86_400) return `in ${(seconds / 3600).toFixed(1)} h`
  return `in ${Math.round(seconds / 86_400)} d`
}

/** POSIX-sh-safe word: bare when it only has URL-ish characters, else single-quoted. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export type InstallCommands = {
  /** Downloads install.sh, which picks the architecture and checks the checksum. */
  oneLiner: string
  /** Downloads one architecture's binary and runs `--install`. */
  manual: string
  /** For an AP that already has the binary (package or earlier install). */
  join: string
}

/** The three commands from docs/ap-controller.md §4.2. */
export function buildInstallCommands(
  info: Pick<ApAgentInstallInfo, 'controllerUrl' | 'releaseBaseUrl' | 'installScriptUrl'>,
  token: string,
  asset: Pick<ApAgentAsset, 'file'> | undefined,
): InstallCommands {
  const controller = shellQuote(info.controllerUrl)
  const quotedToken = shellQuote(token)
  const flags = `--controller ${controller} --token ${quotedToken}`
  const base = info.releaseBaseUrl.replace(/\/+$/, '')
  const binaryUrl = shellQuote(`${base}/${asset?.file ?? 'perch-apd-linux-<arch>'}`)
  return {
    oneLiner: `wget -qO- ${shellQuote(info.installScriptUrl)} | sh -s -- ${flags}`,
    manual: `wget -O /tmp/perch-apd ${binaryUrl} && chmod +x /tmp/perch-apd && /tmp/perch-apd --install ${flags}`,
    join: `perch-apd join ${flags}`,
  }
}

const CAPABILITY_LABELS: Record<string, string> = {
  metrics: 'Metrics',
  clients: 'Client list',
  kick: 'Kick / steer',
  locate: 'Locate',
  reboot: 'Reboot',
}

export function agentCapabilityLabel(capability: string): string {
  return CAPABILITY_LABELS[capability] ?? capability
}
