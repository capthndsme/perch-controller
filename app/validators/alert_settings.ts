import type { AlertTypeDef } from '#services/alerts/model'
import { SEVERITIES } from '#services/alerts/model'
import { ALERTS_LIMITS, REPEAT_MINUTES_MIN, RULE_LIMITS } from '#services/alerts/settings'
import vine from '@vinejs/vine'

/**
 * Request shapes of Settings → Alerts (docs/design/alerts/api.md §3.3, §3.5).
 * Vine checks the global fields against `ALERTS_LIMITS`; the URLs and the
 * per-type rules (which depend on the catalogue) are checked by the helpers
 * below and answered with the same 422 shape and field paths.
 */

type Range = { min: number; max: number }
const int = (r: Range) => vine.number().withoutDecimals().min(r.min).max(r.max)
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const L = ALERTS_LIMITS

export const alertSettingsUpdateValidator = vine.compile(
  vine.object({
    dashboardUrl: vine.string().trim().maxLength(255).nullable().optional(),
    quietHours: vine
      .object({
        enabled: vine.boolean().optional(),
        start: vine.string().trim().regex(HHMM).optional(),
        end: vine.string().trim().regex(HHMM).optional(),
        breakThrough: vine.enum(['critical', 'none'] as const).optional(),
      })
      .optional(),
    bootGraceSeconds: int(L.bootGraceSeconds).optional(),
    massOffline: vine
      .object({
        enabled: vine.boolean().optional(),
        fractionPercent: int(L.massOffline.fractionPercent).optional(),
        minAgents: int(L.massOffline.minAgents).optional(),
      })
      .optional(),
    destinationRateLimit: vine
      .object({
        max: int(L.destinationRateLimit.max).optional(),
        windowMinutes: int(L.destinationRateLimit.windowMinutes).optional(),
      })
      .optional(),
    pushTtlMinutes: vine
      .object({
        critical: int(L.pushTtlMinutes.critical).optional(),
        warning: int(L.pushTtlMinutes.warning).optional(),
        info: int(L.pushTtlMinutes.info).optional(),
      })
      .optional(),
    webhookRetryHours: int(L.webhookRetryHours).optional(),
    retention: vine
      .object({
        eventDays: int(L.retention.eventDays).optional(),
        alertDays: int(L.retention.alertDays).optional(),
        deliveryDays: int(L.retention.deliveryDays).optional(),
      })
      .optional(),
    heartbeat: vine
      .object({
        url: vine.string().trim().maxLength(2048).nullable().optional(),
        intervalSeconds: int(L.heartbeat.intervalSeconds).optional(),
      })
      .optional(),
    vapidSubject: vine.string().trim().maxLength(255).nullable().optional(),
    allowAnyPushService: vine.boolean().optional(),
    rules: vine.record(vine.any().nullable()).optional(),
  })
)

/** `POST /api/v1/settings/alerts/test`. */
export const alertTestValidator = vine.compile(
  vine.object({
    severity: vine.enum(SEVERITIES),
    title: vine.string().trim().maxLength(80).optional(),
  })
)

/** `GET /api/v1/alerts/deliveries` query. */
export const alertDeliveryListValidator = vine.compile(
  vine.object({
    destination: vine.string().trim().maxLength(40).optional(),
    alertId: vine.number().withoutDecimals().min(1).optional(),
    status: vine.string().trim().maxLength(200).optional(),
    before: vine.number().withoutDecimals().min(1).optional(),
    limit: vine.number().withoutDecimals().min(1).max(100).optional(),
  })
)

export type FieldError = { field: string; rule: string; message: string }

function isLocalhost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h)
}

/** The URL fields: dashboard URL (origin only), heartbeat URL, VAPID subject. */
export function checkSettingsUrls(payload: {
  dashboardUrl?: string | null
  heartbeat?: { url?: string | null }
  vapidSubject?: string | null
}): FieldError[] {
  const errors: FieldError[] = []
  if (payload.dashboardUrl) {
    try {
      const u = new URL(payload.dashboardUrl)
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error()
      if ((u.pathname && u.pathname !== '/') || u.search || u.hash) {
        errors.push({
          field: 'dashboardUrl',
          rule: 'origin',
          message: 'Use the origin only, like https://perch.example.com.',
        })
      }
    } catch {
      errors.push({ field: 'dashboardUrl', rule: 'url', message: 'Expected an http(s) URL.' })
    }
  }
  const heartbeat = payload.heartbeat?.url
  if (heartbeat) {
    try {
      const u = new URL(heartbeat)
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error()
    } catch {
      errors.push({ field: 'heartbeat.url', rule: 'url', message: 'Expected an http(s) URL.' })
    }
  }
  const subject = payload.vapidSubject
  if (subject) {
    if (subject.startsWith('mailto:')) {
      if (!/^mailto:[^@\s]+@[^@\s]+$/.test(subject)) {
        errors.push({
          field: 'vapidSubject',
          rule: 'mailto',
          message: 'Expected mailto:name@example.com.',
        })
      }
    } else {
      try {
        const u = new URL(subject)
        if (u.protocol !== 'https:') throw new Error()
        if (isLocalhost(u.hostname)) {
          errors.push({
            field: 'vapidSubject',
            rule: 'not_localhost',
            message: 'Apple rejects a localhost subject; use a mailto: or a public https URL.',
          })
        }
      } catch {
        errors.push({
          field: 'vapidSubject',
          rule: 'url',
          message: 'Expected a mailto: or an https: URL.',
        })
      }
    }
  }
  return errors
}

