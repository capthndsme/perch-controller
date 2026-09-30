import type {
  AlertState,
  DestinationRef,
  AlertView,
  Category,
  DeliveryStatus,
  PushService,
  Severity,
  SubjectKind,
  Transition,
  WebhookFormat,
  WebhookPreset,
} from '@/types/alerts'

/**
 * Labels, tones and formatting for the alerts pages and the bell (types in `types/alerts.ts`). The bell lives
 * in the entry chunk and imports from here: keep this module free of components and heavy imports.
 */

export const SEVERITIES: readonly Severity[] = ['info', 'warning', 'critical']

export const SEVERITY_LABEL: Record<Severity, string> = { info: 'Info', warning: 'Warning', critical: 'Critical' }

export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 }

/** Icon colour, and a chip's tint, per severity (index.css `--status-*`). */
export const SEVERITY_TONE: Record<Severity, { icon: string; chip: string }> = {
  critical: { icon: 'text-status-critical', chip: 'border-status-critical/40 bg-status-critical/10 text-status-critical' },
  warning: { icon: 'text-status-warning', chip: 'border-status-warning/50 bg-status-warning/15 text-foreground' },
  info: { icon: 'text-brand', chip: 'border-brand/30 bg-brand/10 text-foreground' },
}

/** Until the catalogue loads (the server sends its own labels with it). */
export const CATEGORY_LABEL: Record<Category, string> = {
  agents: 'Collectors and access points',
  wan: 'Internet (WAN)',
  gateway: 'Gateway configuration',
  wifi: 'Wi-Fi',
  network: 'Devices and ports',
  portal: 'Guest portal and hotspot',
  updates: 'Updates',
  system: 'Perch itself',
}

/** Short names for filter chips. */
export const CATEGORY_SHORT: Record<Category, string> = {
  agents: 'Agents',
  wan: 'Internet',
  gateway: 'Gateway',
  wifi: 'Wi-Fi',
  network: 'Devices & ports',
  portal: 'Portal',
  updates: 'Updates',
  system: 'System',
}

export const CATEGORIES = Object.keys(CATEGORY_LABEL) as Category[]

export function isCategory(value: string): value is Category {
  return value in CATEGORY_LABEL
}

export function isSeverity(value: string): value is Severity {
  return value === 'info' || value === 'warning' || value === 'critical'
}

export type StateChip = { label: string; tone: 'active' | 'resolved' | 'flapping' | 'muted' | 'pending' | 'notice' }

/** The chip a row shows: flapping and muted win over the plain state. */
export function alertStateChip(alert: Pick<AlertView, 'state' | 'flapping' | 'muted' | 'kind' | 'quietResolve'>): StateChip {
  if (alert.flapping && alert.state !== 'resolved') return { label: 'Flapping', tone: 'flapping' }
  if (alert.muted && (alert.state === 'active' || alert.state === 'pending')) return { label: 'Muted', tone: 'muted' }
  return STATE_CHIP[alert.state]
}

const STATE_CHIP: Record<AlertState, StateChip> = {
  active: { label: 'Active', tone: 'active' },
  pending: { label: 'Pending', tone: 'pending' },
  resolved: { label: 'Resolved', tone: 'resolved' },
  posted: { label: 'Notice', tone: 'notice' },
}

export const STATE_CHIP_CLASS: Record<StateChip['tone'], string> = {
  active: 'border-status-critical/35 bg-status-critical/10 text-status-critical',
  flapping: 'border-status-serious/40 bg-status-serious/10 text-foreground',
  pending: 'border-border bg-muted text-muted-foreground',
  resolved: 'border-status-good/35 bg-status-good/10 text-foreground',
  muted: 'border-border bg-muted text-muted-foreground',
  notice: 'border-border text-muted-foreground',
}

// ── Time ─────────────────────────────────────────────────────────────────

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now", "5 min ago", "3 h ago", "2 d ago", then the date. */
export function formatAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ''
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const diff = Math.max(0, now - at)
  if (diff < MINUTE) return 'just now'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} d ago`
  return new Intl.DateTimeFormat([], { dateStyle: 'medium' }).format(at)
}

/** Date and time in the browser's zone ("30 Sep, 14:02"); the year only when it is not this year. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—'
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  const sameYear = new Date(at).getFullYear() === new Date().getFullYear()
  return new Intl.DateTimeFormat([], {
    day: 'numeric',
    month: 'short',
    year: sameYear ? undefined : 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at)
}

/** "40 s", "7 min", "2 h 5 min", "3 d 4 h". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`
}

/** How long an alert has held (or held until it resolved). */
export function alertDurationSeconds(alert: Pick<AlertView, 'openedAt' | 'firstRaisedAt' | 'resolvedAt'>, now = Date.now()): number {
  const from = Date.parse(alert.openedAt ?? alert.firstRaisedAt)
  const to = alert.resolvedAt ? Date.parse(alert.resolvedAt) : now
  return Number.isNaN(from) || Number.isNaN(to) ? 0 : Math.max(0, (to - from) / 1000)
}

// ── Subjects ─────────────────────────────────────────────────────────────

export const SUBJECT_LABEL: Record<SubjectKind, string> = {
  collector: 'Collector',
  ap: 'Access point',
  gateway: 'Gateway',
  network: 'Network',
  ssid: 'SSID',
  device: 'Device',
  port: 'Port',
  portal: 'Guest portal',
  terminal: 'Coin terminal',
  controller: 'Perch',
}

