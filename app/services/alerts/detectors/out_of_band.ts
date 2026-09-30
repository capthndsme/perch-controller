import { getAlertType } from '#services/alerts/catalogue/index'
import { alertNow } from '#services/alerts/clock'
import type { RenderInput, Severity } from '#services/alerts/model'
import logger from '@adonisjs/core/services/logger'
import type { DateTime } from 'luxon'

/**
 * The out-of-band path (events.md section 3.9, README section 7): while the
 * database is unreachable the engine cannot write, so `system.db_unreachable`
 * is rendered from memory and handed straight to a transport that keeps its
 * own destination cache (refreshed from the database every 60 s while it is
 * healthy, at most 500 rows, secrets decrypted only at send time). At most
 * one notification per outage and one recovery.
 *
 * The transport is the delivery side's (WP-A2 wires its push and webhook
 * senders in with `setOutOfBandTransport`); without one the outage is only
 * logged, and the alert is still written once the database is back.
 */

export type OutOfBandMessage = {
  type: string
  transition: 'opened' | 'resolved'
  severity: Severity
  title: string
  body: string
  path: string
}

export interface OutOfBandTransport {
  /** Reloads the destination cache (filters, mutes, secrets) while the database is up. */
  refresh(): Promise<void>
  /** Sends to every cached destination the message may go to. Must not throw. */
  send(message: OutOfBandMessage): Promise<void>
}

let transport: OutOfBandTransport | null = null
/** The instance time zone, cached while the database is up (the text says "since 14:02"). */
let zone = 'UTC'

export function setOutOfBandTransport(next: OutOfBandTransport | null): void {
  transport = next
}

export function setOutOfBandZone(next: string): void {
  zone = next
}

/** Refreshes the transport's cache; called by the database probe while the database answers. */
export async function refreshOutOfBand(): Promise<void> {
  if (!transport) return
  try {
    await transport.refresh()
  } catch (err) {
    logger.warn({ err }, 'alerts out-of-band: cache refresh failed')
  }
}

const TYPE = 'system.db_unreachable'

/** The texts of `system.db_unreachable` for one outage, rendered by its catalogue entry. */
export function renderDbUnreachable(
  transition: 'opened' | 'resolved',
  since: DateTime,
  now: DateTime = alertNow()
): OutOfBandMessage {
  const def = getAlertType(TYPE)
  const input: RenderInput = {
    id: null,
    type: TYPE,
    kind: 'condition',
    state: transition === 'opened' ? 'active' : 'resolved',
    severity: 'critical',
    flapping: false,
    subject: { kind: 'controller', ref: '', label: null },
    label: 'Perch',
    payload: { since: since.toUTC().toISO() },
    firstRaisedAt: since,
    raisedAt: since,
    openedAt: since,
    resolvedAt: transition === 'resolved' ? now : null,
    eventCount: 1,
    transitions: 0,
  }
  const text = def?.render(input, {
    transition,
    wasNotified: true,
    redact: false,
    zone,
    now,
  }) ?? {
    title: transition === 'opened' ? 'Perch cannot reach its database' : 'Database is back',
    body: '',
  }
  return {
    type: TYPE,
    transition,
    severity: 'critical',
    title: text.title,
    body: text.body,
    path: text.path ?? '/settings',
  }
}

/** Sends one message out of band. Returns false when no transport is wired in. */
export async function sendOutOfBand(message: OutOfBandMessage): Promise<boolean> {
  if (!transport) {
    logger.error({ title: message.title }, 'alerts out-of-band: no transport, not sent')
    return false
  }
  try {
    await transport.send(message)
  } catch (err) {
    logger.error({ err }, 'alerts out-of-band: send failed')
  }
  return true
}
