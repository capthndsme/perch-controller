import SystemSetting from '#models/system_setting'
import type {
  AlertKind,
  AlertsSettings,
  AlertTypeDef,
  ParamDef,
  ParamValue,
  Rule,
  Severity,
} from '#services/alerts/model'
import { SEVERITIES } from '#services/alerts/model'
import encryption from '@adonisjs/core/services/encryption'

/**
 * Settings → Alerts (docs/design/alerts/README.md §2.6): one `system_settings`
 * row (key `alerts`), typed defaults, one limits table the validator and the
 * dashboard both use, read per use and never cached across requests (the
 * model is `presence_settings.ts`). Stored values outside the limits are
 * clamped; invalid ones read as the default.
 *
 * Rules: the catalogue gives each type its default rule (the kind's base
 * rule ⊕ the type's `defaults` ⊕ its params' defaults); the setting stores
 * only the admin's overrides, per type.
 */
export const ALERTS_SETTING_KEY = 'alerts'

type Range = { min: number; max: number }

/** Accepted ranges of the global settings (whole numbers). */
export const ALERTS_LIMITS = {
  bootGraceSeconds: { min: 30, max: 900 },
  massOffline: { fractionPercent: { min: 20, max: 100 }, minAgents: { min: 2, max: 50 } },
  destinationRateLimit: { max: { min: 1, max: 500 }, windowMinutes: { min: 1, max: 120 } },
  pushTtlMinutes: {
    critical: { min: 5, max: 2880 },
    warning: { min: 5, max: 2880 },
    info: { min: 5, max: 2880 },
  },
  webhookRetryHours: { min: 1, max: 72 },
  retention: {
    eventDays: { min: 1, max: 365 },
    alertDays: { min: 7, max: 1095 },
    deliveryDays: { min: 1, max: 365 },
  },
  heartbeat: { intervalSeconds: { min: 30, max: 3600 } },
} as const

type NumericRuleField = Exclude<
  {
    [K in keyof Rule]: Rule[K] extends number ? K : never
  }[keyof Rule],
  undefined
>

/** Accepted ranges of the rule fields. `repeatMinutes` is 0 or [15, 1440]. */
export const RULE_LIMITS: Readonly<Record<NumericRuleField, Range>> = {
  holdSeconds: { min: 0, max: 3600 },
  recoveryHoldSeconds: { min: 0, max: 600 },
  flapThreshold: { min: 0, max: 20 },
  flapWindowMinutes: { min: 1, max: 240 },
  groupSeconds: { min: 0, max: 3600 },
  dedupeMinutes: { min: 0, max: 1440 },
  repeatMinutes: { min: 0, max: 1440 },
  maxPerHour: { min: 0, max: 1000 },
}

/** Smallest non-zero reminder interval. */
export const REPEAT_MINUTES_MIN = 15

const RULE_BOOLEANS = ['enabled', 'notify', 'notifyRecovery', 'push', 'webhooks'] as const
const RULE_NUMBERS = Object.keys(RULE_LIMITS) as NumericRuleField[]

export const ALERTS_DEFAULTS: Readonly<AlertsSettings> = Object.freeze({
  dashboardUrl: null,
  capturedOrigin: null,
  quietHours: { enabled: false, start: '22:00', end: '07:00', breakThrough: 'critical' },
  bootGraceSeconds: 120,
  massOffline: { enabled: true, fractionPercent: 75, minAgents: 3 },
  destinationRateLimit: { max: 20, windowMinutes: 10 },
  pushTtlMinutes: { critical: 1440, warning: 720, info: 240 },
  webhookRetryHours: 24,
  retention: { eventDays: 30, alertDays: 180, deliveryDays: 30 },
  heartbeat: { urlEncrypted: null, urlDisplay: null, intervalSeconds: 60 },
  vapidSubject: null,
  allowAnyPushService: false,
  rules: {},
}) as AlertsSettings

/** Base rules by kind (events.md §1.3); a type's `defaults` override them. */
export function baseRule(kind: AlertKind): Rule {
  return kind === 'condition'
    ? {
        enabled: true,
        notify: true,
        severity: 'auto',
        holdSeconds: 60,
        recoveryHoldSeconds: 30,
        notifyRecovery: true,
        flapThreshold: 3,
        flapWindowMinutes: 30,
        groupSeconds: 0,
        dedupeMinutes: 0,
        repeatMinutes: 0,
        maxPerHour: 0,
        push: true,
        webhooks: true,
        params: {},
      }
    : {
        enabled: true,
        notify: true,
        severity: 'auto',
        holdSeconds: 0,
        recoveryHoldSeconds: 0,
        notifyRecovery: false,
        flapThreshold: 0,
        flapWindowMinutes: 30,
        groupSeconds: 0,
        dedupeMinutes: 60,
        repeatMinutes: 0,
        maxPerHour: 0,
        push: true,
        webhooks: true,
        params: {},
      }
}