/** The detail page's button to the subject's own page. */
export function subjectActionLabel(kind: SubjectKind, path: string | null): string {
  if (path?.startsWith('/portal/payments')) return 'Open payments'
  switch (kind) {
    case 'collector':
      return 'Open collectors'
    case 'ap':
      return 'Open access point'
    case 'gateway':
      return 'Open gateway configuration'
    case 'network':
      return 'Open networks'
    case 'ssid':
      return 'Open SSID'
    case 'device':
      return 'Open device'
    case 'port':
      return 'Show on the map'
    case 'portal':
      return 'Open portal'
    case 'terminal':
      return 'Open terminals'
    case 'controller':
      return 'Open settings'
  }
}

/** A subject label for a row: the snapshot label, else the kind and reference. */
export function subjectText(subject: AlertView['subject']): string {
  if (subject.label) return subject.label
  if (subject.kind === 'controller') return 'Perch'
  return `${SUBJECT_LABEL[subject.kind]} ${subject.ref}`
}

// ── Deliveries and events ────────────────────────────────────────────────

export const TRANSITION_LABEL: Record<Transition, string> = {
  opened: 'Opened',
  escalated: 'Escalated',
  flapping: 'Flapping',
  reminder: 'Reminder',
  resolved: 'Recovery',
  digest: 'Digest',
  test: 'Test',
}

export const DELIVERY_STATUS: Record<DeliveryStatus, { label: string; tone: 'good' | 'bad' | 'wait' | 'quiet' }> = {
  queued: { label: 'Queued', tone: 'wait' },
  grouping: { label: 'Grouping', tone: 'wait' },
  held: { label: 'Held', tone: 'wait' },
  sending: { label: 'Sending', tone: 'wait' },
  retrying: { label: 'Retrying', tone: 'wait' },
  sent: { label: 'Sent', tone: 'good' },
  failed: { label: 'Failed', tone: 'bad' },
  expired: { label: 'Expired', tone: 'bad' },
  collapsed: { label: 'Collapsed', tone: 'quiet' },
}

export const DELIVERY_TONE_CLASS: Record<'good' | 'bad' | 'wait' | 'quiet', string> = {
  good: 'border-status-good/35 bg-status-good/10 text-foreground',
  bad: 'border-status-critical/35 bg-status-critical/10 text-status-critical',
  wait: 'border-status-warning/45 bg-status-warning/10 text-foreground',
  quiet: 'border-border bg-muted text-muted-foreground',
}

/** A delivery's destination by name: the device's label or platform, the webhook's name. */
export function destinationName(destination: DestinationRef | null): string {
  if (!destination) return 'Removed destination'
  if (destination.kind === 'push') return destination.label || destination.platform || `Device #${destination.id}`
  return destination.name
}

export const HOLD_REASON_LABEL = { quiet_hours: 'quiet hours', rate_limit: 'rate limit' } as const

/** Event outcomes as the timeline says them. */
export function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case 'opened':
      return 'Raised'
    case 'updated':
      return 'Still holding'
    case 'escalated':
      return 'Severity rose'
    case 'reopened':
      return 'Came back'
    case 'resolved':
      return 'Cleared'
    case 'blip':
      return 'Cleared within the hold'
    case 'posted':
      return 'Posted'
    case 'merged':
      return 'Merged into this alert'
    case 'disabled':
      return 'Ignored: rule off'
    case 'boot_grace':
      return 'Ignored: controller starting'
    case 'no_active':
      return 'Nothing to clear'
    case 'withheld_mass':
      return 'Withheld: many devices silent'
    case 'unknown_type':
      return 'Unknown type'
    default:
      return outcome.replace(/_/g, ' ')
  }
}

export const PUSH_SERVICE_LABEL: Record<PushService, string> = {
  fcm: 'Google (FCM)',
  mozilla: 'Mozilla',
  apple: 'Apple',
  wns: 'Microsoft (WNS)',
  other: 'Other push service',
}

export const WEBHOOK_FORMAT_LABEL: Record<WebhookFormat, string> = {
  standard: 'JSON (Standard Webhooks)',
  ntfy: 'ntfy',
  gotify: 'Gotify',
  discord: 'Discord',
  slack: 'Slack',
  telegram: 'Telegram',
}

export const WEBHOOK_PRESET_LABEL: Record<WebhookPreset, string> = {
  generic: 'Generic JSON',
  homeassistant: 'Home Assistant',
  ntfy: 'ntfy',
  gotify: 'Gotify',
  discord: 'Discord',
  slack: 'Slack',
  telegram: 'Telegram',
}

// ── Payload facts ────────────────────────────────────────────────────────

/** `silentSeconds` → "Silent seconds", `apId` → "AP id". */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b(ap|ip|mac|wan|lan|ssid|id|url|vlan|uci)\b/g, (w) => (w === 'id' ? 'id' : w.toUpperCase()))
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

/** A payload value as one line of text. */
export function formatFact(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') {
    if (/seconds$/i.test(key)) return formatDuration(value)
    return value.toLocaleString()
  }
  if (typeof value === 'string') return ISO_TIME.test(value) ? formatWhen(value) : value
  if (Array.isArray(value)) return value.map((item) => formatFact('', item)).join(', ') || '—'
  return JSON.stringify(value)
}
