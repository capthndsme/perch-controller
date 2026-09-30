/**
 * Alerts REST (controller `docs/alerts.md`; design `docs/design/alerts/api.md` §2–§3). Mirrors the server's
 * shapes; times are ISO-8601 UTC strings, MACs lowercase.
 */

export type Severity = 'info' | 'warning' | 'critical'
export type Category = 'agents' | 'wan' | 'gateway' | 'wifi' | 'network' | 'portal' | 'updates' | 'system'
export type SubjectKind =
  | 'collector'
  | 'ap'
  | 'gateway'
  | 'network'
  | 'ssid'
  | 'device'
  | 'port'
  | 'portal'
  | 'terminal'
  | 'controller'
export type AlertKind = 'condition' | 'notice'
export type AlertState = 'pending' | 'active' | 'resolved' | 'posted'
export type Transition = 'opened' | 'escalated' | 'flapping' | 'reminder' | 'resolved' | 'digest' | 'test'
export type DeliveryStatus =
  | 'queued'
  | 'grouping'
  | 'held'
  | 'sending'
  | 'retrying'
  | 'sent'
  | 'failed'
  | 'expired'
  | 'collapsed'
export type WebhookFormat = 'standard' | 'ntfy' | 'gotify' | 'discord' | 'slack' | 'telegram'
export type PushService = 'fcm' | 'mozilla' | 'apple' | 'wns' | 'other'

/** fullName ?? email */
export type UserRef = { id: number; name: string }

export type AlertSubject = { kind: SubjectKind; ref: string; label: string | null }

export type AlertView = {
  id: number
  type: string
  category: Category
  kind: AlertKind
  state: AlertState
  severity: Severity
  flapping: boolean
  title: string
  body: string
  /** Dashboard path of the subject, e.g. "/wifi/aps/4". */
  path: string | null
  subject: AlertSubject
  firstRaisedAt: string
  openedAt: string | null
  lastEventAt: string
  resolvedAt: string | null
  /** Resolved within its hold (a blip). */
  quietResolve: boolean
  eventCount: number
  transitions: number
  notified: boolean
  muted: boolean
  /** For the requesting user. */
  unread: boolean
  acknowledged: { at: string; by: UserRef | null; note: string | null } | null
  /** Manual resolve. */
  resolvedBy: UserRef | null
}

export type AlertEventView = {
  id: number
  phase: 'raise' | 'clear' | 'instant'
  severity: Severity
  /** opened, updated, escalated, reopened, resolved, blip, posted, merged, … */
  outcome: string
  occurredAt: string
  source: string | null
  data: Record<string, unknown> | null
}

export type DestinationRef =
  | { kind: 'push'; id: number; label: string; platform: string | null; userId: number }
  | { kind: 'webhook'; id: number; name: string; format: WebhookFormat }

export type DeliveryView = {
  id: number
  alertId: number | null
  /** Grouped / digest items (includes alertId). */
  alertIds: number[]
  /** Null when the destination was deleted. */
  destination: DestinationRef | null
  transition: Transition
  status: DeliveryStatus
  holdReason: 'quiet_hours' | 'rate_limit' | null
  severity: Severity
  attempts: number
  lastStatusCode: number | null
  lastError: string | null
  createdAt: string
  sendAfter: string
  /** Null once final. */
  nextAttemptAt: string | null
  expiresAt: string
  sentAt: string | null
}

export type AttemptView = {
  attemptedAt: string
  durationMs: number
  statusCode: number | null
  outcome: 'sent' | 'retry' | 'failed'
  error: string | null
  /** ≤ 512 chars */
  responseExcerpt: string | null
}

export type Filters = {
  minSeverity: Severity
  /** null = all */
  categories: Category[] | null
  /** null = all */
  types: string[] | null
  quietHours: 'inherit' | 'ignore'
}

export type Rule = {
  enabled: boolean
  notify: boolean
  severity: 'auto' | Severity
  holdSeconds: number
  recoveryHoldSeconds: number
  notifyRecovery: boolean
  flapThreshold: number
  flapWindowMinutes: number
  groupSeconds: number
  dedupeMinutes: number
  repeatMinutes: number
  maxPerHour: number
  push: boolean
  webhooks: boolean
  params: Record<string, number | boolean | string | string[]>
}