export function paramDefaults(params: ParamDef[] | undefined): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {}
  for (const p of params ?? []) out[p.key] = Array.isArray(p.default) ? [...p.default] : p.default
  return out
}

/** The catalogue default rule of a type. */
export function catalogueRule(def: AlertTypeDef): Rule {
  const rule = { ...baseRule(def.kind), ...(def.defaults ?? {}) }
  rule.params = paramDefaults(def.params)
  return rule
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function clamp(value: number, range: Range): number {
  return Math.min(range.max, Math.max(range.min, value))
}

function clampRepeat(value: number): number {
  const v = clamp(value, RULE_LIMITS.repeatMinutes)
  return v > 0 && v < REPEAT_MINUTES_MIN ? REPEAT_MINUTES_MIN : v
}

/** One param value checked against its definition; undefined = invalid. */
export function normalizeParam(def: ParamDef, value: unknown): ParamValue | undefined {
  switch (def.kind) {
    case 'int':
      return isInt(value) ? clamp(value, def) : undefined
    case 'bool':
      return typeof value === 'boolean' ? value : undefined
    case 'enum':
      return typeof value === 'string' && def.options.includes(value) ? value : undefined
    case 'list':
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return undefined
      return (value as string[])
        .map((v) => v.trim())
        .filter((v) => v.length > 0 && v.length <= def.maxLength)
        .slice(0, def.maxItems)
  }
}

/**
 * A stored override, cleaned: known fields with valid values only, numbers
 * clamped. `def` (when the type is known) checks the params; the override of
 * a type this controller does not know is kept as stored (it applies when
 * that area's catalogue lands).
 */
export function normalizeRuleOverride(value: unknown, def?: AlertTypeDef): Partial<Rule> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const stored = value as Record<string, unknown>
  const out: Partial<Rule> = {}
  for (const key of RULE_BOOLEANS) {
    if (typeof stored[key] === 'boolean') out[key] = stored[key] as boolean
  }
  for (const key of RULE_NUMBERS) {
    const v = stored[key]
    if (!isInt(v)) continue
    out[key] = key === 'repeatMinutes' ? clampRepeat(v) : clamp(v, RULE_LIMITS[key])
  }
  const severity = stored.severity
  if (severity === 'auto' || (SEVERITIES as readonly string[]).includes(severity as string)) {
    out.severity = severity as Rule['severity']
  }
  const params = stored.params
  if (typeof params === 'object' && params !== null && !Array.isArray(params)) {
    const cleaned: Record<string, ParamValue> = {}
    for (const [key, raw] of Object.entries(params as Record<string, unknown>)) {
      if (def) {
        const pdef = def.params?.find((p) => p.key === key)
        if (!pdef) continue
        const v = normalizeParam(pdef, raw)
        if (v !== undefined) cleaned[key] = v
      } else if (
        typeof raw === 'number' ||
        typeof raw === 'boolean' ||
        typeof raw === 'string' ||
        (Array.isArray(raw) && raw.every((v) => typeof v === 'string'))
      ) {
        cleaned[key] = raw as ParamValue
      }
    }
    if (Object.keys(cleaned).length > 0) out.params = cleaned
  }
  return out
}