const RULE_FIELDS: Record<string, 'bool' | 'int' | 'severity'> = {
  enabled: 'bool',
  notify: 'bool',
  notifyRecovery: 'bool',
  push: 'bool',
  webhooks: 'bool',
  severity: 'severity',
  holdSeconds: 'int',
  recoveryHoldSeconds: 'int',
  flapThreshold: 'int',
  flapWindowMinutes: 'int',
  groupSeconds: 'int',
  dedupeMinutes: 'int',
  repeatMinutes: 'int',
  maxPerHour: 'int',
}

/**
 * `rules` of a PATCH: every key a catalogue type (`rules.<type>` / `alert_type`
 * otherwise), each value null (reset) or a partial rule whose numbers are in
 * `RULE_LIMITS` and whose params match the type's `ParamDef`s
 * (`rules.<type>.params.<key>`).
 */
export function validateRulesPatch(
  rules: Record<string, unknown>,
  lookup: (type: string) => AlertTypeDef | null
): FieldError[] {
  const errors: FieldError[] = []
  for (const [type, value] of Object.entries(rules)) {
    const base = `rules.${type}`
    const def = lookup(type)
    if (!def) {
      errors.push({ field: base, rule: 'alert_type', message: `Unknown alert type "${type}".` })
      continue
    }
    if (value === null) continue
    if (typeof value !== 'object' || Array.isArray(value)) {
      errors.push({ field: base, rule: 'object', message: 'Expected a rule object or null.' })
      continue
    }
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const field = `${base}.${key}`
      if (key === 'params') {
        if (v === null) continue
        if (typeof v !== 'object' || Array.isArray(v)) {
          errors.push({ field, rule: 'object', message: 'Expected an object.' })
          continue
        }
        for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
          const pfield = `${field}.${pk}`
          const pdef = def.params?.find((p) => p.key === pk)
          if (!pdef) {
            errors.push({
              field: pfield,
              rule: 'param',
              message: `"${type}" has no param "${pk}".`,
            })
            continue
          }
          if (pv === null) continue
          let ok = false
          if (pdef.kind === 'int') {
            ok = typeof pv === 'number' && Number.isInteger(pv) && pv >= pdef.min && pv <= pdef.max
          } else if (pdef.kind === 'bool') {
            ok = typeof pv === 'boolean'
          } else if (pdef.kind === 'enum') {
            ok = typeof pv === 'string' && pdef.options.includes(pv)
          } else {
            ok =
              Array.isArray(pv) &&
              pv.length <= pdef.maxItems &&
              pv.every((s) => typeof s === 'string' && s.length <= pdef.maxLength)
          }
          if (!ok) errors.push({ field: pfield, rule: 'param_value', message: 'Invalid value.' })
        }
        continue
      }
      const kind = RULE_FIELDS[key]
      if (!kind) {
        errors.push({ field, rule: 'unknown', message: `Unknown rule field "${key}".` })
      } else if (kind === 'bool' && typeof v !== 'boolean') {
        errors.push({ field, rule: 'boolean', message: 'Expected true or false.' })
      } else if (
        kind === 'severity' &&
        !(v === 'auto' || (SEVERITIES as readonly string[]).includes(v as string))
      ) {
        errors.push({ field, rule: 'enum', message: 'Expected auto, info, warning or critical.' })
      } else if (kind === 'int') {
        const range = RULE_LIMITS[key as keyof typeof RULE_LIMITS]
        const valid =
          typeof v === 'number' &&
          Number.isInteger(v) &&
          v >= range.min &&
          v <= range.max &&
          !(key === 'repeatMinutes' && v > 0 && v < REPEAT_MINUTES_MIN)
        if (!valid) {
          errors.push({
            field,
            rule: 'range',
            message:
              key === 'repeatMinutes'
                ? `0 or ${REPEAT_MINUTES_MIN}–${range.max}.`
                : `${range.min}–${range.max}.`,
          })
        }
      }
    }
  }
  return errors
}