export type ParamDef =
  | { key: string; label: string; kind: 'int'; default: number; min: number; max: number; unit?: string }
  | { key: string; label: string; kind: 'bool'; default: boolean }
  | { key: string; label: string; kind: 'enum'; default: string; options: string[] }
  | { key: string; label: string; kind: 'list'; default: string[]; maxItems: number; maxLength: number }

export type AlertTypeView = {
  type: string
  category: Category
  kind: AlertKind
  /** Catalogue default. */
  severity: Severity
  label: string
  description: string
  owner: 'alerts' | 'wifi' | 'gateway-sync' | 'agent-updates'
  subjects: SubjectKind[]
  params: ParamDef[]
  /** Catalogue default rule. */
  defaults: Rule
  available: boolean
  unavailableReason: string | null
}

export type MuteView = {
  id: number
  type: string | null
  subject: AlertSubject | null
  /** null = until removed */
  until: string | null
  reason: 'manual' | 'maintenance'
  source: string | null
  note: string | null
  createdBy: UserRef | null
  createdAt: string
}

export type WatchView = { mac: string; label: string | null; offline: boolean; arrival: boolean }

export type PushSubscriptionView = {
  id: number
  userId: number
  /** sha256 hex of the endpoint: the client finds "this device" by it. */
  endpointHash: string
  pushService: PushService
  label: string | null
  /** "Chrome on Android" */
  platform: string | null
  enabled: boolean
  state: 'active' | 'failing' | 'gone'
  filters: Filters
  vapidKeyId: string
  createdAt: string
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastError: string | null
}

export type WebhookPreset = 'generic' | 'homeassistant' | 'ntfy' | 'gotify' | 'discord' | 'slack' | 'telegram'

export type WebhookAuthType = 'none' | 'bearer' | 'basic' | 'header' | 'gotify' | 'telegram'