/** Catalogue default ⊕ the admin's override for one type. */
export function effectiveRule(def: AlertTypeDef, settings: Pick<AlertsSettings, 'rules'>): Rule {
  const rule = catalogueRule(def)
  const override = normalizeRuleOverride(settings.rules[def.type], def)
  const { params, ...fields } = override
  return { ...rule, ...fields, params: { ...rule.params, ...(params ?? {}) } }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

function obj(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function num(value: unknown, fallback: number, range: Range): number {
  return isInt(value) ? clamp(value, range) : fallback
}

function strOrNull(value: unknown, fallback: string | null, max = 2048): string | null {
  if (value === null) return null
  return typeof value === 'string' && value.length <= max ? value : fallback
}

/** Stored JSON → settings: invalid fields read as the default, numbers are clamped. */
export function normalizeAlertsSettings(value: unknown): AlertsSettings {
  const s = obj(value)
  const d = ALERTS_DEFAULTS
  const L = ALERTS_LIMITS
  const qh = obj(s.quietHours)
  const mo = obj(s.massOffline)
  const rl = obj(s.destinationRateLimit)
  const ttl = obj(s.pushTtlMinutes)
  const ret = obj(s.retention)
  const hb = obj(s.heartbeat)
  const rules: AlertsSettings['rules'] = {}
  for (const [type, override] of Object.entries(obj(s.rules))) {
    const cleaned = normalizeRuleOverride(override)
    if (Object.keys(cleaned).length > 0) rules[type] = cleaned
  }
  return {
    dashboardUrl: strOrNull(s.dashboardUrl, d.dashboardUrl, 255),
    capturedOrigin: strOrNull(s.capturedOrigin, d.capturedOrigin, 255),
    quietHours: {
      enabled: typeof qh.enabled === 'boolean' ? qh.enabled : d.quietHours.enabled,
      start: typeof qh.start === 'string' && HHMM.test(qh.start) ? qh.start : d.quietHours.start,
      end: typeof qh.end === 'string' && HHMM.test(qh.end) ? qh.end : d.quietHours.end,
      breakThrough:
        qh.breakThrough === 'critical' || qh.breakThrough === 'none'
          ? qh.breakThrough
          : d.quietHours.breakThrough,
    },
    bootGraceSeconds: num(s.bootGraceSeconds, d.bootGraceSeconds, L.bootGraceSeconds),
    massOffline: {
      enabled: typeof mo.enabled === 'boolean' ? mo.enabled : d.massOffline.enabled,
      fractionPercent: num(
        mo.fractionPercent,
        d.massOffline.fractionPercent,
        L.massOffline.fractionPercent
      ),
      minAgents: num(mo.minAgents, d.massOffline.minAgents, L.massOffline.minAgents),
    },
    destinationRateLimit: {
      max: num(rl.max, d.destinationRateLimit.max, L.destinationRateLimit.max),
      windowMinutes: num(
        rl.windowMinutes,
        d.destinationRateLimit.windowMinutes,
        L.destinationRateLimit.windowMinutes
      ),
    },
    pushTtlMinutes: {
      critical: num(ttl.critical, d.pushTtlMinutes.critical, L.pushTtlMinutes.critical),
      warning: num(ttl.warning, d.pushTtlMinutes.warning, L.pushTtlMinutes.warning),
      info: num(ttl.info, d.pushTtlMinutes.info, L.pushTtlMinutes.info),
    },
    webhookRetryHours: num(s.webhookRetryHours, d.webhookRetryHours, L.webhookRetryHours),
    retention: {
      eventDays: num(ret.eventDays, d.retention.eventDays, L.retention.eventDays),
      alertDays: num(ret.alertDays, d.retention.alertDays, L.retention.alertDays),
      deliveryDays: num(ret.deliveryDays, d.retention.deliveryDays, L.retention.deliveryDays),
    },
    heartbeat: {
      urlEncrypted: strOrNull(hb.urlEncrypted, null, 8192),
      urlDisplay: strOrNull(hb.urlDisplay, null, 160),
      intervalSeconds: num(
        hb.intervalSeconds,
        d.heartbeat.intervalSeconds,
        L.heartbeat.intervalSeconds
      ),
    },
    vapidSubject: strOrNull(s.vapidSubject, d.vapidSubject, 255),
    allowAnyPushService:
      typeof s.allowAnyPushService === 'boolean' ? s.allowAnyPushService : d.allowAnyPushService,
    rules,
  }
}

export async function getAlertsSettings(): Promise<AlertsSettings> {
  return normalizeAlertsSettings(await SystemSetting.get<unknown>(ALERTS_SETTING_KEY))
}

export async function saveAlertsSettings(settings: AlertsSettings): Promise<AlertsSettings> {
  const normalized = normalizeAlertsSettings(settings)
  await SystemSetting.set(ALERTS_SETTING_KEY, normalized)
  return normalized
}

/** Base of links in messages: `dashboardUrl ?? capturedOrigin`, without a trailing slash. */
export function linkBase(settings: Pick<AlertsSettings, 'dashboardUrl' | 'capturedOrigin'>) {
  const base = settings.dashboardUrl ?? settings.capturedOrigin
  return base ? base.replace(/\/+$/, '') : null
}

/** `https://hc-ping.com/…` → `https://hc-ping.com/••••` (the path may be the credential). */
export function maskUrl(raw: string): string {
  try {
    const url = new URL(raw)
    const tail = url.pathname && url.pathname !== '/' ? '/••••' : ''
    return `${url.protocol}//${url.host}${tail}`.slice(0, 160)
  } catch {
    return '••••'
  }
}

/** The heartbeat URL in clear, or null when unset or unreadable (APP_KEY changed). */
export function heartbeatUrl(settings: AlertsSettings): string | null {
  if (!settings.heartbeat.urlEncrypted) return null
  try {
    return encryption.decrypt<string>(settings.heartbeat.urlEncrypted) ?? null
  } catch {
    return null
  }
}

/** Severity helpers shared by routing and filters. */
export function severityAtLeast(value: Severity, min: Severity): boolean {
  return SEVERITIES.indexOf(value) >= SEVERITIES.indexOf(min)
}
