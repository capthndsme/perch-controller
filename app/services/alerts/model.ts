import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type { DateTime } from 'luxon'

/**
 * Shared vocabulary of the alerts area (docs/design/alerts/README.md §2.2,
 * events.md §1.3, api.md §2). Types only, plus the constant lists the
 * validators and the migrations use; no behaviour and no imports of other
 * alerts modules, so every file (and every other area) can import it freely.
 */

export const SEVERITIES = ['info', 'warning', 'critical'] as const
export type Severity = (typeof SEVERITIES)[number]

/** Higher is worse. */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  info: 0,
  warning: 1,
  critical: 2,
}

export const CATEGORIES = [
  'agents',
  'wan',
  'gateway',
  'wifi',
  'network',
  'portal',
  'updates',
  'system',
] as const
export type Category = (typeof CATEGORIES)[number]

export const CATEGORY_LABELS: Readonly<Record<Category, string>> = {
  agents: 'Devices Perch talks to',
  wan: 'Internet (WAN)',
  gateway: 'Gateway configuration',
  wifi: 'Wi-Fi',
  network: 'Network and devices',
  portal: 'Guest portal and hotspot',
  updates: 'Updates',
  system: 'Perch itself',
}

export const SUBJECT_KINDS = [
  'collector',
  'ap',
  'gateway',
  'network',
  'ssid',
  'device',
  'port',
  'portal',
  'terminal',
  'controller',
] as const
export type SubjectKind = (typeof SUBJECT_KINDS)[number]

/** What an alert is about. `ref` is a string so every kind fits one column. */
export type AlertSubject =
  | { kind: 'collector'; id: number }
  | { kind: 'ap'; id: number } // wifi_access_points.id
  | { kind: 'gateway'; id: number } // gateways.id
  | { kind: 'network'; gatewayId: number; name: string } // UCI interface name
  | { kind: 'ssid'; name: string }
  | { kind: 'device'; mac: string } // lowercase aa:bb:…
  | { kind: 'port'; id: number } // infra_ports.id
  | { kind: 'portal'; id: number }
  | { kind: 'terminal'; id: number } // hotspot_terminals.id
  | { kind: 'controller' }

export const ALERT_KINDS = ['condition', 'notice'] as const
export type AlertKind = (typeof ALERT_KINDS)[number]

export const ALERT_STATES = ['pending', 'active', 'resolved', 'posted'] as const
export type AlertState = (typeof ALERT_STATES)[number]

export const EVENT_PHASES = ['raise', 'clear', 'instant'] as const
export type EventPhase = (typeof EVENT_PHASES)[number]

/** Why a notification goes out. */
export const TRANSITIONS = [
  'opened',
  'escalated',
  'flapping',
  'reminder',
  'resolved',
  'digest',
  'test',
] as const
export type Transition = (typeof TRANSITIONS)[number]

export const DELIVERY_STATUSES = [
  'queued',
  'grouping',
  'held',
  'sending',
  'retrying',
  'sent',
  'failed',
  'expired',
  'collapsed',
] as const
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number]

/** `alert_events.outcome`: what the engine did with an event. */
export const EVENT_OUTCOMES = [
  'opened',
  'updated',
  'escalated',
  'reopened',
  'resolved',
  'blip',
  'posted',
  'merged',
  'disabled',
  'unknown_type',
  'invalid_subject',
  'boot_grace',
  'no_active',
  'withheld_mass',
] as const
export type EventOutcome = (typeof EVENT_OUTCOMES)[number]

export type TypeOwner = 'alerts' | 'wifi' | 'gateway-sync' | 'agent-updates'

export type ParamValue = number | boolean | string | string[]

