import { parseRange } from '#validators/devices'
import { DateTime } from 'luxon'

export type ResolvedTimeWindow =
  | { error: { error: string; message: string }; since?: never; until?: never; range?: never }
  | { error?: never; since: DateTime; until: DateTime; range: string | null }

/**
 * Shared `{ range | from,to }` → `[since, until)` resolution for the read
 * controllers that take a plain time window (services, destinations).
 * Absolute `from`/`to` win over `range`; the default range applies when
 * neither is given.
 */
export function resolveTimeWindow(
  qs: { range?: string; from?: string; to?: string },
  defaultRange: string
): ResolvedTimeWindow {
  if (qs.from && qs.to) {
    const since = DateTime.fromISO(qs.from, { zone: 'utc' })
    const until = DateTime.fromISO(qs.to, { zone: 'utc' })
    if (!since.isValid || !until.isValid) {
      return {
        error: {
          error: 'invalid_window',
          message: '`from` and `to` must be valid ISO-8601 timestamps.',
        },
      }
    }
    if (until <= since) {
      return {
        error: { error: 'invalid_window', message: '`to` must be strictly greater than `from`.' },
      }
    }
    return { since, until, range: qs.range ?? null }
  }

  const range = qs.range ?? defaultRange
  const parsed = parseRange(range)
  if (!parsed) {
    return {
      error: { error: 'invalid_range', message: `Range "${range}" is not a recognised duration.` },
    }
  }
  const until = DateTime.utc()
  const since = until.minus({ seconds: parsed.seconds })
  return { since, until, range }
}
