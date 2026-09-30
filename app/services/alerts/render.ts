import type { AlertTypeDef, RenderContext, RenderedText, RenderInput } from '#services/alerts/model'
import { DateTime } from 'luxon'

/**
 * Texts of alerts (README §0.7, events.md §1.3). Every text is rendered on
 * the controller, in the instance time zone; push payloads, webhooks and the
 * inbox show what this produces.
 *
 * `renderAlert` adds the generic texts a type does not give itself:
 * `flapping` → "<label> is flapping"; the end of a flapping period in the
 * resolved state → "<label> is stable again"; `reminder` → "Still: <title>";
 * and (through `conditionRender`) `resolved` with `wasNotified: false` →
 * "<label> was <state>" / "<from>–<to> (<duration>).".
 */

export const TITLE_MAX = 200
export const BODY_MAX = 600

/** "14:02" in the zone. */
export function hhmm(value: DateTime | null | undefined, zone: string): string {
  if (!value) return '?'
  const local = value.setZone(zone)
  return (local.isValid ? local : value.toUTC()).toFormat('HH:mm')
}

/** "14:02–14:09". */
export function span(from: DateTime, to: DateTime, zone: string): string {
  return `${hhmm(from, zone)}–${hhmm(to, zone)}`
}

/** "40 s", "7 min", "2 h 5 min", "3 d 4 h". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s} s`
  const minutes = Math.round(s / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes ? `${hours} h ${restMinutes} min` : `${hours} h`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours ? `${days} d ${restHours} h` : `${days} d`
}

export function secondsBetween(from: DateTime, to: DateTime): number {
  return Math.max(0, to.diff(from, 'seconds').seconds)
}

/** Payload accessors: never throw on a missing or mistyped field. */
export function pStr(payload: Record<string, unknown>, key: string, fallback = ''): string {
  const v = payload[key]
  if (typeof v === 'string' && v.trim() !== '') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return fallback
}

export function pNum(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function pBool(payload: Record<string, unknown>, key: string): boolean {
  return payload[key] === true
}

export function pTime(payload: Record<string, unknown>, key: string): DateTime | null {
  const v = payload[key]
  if (typeof v !== 'string') return null
  const parsed = DateTime.fromISO(v, { zone: 'utc' })
  return parsed.isValid ? parsed : null
}

/** "a, b and 2 more" for group bodies. */
export function listNames(names: string[], max = 5): string {
  const shown = names.slice(0, max)
  const rest = names.length - shown.length
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ')
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function trim(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

type TextFn = (alert: RenderInput, ctx: RenderContext) => RenderedText

/**
 * A condition's `render` from its texts: `opened` (also escalated and test),
 * `resolved` ("back", when that destination saw the outage) and `was` (the
 * collapsed form, when it did not). `was` defaults to the generic "<label>
 * was <state>" / "<from>–<to> (<duration>).".
 */
export function conditionRender(spec: {
  state: string
  opened: TextFn
  resolved?: TextFn
  was?: TextFn
}): AlertTypeDef['render'] {
  return (alert, ctx) => {
    if (ctx.transition === 'resolved' || alert.state === 'resolved') {
      if (!ctx.wasNotified) {
        if (spec.was) return spec.was(alert, ctx)
        const to = alert.resolvedAt ?? ctx.now
        return {
          title: `${alert.label} was ${spec.state}`,
          body: `${span(alert.raisedAt, to, ctx.zone)} (${duration(secondsBetween(alert.raisedAt, to))}).`,
        }
      }
      if (spec.resolved) return spec.resolved(alert, ctx)
      const to = alert.resolvedAt ?? ctx.now
      return {
        title: `${alert.label} is no longer ${spec.state}`,
        body: `For ${duration(secondsBetween(alert.raisedAt, to))} (${span(alert.raisedAt, to, ctx.zone)}).`,
      }
    }
    return spec.opened(alert, ctx)
  }
}

/** "Offline for 7 min (14:02–14:09)." */
export function forSpan(alert: RenderInput, ctx: RenderContext, word: string): string {
  const to = alert.resolvedAt ?? ctx.now
  return `${word} for ${duration(secondsBetween(alert.raisedAt, to))} (${span(alert.raisedAt, to, ctx.zone)}).`
}

/**
 * Texts of one alert for one transition, with the generic texts added.
 * Never throws: a type whose `render` fails gets its label as the title.
 */
export function renderAlert(
  def: AlertTypeDef | null,
  alert: RenderInput,
  ctx: RenderContext & { windowMinutes?: number }
): RenderedText {
  let text: RenderedText
  try {
    if (!def) {
      text = { title: `${alert.type}: ${alert.label}`, body: '' }
    } else if (ctx.flapEnded && alert.state === 'resolved') {
      text = {
        title: `${alert.label} is stable again`,
        body: ctx.windowMinutes
          ? `No change for ${ctx.windowMinutes} min.`
          : `Stable since ${hhmm(alert.resolvedAt, ctx.zone)}.`,
      }
    } else if (ctx.transition === 'flapping') {
      const window = ctx.windowMinutes ? ` in ${ctx.windowMinutes} min` : ''
      text = {
        title: `${alert.label} is flapping`,
        body: `${alert.transitions} changes${window}. Further changes are not notified until it is stable.`,
      }
    } else if (ctx.transition === 'reminder') {
      const base = def.render(alert, { ...ctx, transition: 'opened' })
      text = {
        title: `Still: ${base.title}`,
        body: `Since ${hhmm(alert.raisedAt, ctx.zone)} (${duration(secondsBetween(alert.raisedAt, ctx.now))}).`,
        path: base.path,
      }
    } else {
      text = def.render(alert, ctx)
    }
  } catch {
    text = { title: def ? `${def.label}: ${alert.label}` : alert.label, body: '' }
  }
  return {
    title: trim(text.title, TITLE_MAX),
    body: trim(text.body, BODY_MAX),
    ...(text.path ? { path: text.path } : {}),
  }
}

/** Texts of several alerts of one type in one message (grouping). */
export function renderGroup(
  def: AlertTypeDef | null,
  alerts: RenderInput[],
  ctx: RenderContext
): RenderedText {
  if (alerts.length === 1) return renderAlert(def, alerts[0], ctx)
  try {
    if (def?.renderGroup) {
      const t = def.renderGroup(alerts, ctx)
      return { title: trim(t.title, TITLE_MAX), body: trim(t.body, BODY_MAX) }
    }
  } catch {
    // Fall through to the generic text.
  }
  const label = def?.label ?? alerts[0].type
  return {
    title: trim(`${alerts.length} alerts: ${label}`, TITLE_MAX),
    body: trim(listNames(alerts.map((a) => a.label)), BODY_MAX),
  }
}