/** The effective behaviour of one alert type (catalogue default ⊕ the admin's override). */
export type Rule = {
  /** Record alerts in the inbox at all. */
  enabled: boolean
  /** Send to destinations. */
  notify: boolean
  severity: 'auto' | Severity
  /** Conditions: must hold this long before notifying. [0, 3600] */
  holdSeconds: number
  /** Conditions: must stay clear this long before "back". [0, 600] */
  recoveryHoldSeconds: number
  notifyRecovery: boolean
  /** Transitions in the window that make it "flapping"; 0 = off. [0, 20] */
  flapThreshold: number
  /** [1, 240] */
  flapWindowMinutes: number
  /** Batch same-type notifications per destination. [0, 3600] */
  groupSeconds: number
  /** Notices: same key within this merges. [0, 1440] */
  dedupeMinutes: number
  /** Conditions: reminder interval, 0 = never. 0 or [15, 1440] */
  repeatMinutes: number
  /** Notifications of this type per hour, 0 = unlimited. [0, 1000] */
  maxPerHour: number
  push: boolean
  webhooks: boolean
  /** Type-specific, declared with limits in the catalogue (`AlertTypeDef.params`). */
  params: Record<string, ParamValue>
}

export type ParamDef =
  | {
      key: string
      label: string
      kind: 'int'
      default: number
      min: number
      max: number
      unit?: string
    }
  | { key: string; label: string; kind: 'bool'; default: boolean }
  | { key: string; label: string; kind: 'enum'; default: string; options: string[] }
  | {
      key: string
      label: string
      kind: 'list'
      default: string[]
      maxItems: number
      maxLength: number
    }

/** One alert as a type's `render` sees it. */
export type RenderInput = {
  /** Null while rendering an alert that is not stored (out-of-band path, previews). */
  id: number | null
  type: string
  kind: AlertKind
  state: AlertState
  severity: Severity
  flapping: boolean
  subject: { kind: SubjectKind; ref: string; label: string | null }
  /** Subject label, else the subject key: what a text calls the subject. */
  label: string
  /** The latest event's payload (`{}` when none). */
  payload: Record<string, unknown>
  firstRaisedAt: DateTime
  /** Start of the current (or, once resolved, the last) episode: "since 14:02". */
  raisedAt: DateTime
  openedAt: DateTime | null
  resolvedAt: DateTime | null
  eventCount: number
  transitions: number
}

export type RenderContext = {
  transition: Transition
  /** False → a "was … from–to" text (collapse on resolve). */
  wasNotified: boolean
  /** Destination with `detail: minimal`: no MACs, IPs, client host names. */
  redact: boolean
  /** Instance time zone, for "since 14:02". */
  zone: string
  now: DateTime
  /** Set on the one notice that ends a flapping period (README §2.3 item 6). */
  flapEnded?: boolean
}

export type RenderedText = { title: string; body: string; path?: string }

export type AlertTypeDef = {
  /** `<namespace>.<what>`, snake_case, ≤ 64 characters. */
  type: string
  category: Category
  kind: AlertKind
  /** Default severity. */
  severity: Severity
  /** Accepted subject kinds (validated at emit). */
  subjects: SubjectKind[]
  owner: TypeOwner
  /** Settings page: "Access point offline". */
  label: string
  /** One sentence for the settings page. */
  description: string
  /** Over the kind's base rule (events.md §1.3). */
  defaults?: Partial<Omit<Rule, 'params'>>
  /** Type-specific tunables, shown in the rule drawer. */
  params?: ParamDef[]
  /** Null when usable; else why not (greys the type in settings). */
  available?: () => Promise<string | null>
  /** Texts for one alert. */
  render(alert: RenderInput, ctx: RenderContext): RenderedText
  /** Texts for several alerts of this type in one message. */
  renderGroup?(alerts: RenderInput[], ctx: RenderContext): { title: string; body: string }
  /**
   * Payload keys that are personal data (MACs, IPs, client host names,
   * public IPs): removed for `detail: minimal` destinations.
   */
  pii?: string[]
  /**
   * Agent-silence conditions: a NEW alert is not raised while the controller
   * is in its boot grace (event outcome `boot_grace`, README §2.3 item 11).
   * Clears always pass, and an alert that already exists keeps its state.
   */
  bootGrace?: boolean
  /**
   * A NEW alert of this type is not raised while any alert of these types is
   * pending or active (event outcome `withheld_mass`): the mass-offline guard
   * and "a device looks gone because its AP is" (events.md §3.1, §3.5).
   */
  withheldBy?: string[]
}