export type WebhookView = {
  id: number
  name: string
  format: WebhookFormat
  preset: WebhookPreset
  /** e.g. "https://discord.com/api/webhooks/1234…/••••" */
  urlDisplay: string
  /** Format standard: a signing secret exists. */
  signed: boolean
  auth: { type: WebhookAuthType; username?: string; headerName?: string }
  options: { chatId?: string; messageThreadId?: number; username?: string; topic?: string }
  filters: Filters
  detail: 'full' | 'minimal'
  respectQuietHours: boolean
  enabled: boolean
  state: 'active' | 'failing' | 'needs_secret'
  consecutiveFailures: number
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

// ── Responses ─────────────────────────────────────────────────────────────

export type AlertListResponse = { alerts: AlertView[]; nextCursor: string | null }

export type AlertSummary = {
  active: Record<Severity, number>
  unread: number
  /** ≤ 6, newest bumped first, blips excluded. */
  latest: AlertView[]
}

export type AlertCategoryView = { key: Category; label: string }

export type AlertCatalogue = { categories: AlertCategoryView[]; types: AlertTypeView[] }

export type AlertDetailView = AlertView & {
  /** Latest payload. */
  data: Record<string, unknown> | null
  /** Newest first, ≤ 50. */
  events: AlertEventView[]
  /** Newest first, ≤ 50. */
  deliveries: DeliveryView[]
  /** Effective rule of its type. */
  rule: Rule
  /** The mute that matched, if still active. */
  mutedBy: MuteView | null
}

export type AlertListFilters = {
  view?: 'active' | 'all'
  blips?: boolean
  minSeverity?: Severity
  categories?: Category[]
  types?: string[]
  /** `<kind>:<ref>` */
  subject?: string
  limit?: number
}

export type MuteInput = {
  type?: string
  subject?: { kind: SubjectKind; ref: string }
  minutes?: number
  until?: string
  note?: string
}

export type DeliveryListResponse = { deliveries: DeliveryView[]; nextCursor: number | null }

export type DeliveryDetailView = DeliveryView & { attempts: AttemptView[] }

export type PushConfig = {
  available: boolean
  reason: 'keys_unreadable' | 'delivery_disabled' | null
  vapidPublicKey: string
  vapidKeyId: string
  allowedServices: PushService[]
}

export type PushSubscriptionInput = {
  subscription: PushSubscriptionJSON
  vapidKeyId: string
  label?: string
  filters?: Partial<Filters>
}

export type PushSubscribeResponse = { subscription: PushSubscriptionView; renewToken: string }

export type PushSubscriptionPatch = { label?: string | null; enabled?: boolean; filters?: Partial<Filters> }

export type TestResult = {
  outcome: 'sent' | 'retry' | 'failed'
  statusCode: number | null
  error: string | null
  durationMs: number
  pushService?: PushService
  responseExcerpt?: string
}

export type DestinationTestResponse = { delivery: DeliveryView; result: TestResult }

export type AlertsGlobalSettings = {
  dashboardUrl: string | null
  /** What links use while dashboardUrl is null. */
  capturedOrigin: string | null
  quietHours: { enabled: boolean; start: string; end: string; breakThrough: 'critical' | 'none' }
  bootGraceSeconds: number
  massOffline: { enabled: boolean; fractionPercent: number; minAgents: number }
  destinationRateLimit: { max: number; windowMinutes: number }
  pushTtlMinutes: Record<Severity, number>
  webhookRetryHours: number
  retention: { eventDays: number; alertDays: number; deliveryDays: number }
  heartbeat: { configured: boolean; urlDisplay: string | null; intervalSeconds: number }
  vapidSubject: string | null
  allowAnyPushService: boolean
}

export type Limit = { min: number; max: number }

/** Every numeric setting's bounds; nested like the settings, plus `rule` for the per-type rule fields. */
export type AlertSettingsLimits = {
  bootGraceSeconds?: Limit
  massOffline?: { fractionPercent?: Limit; minAgents?: Limit }
  destinationRateLimit?: { max?: Limit; windowMinutes?: Limit }
  pushTtlMinutes?: Limit | Partial<Record<Severity, Limit>>
  webhookRetryHours?: Limit
  retention?: { eventDays?: Limit; alertDays?: Limit; deliveryDays?: Limit }
  heartbeat?: { intervalSeconds?: Limit }
  rule?: Partial<Record<keyof Rule, Limit>>
}

export type AlertSettingsView = {
  settings: AlertsGlobalSettings
  /** Effective rule of every type. */
  rules: Record<string, Rule>
  /** What is stored. */
  overrides: Record<string, Partial<Rule>>
  defaults: AlertsGlobalSettings
  limits: AlertSettingsLimits
  catalogue: AlertTypeView[]
  /** Instance zone the quiet hours use. */
  timezone: string
  vapid: { keyId: string; publicKey: string; createdAt: string; readable: boolean; subject: string } | null
  heartbeat: { lastPingAt: string | null; lastStatus: number | null; lastError: string | null }
  /** false when ALERTS_DELIVERY=off */
  deliveryEnabled: boolean
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] }

export type AlertSettingsPatch = Omit<DeepPartial<AlertsGlobalSettings>, 'capturedOrigin' | 'heartbeat'> & {
  /** `url` is write-only: a string sets it, null clears it. */
  heartbeat?: { url?: string | null; intervalSeconds?: number }
  /** null = back to the catalogue default. */
  rules?: Record<string, (Partial<Omit<Rule, 'params'>> & { params?: Rule['params'] }) | null>
}

export type VapidRotateResponse = { keyId: string; publicKey: string; createdAt: string; invalidated: number }

export type WebhookAuthInput =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'header'; name: string; value: string }
  | { type: 'gotify'; token: string }
  | { type: 'telegram'; botToken: string }

export type WebhookInput = {
  name: string
  format: WebhookFormat
  preset?: WebhookPreset
  url?: string
  auth?: WebhookAuthInput
  options?: { chatId?: string; messageThreadId?: number; username?: string }
  filters?: Partial<Filters>
  detail?: 'full' | 'minimal'
  respectQuietHours?: boolean
  enabled?: boolean
}

export type WebhookCreateResponse = { webhook: WebhookView; secret: string | null }
