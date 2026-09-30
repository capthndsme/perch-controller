import type { AlertSettingsLimits, Limit, Rule, Severity } from '@/types/alerts'

/**
 * Bounds of the alert settings (design README §2.6). The controller sends its own in `limits`, which win;
 * these fill in whatever a response leaves out.
 */
const FALLBACK = {
  bootGraceSeconds: { min: 30, max: 900 },
  fractionPercent: { min: 20, max: 100 },
  minAgents: { min: 2, max: 50 },
  rateMax: { min: 1, max: 500 },
  rateWindowMinutes: { min: 1, max: 120 },
  pushTtlMinutes: { min: 5, max: 2880 },
  webhookRetryHours: { min: 1, max: 72 },
  eventDays: { min: 1, max: 365 },
  alertDays: { min: 7, max: 1095 },
  deliveryDays: { min: 1, max: 365 },
  heartbeatSeconds: { min: 30, max: 3600 },
} satisfies Record<string, Limit>

export const RULE_FALLBACK: Partial<Record<keyof Rule, Limit>> = {
  holdSeconds: { min: 0, max: 3600 },
  recoveryHoldSeconds: { min: 0, max: 600 },
  flapThreshold: { min: 0, max: 20 },
  flapWindowMinutes: { min: 1, max: 240 },
  groupSeconds: { min: 0, max: 3600 },
  dedupeMinutes: { min: 0, max: 1440 },
  // 0 = never; otherwise 15 to 1440.
  repeatMinutes: { min: 15, max: 1440 },
  maxPerHour: { min: 0, max: 1000 },
}

function isLimit(value: unknown): value is Limit {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Limit).min === 'number' &&
    typeof (value as Limit).max === 'number'
  )
}

export function ruleLimit(limits: AlertSettingsLimits | undefined, key: keyof Rule): Limit | undefined {
  const server = limits?.rule?.[key]
  return isLimit(server) ? server : RULE_FALLBACK[key]
}

/** The limits of the global settings, flattened for the form. */
export function settingLimits(limits: AlertSettingsLimits | undefined) {
  const ttl = limits?.pushTtlMinutes
  const ttlFor = (severity: Severity): Limit => {
    if (isLimit(ttl)) return ttl
    const own = ttl && !isLimit(ttl) ? ttl[severity] : undefined
    return isLimit(own) ? own : FALLBACK.pushTtlMinutes
  }
  const pick = (value: unknown, fallback: Limit): Limit => (isLimit(value) ? value : fallback)
  return {
    bootGraceSeconds: pick(limits?.bootGraceSeconds, FALLBACK.bootGraceSeconds),
    fractionPercent: pick(limits?.massOffline?.fractionPercent, FALLBACK.fractionPercent),
    minAgents: pick(limits?.massOffline?.minAgents, FALLBACK.minAgents),
    rateMax: pick(limits?.destinationRateLimit?.max, FALLBACK.rateMax),
    rateWindowMinutes: pick(limits?.destinationRateLimit?.windowMinutes, FALLBACK.rateWindowMinutes),
    pushTtl: { critical: ttlFor('critical'), warning: ttlFor('warning'), info: ttlFor('info') },
    webhookRetryHours: pick(limits?.webhookRetryHours, FALLBACK.webhookRetryHours),
    eventDays: pick(limits?.retention?.eventDays, FALLBACK.eventDays),
    alertDays: pick(limits?.retention?.alertDays, FALLBACK.alertDays),
    deliveryDays: pick(limits?.retention?.deliveryDays, FALLBACK.deliveryDays),
    heartbeatSeconds: pick(limits?.heartbeat?.intervalSeconds, FALLBACK.heartbeatSeconds),
  }
}

/** `https://host[:port]` without a path, or null when it is not one. */
export function originProblem(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Use http:// or https://.'
    if ((url.pathname && url.pathname !== '/') || url.search || url.hash) return 'Only the address, without a path.'
    return null
  } catch {
    return 'Not a URL.'
  }
}

/** A VAPID subject: `mailto:` or an https URL that is not localhost (Apple refuses those). */
export function vapidSubjectProblem(value: string): string | null {
  if (/^mailto:[^@\s]+@[^@\s]+$/i.test(value)) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return 'A mailto: address or an https:// URL.'
    if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.startsWith('127.'))
      return 'Apple refuses localhost subjects.'
    return null
  } catch {
    return 'A mailto: address or an https:// URL.'
  }
}

/** Why a typed whole number does not fit its limit, or null. `zeroOr`: 0 is allowed below `min` (reminders: 0 = never). */
export function intProblem(value: string, limit: Limit | undefined, options: { zeroOr?: boolean } = {}): string | null {
  if (value.trim() === '') return 'Enter a number.'
  const n = Number(value)
  if (!Number.isInteger(n)) return 'Whole numbers only.'
  if (!limit) return null
  if (options.zeroOr && n === 0) return null
  if (n < limit.min || n > limit.max)
    return options.zeroOr ? `0, or ${limit.min} to ${limit.max}.` : `${limit.min} to ${limit.max}.`
  return null
}