export type EmitInput = {
  /** Catalogue name, e.g. 'ap.offline'. Unknown names are logged and dropped. */
  type: string
  /** raise/clear for conditions, instant for notices. Default: from the catalogue (conditions: raise). */
  phase?: EventPhase
  subject: AlertSubject
  /** Default `${type}:${subjectKey(subject)}`. One active alert per key. ≤ 191 chars. */
  dedupeKey?: string
  /** Default: the catalogue's. A detector may pass a computed one (wan.down: critical when it was the last WAN). */
  severity?: Severity
  /** Facts for the text and for webhooks. JSON, ≤ 4 KB serialised (longer: dropped to {_truncated: true}). No secrets, no guest MACs. */
  payload?: Record<string, unknown>
  /** Default: now (server clock). */
  occurredAt?: DateTime
  /** Emitted inside a transaction: queued only after it commits, never after a rollback. */
  trx?: TransactionClientContract
  /** Module name for the event log, e.g. 'wifi_apply'. ≤ 48 chars. */
  source?: string
}

/** One condition that holds right now, as `reconcileConditions` takes it. */
export type ConditionInput = EmitInput & { dedupeKey: string }

export type EmitFn = (input: EmitInput) => void
export type ReconcileFn = (
  types: string[],
  current: ConditionInput[],
  options?: { scope?: string }
) => Promise<void>

/** Global alert settings (`system_settings` key `alerts`, README §2.6). */
export type AlertsSettings = {
  /** Base of links in webhook messages. null = the origin the admin's browser last saved settings from. */
  dashboardUrl: string | null
  /** The origin the last settings PATCH came from (links use it while `dashboardUrl` is null). */
  capturedOrigin: string | null
  quietHours: {
    enabled: boolean
    /** 'HH:mm' */
    start: string
    end: string
    breakThrough: 'critical' | 'none'
  }
  bootGraceSeconds: number
  massOffline: { enabled: boolean; fractionPercent: number; minAgents: number }
  destinationRateLimit: { max: number; windowMinutes: number }
  pushTtlMinutes: { critical: number; warning: number; info: number }
  webhookRetryHours: number
  retention: { eventDays: number; alertDays: number; deliveryDays: number }
  /** `url` is stored APP_KEY-encrypted (`urlEncrypted`); only `configured` / `urlDisplay` leave the server. */
  heartbeat: { urlEncrypted: string | null; urlDisplay: string | null; intervalSeconds: number }
  vapidSubject: string | null
  allowAnyPushService: boolean
  /** Overrides only; defaults come from the catalogue. */
  rules: Record<string, Partial<Rule>>
}

/** Per-detector key/value state in `alert_detector_states`. */
export type DetectorState = {
  get<T>(key: string): Promise<T | null>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

export type DetectorContext = {
  now: DateTime
  /** Read once per tick. */
  settings: AlertsSettings
  /** Effective rule, params included. */
  rule(type: string): Rule
  inBootGrace: boolean
  /** `alert_detector_states`, scoped to the detector id. */
  state: DetectorState
  reconcile: ReconcileFn
  emit: EmitFn
}

export type DetectorPeriod = 15 | 60 | 300 | 900

export type DetectorDef = {
  id: string
  everySeconds: DetectorPeriod
  /** Alert types this detector feeds; when all are disabled the detector is skipped. Empty = always run. */
  types?: string[]
  run(ctx: DetectorContext): Promise<void>
}
