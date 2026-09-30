import Alert from '#models/alert'
import AlertEvent from '#models/alert_event'
import SystemSetting from '#models/system_setting'
import { getAlertType } from '#services/alerts/catalogue/index'
import { alertNow, sqlTime } from '#services/alerts/clock'
import type {
  AlertsSettings,
  AlertSubject,
  AlertTypeDef,
  ConditionInput,
  EmitInput,
  EventOutcome,
  EventPhase,
  RenderInput,
  Rule,
  Severity,
  Transition,
} from '#services/alerts/model'
import { SEVERITY_RANK } from '#services/alerts/model'
import { findMatchingMute } from '#services/alerts/mutes'
import { renderAlert } from '#services/alerts/render'
import { effectiveRule, getAlertsSettings } from '#services/alerts/settings'
import {
  pathFor,
  resolveSubjectLabel,
  subjectFromRef,
  subjectKey,
  subjectRef,
  validSubject,
} from '#services/alerts/subjects'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import { createHash } from 'node:crypto'
import type { DateTime } from 'luxon'

/**
 * The alerts engine (docs/design/alerts/README.md §2.3): one in-process
 * worker that turns events into alerts.
 *
 * - Events arrive through `emit.ts` into a bounded queue (2000 events; on
 *   overflow the oldest `info` event is dropped first, counted and logged)
 *   and are processed one at a time, in order. Reconciles, the 5 s tick and
 *   admin actions (acknowledge, resolve, rule disabled) go through the same
 *   queue, so nothing races the state machine.
 * - Each event is persisted (`alert_events`) with what the engine did about
 *   it; conditions move `pending → active → resolved`, notices are `posted`.
 *   Hold, blip, reopen, flap damping, escalation, recovery hold, reminders,
 *   mutes, boot grace and the mass-offline withholding all live here.
 * - Visible transitions go to the notifier (`routing.ts`, which creates the
 *   deliveries); tests swap it for a recording one.
 *
 * Single instance, like the scheduler and the agent hubs (CLAUDE.md): two
 * controllers on one database would double-send. The UNIQUE `active_key`
 * still keeps one live alert per key if a CLI run races the server.
 */

/* ------------------------------------------------------------------ */
/* Notifier seam                                                       */
/* ------------------------------------------------------------------ */

export type NotifyRequest = {
  alert: Alert
  def: AlertTypeDef
  rule: Rule
  transition: Transition
  /** The notice that ends a flapping period. */
  flapEnded: boolean
  now: DateTime
  settings: AlertsSettings
  zone: string
}

export interface AlertNotifier {
  /** Route one visible transition; returns how many deliveries it created. */
  notify(request: NotifyRequest): Promise<number>
  /** A condition resolved without a recovery notice: its unsent deliveries collapse. */
  collapse(alertId: number, now: DateTime): Promise<void>
  /** Every engine tick: release grouped and held deliveries. */
  tick(now: DateTime, settings: AlertsSettings, zone: string): Promise<void>
}

/** Inbox only: no destinations. */
export const inboxOnlyNotifier: AlertNotifier = {
  notify: async () => 0,
  collapse: async () => {},
  tick: async () => {},
}

let defaultNotifier: AlertNotifier = inboxOnlyNotifier
let notifier: AlertNotifier | null = null

function activeNotifier(): AlertNotifier {
  return notifier ?? defaultNotifier
}

/** Wires the production notifier (routing). */
export function setDefaultAlertNotifier(next: AlertNotifier): void {
  defaultNotifier = next
}

/** Tests: replace the notifier (`null` = back to the default). */
export function _setAlertNotifier(next: AlertNotifier | null): void {
  notifier = next
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

export const PAYLOAD_MAX_BYTES = 4096
const DEDUPE_KEY_MAX = 191

export type NormalizedEvent = {
  type: string
  phase: EventPhase | null
  subject: AlertSubject
  subjectKind: string
  subjectRef: string
  dedupeKey: string
  severity: Severity | null
  payload: Record<string, unknown> | null
  occurredAt: DateTime
  source: string | null
}

function boundedKey(key: string): string {
  if (key.length <= DEDUPE_KEY_MAX) return key
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 32)
  return `${key.slice(0, DEDUPE_KEY_MAX - 33)}~${hash}`
}

/** JSON copy of a payload, ≤ 4 KB serialised (else `{ _truncated: true }`). */
export function boundPayload(payload: unknown): Record<string, unknown> | null {
  if (payload === undefined || payload === null) return null
  try {
    const json = JSON.stringify(payload)
    if (json === undefined) return null
    if (Buffer.byteLength(json, 'utf8') > PAYLOAD_MAX_BYTES) return { _truncated: true }
    const parsed = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : { value: parsed }
  } catch {
    return { _invalid: true }
  }
}

/**
 * Checks and copies an emit (the caller may reuse its objects). Null when it
 * cannot be keyed (no valid subject): logged and dropped.
 */
export function normalizeEmit(input: EmitInput): NormalizedEvent | null {
  if (!input || typeof input.type !== 'string' || input.type === '') {
    logger.warn({ input: input?.type }, 'alerts: emit without a type dropped')
    return null
  }
  if (!validSubject(input.subject)) {
    logger.warn(
      { type: input.type, subject: input.subject },
      'alerts: emit with an invalid subject dropped'
    )
    return null
  }
  const subject = { ...input.subject } as AlertSubject
  if (subject.kind === 'device') subject.mac = subject.mac.toLowerCase()
  const phase =
    input.phase === 'raise' || input.phase === 'clear' || input.phase === 'instant'
      ? input.phase
      : null
  const severity =
    input.severity && input.severity in SEVERITY_RANK ? (input.severity as Severity) : null
  return {
    type: input.type.slice(0, 64),
    phase,
    subject,
    subjectKind: subject.kind,
    subjectRef: subjectRef(subject).slice(0, 64),
    dedupeKey: boundedKey(input.dedupeKey || `${input.type}:${subjectKey(subject)}`),
    severity,
    payload: boundPayload(input.payload),
    occurredAt: input.occurredAt?.isValid ? input.occurredAt.toUTC() : alertNow(),
    source: input.source ? String(input.source).slice(0, 48) : null,
  }
}

/* ------------------------------------------------------------------ */
/* Queue and worker                                                    */
/* ------------------------------------------------------------------ */

export const QUEUE_MAX = 2000

type Job =
  | { kind: 'event'; event: NormalizedEvent; severityHint: Severity }
  | {
      kind: 'reconcile'
      types: string[]
      current: NormalizedEvent[]
      scope?: string
      done: () => void
    }
  | { kind: 'tick'; done: () => void }
  | { kind: 'task'; run: () => Promise<void>; done: (error?: unknown) => void }

const queue: Job[] = []
let eventJobs = 0
let draining: Promise<void> | null = null
let scheduled = false
let paused = false
let dropped = 0

let tickTimer: NodeJS.Timeout | null = null
let tickQueued = false
let bootedAt: DateTime | null = null

export function engineStats() {
  return { queued: queue.length, events: eventJobs, dropped, running: tickTimer !== null }
}

function schedule(): void {
  if (paused || scheduled || draining) return
  scheduled = true
  setImmediate(() => {
    scheduled = false
    kick()
  })
}

function kick(): void {
  if (paused || draining || queue.length === 0) return
  draining = drain().finally(() => {
    draining = null
    if (queue.length > 0) schedule()
  })
}

async function drain(): Promise<void> {
  settingsCache = null
  while (queue.length > 0 && !paused) {
    const job = queue.shift()!
    if (job.kind === 'event') eventJobs -= 1
    try {
      if (job.kind === 'event') await processEvent(job.event)
      else if (job.kind === 'reconcile') await processReconcile(job.types, job.current, job.scope)
      else if (job.kind === 'tick') await processTick()
      else await job.run()
      if (job.kind !== 'event') job.done()
    } catch (error) {
      logger.error({ err: error, job: job.kind }, 'alerts: engine job failed')
      if (job.kind === 'task') job.done(error)
      else if (job.kind !== 'event') job.done()
    }
  }
}

function dropOne(): void {
  let index = queue.findIndex((j) => j.kind === 'event' && j.severityHint === 'info')
  if (index < 0) index = queue.findIndex((j) => j.kind === 'event')
  if (index < 0) return
  const [job] = queue.splice(index, 1)
  eventJobs -= 1
  dropped += 1
  if (dropped === 1 || dropped % 100 === 0) {
    logger.warn(
      { dropped, type: job.kind === 'event' ? job.event.type : null },
      'alerts: event queue full, dropping events (oldest info first)'
    )
  }
}

/** Queues one normalized event (emit.ts). Never throws. */
export function enqueueEvent(event: NormalizedEvent): void {
  if (eventJobs >= QUEUE_MAX) dropOne()
  const def = getAlertType(event.type)
  queue.push({ kind: 'event', event, severityHint: event.severity ?? def?.severity ?? 'info' })
  eventJobs += 1
  schedule()
}

export function enqueueReconcile(
  types: string[],
  current: NormalizedEvent[],
  scope?: string
): Promise<void> {
  return new Promise((resolve) => {
    queue.push({ kind: 'reconcile', types, current, scope, done: resolve })
    schedule()
  })
}

/** Runs `fn` on the engine worker, after everything queued before it. */
export function runOnEngine<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let result: T
    queue.push({
      kind: 'task',
      run: async () => {
        result = await fn()
      },
      done: (error) => (error ? reject(error) : resolve(result)),
    })
    schedule()
  })
}

/** Resolves when every queued job is processed (tests, the CLI, shutdown). */
export async function flushAlertQueue(): Promise<void> {
  while (queue.length > 0 || draining) {
    if (!draining) kick()
    if (draining) await draining
    else break
  }
}

/** One engine tick now (tests; production runs it every 5 s). */
export function runAlertTick(): Promise<void> {
  return new Promise((resolve) => {
    queue.push({ kind: 'tick', done: resolve })
    schedule()
  })
}

/** Starts the 5 s tick and marks the boot (boot grace). Web environment only (boot.ts). */
export function startAlertEngine(options: { tickMs?: number } = {}): void {
  bootedAt = alertNow()
  paused = false
  if (tickTimer) return
  tickTimer = setInterval(() => {
    if (tickQueued) return
    tickQueued = true
    queue.push({ kind: 'tick', done: () => (tickQueued = false) })
    schedule()
  }, options.tickMs ?? 5000)
  tickTimer.unref()
  schedule()
}

/** Stops the tick and drains what is queued, for at most `timeoutMs`. */
export async function stopAlertEngine(timeoutMs = 2000): Promise<void> {
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
  tickQueued = false
  await Promise.race([
    flushAlertQueue(),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref()),
  ])
}

export function isInBootGrace(settings: AlertsSettings, now: DateTime = alertNow()): boolean {
  return bootedAt !== null && now < bootedAt.plus({ seconds: settings.bootGraceSeconds })
}

/** Tests only. */
export function _setEngineBootedAt(at: DateTime | null): void {
  bootedAt = at
}

/** Tests only: stop processing (jobs stay queued) or resume. */
export function _pauseAlertEngine(value: boolean): void {
  paused = value
  if (!value) schedule()
}

/** Tests only: the queued events (type, severity hint, dedupe key), oldest first. */
export function _queuedEvents(): Array<{ type: string; severity: Severity; dedupeKey: string }> {
  return queue.flatMap((j) =>
    j.kind === 'event'
      ? [{ type: j.event.type, severity: j.severityHint, dedupeKey: j.event.dedupeKey }]
      : []
  )
}

/** Tests only: forget queued jobs and in-memory state. */
export async function _resetAlertEngine(): Promise<void> {
  if (draining) await draining
  for (const job of queue.splice(0)) {
    if (job.kind === 'task') job.done(new Error('engine reset'))
    else if (job.kind !== 'event') job.done()
  }
  eventJobs = 0
  dropped = 0
  paused = false
  settingsCache = null
  suppressedRepeats.clear()
}

/* ------------------------------------------------------------------ */
/* Per-batch context                                                   */
/* ------------------------------------------------------------------ */

type EngineContext = { settings: AlertsSettings; zone: string; readAt: number }
let settingsCache: EngineContext | null = null

function validZone(zone: unknown): string | null {
  if (typeof zone !== 'string' || zone === '') return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return zone
  } catch {
    return null
  }
}

export async function instanceZone(): Promise<string> {
  return validZone(await SystemSetting.get<string>('timezone')) ?? 'UTC'
}

/** Settings and time zone, read once per drain (and at most a second old). */
async function engineContext(): Promise<EngineContext> {
  if (settingsCache && Date.now() - settingsCache.readAt < 1000) return settingsCache
  settingsCache = {
    settings: await getAlertsSettings(),
    zone: await instanceZone(),
    readAt: Date.now(),
  }
  return settingsCache
}

/* ------------------------------------------------------------------ */
/* Rendering helpers                                                   */
/* ------------------------------------------------------------------ */

export function renderInputFor(alert: Alert): RenderInput {
  return {
    id: alert.id ?? null,
    type: alert.type,
    kind: alert.kind,
    state: alert.state,
    severity: alert.severity,
    flapping: alert.flapping,
    subject: { kind: alert.subjectKind as never, ref: alert.subjectRef, label: alert.subjectLabel },
    label: alert.subjectLabel ?? (alert.subjectRef || alert.subjectKind),
    payload: alert.payload ?? {},
    firstRaisedAt: alert.firstRaisedAt,
    raisedAt: alert.raisedAt,
    openedAt: alert.openedAt,
    resolvedAt: alert.resolvedAt,
    eventCount: alert.eventCount,
    transitions: alert.transitions,
  }
}

/** Stores the inbox texts of an alert's current state. */
function rerender(alert: Alert, def: AlertTypeDef, ctx: EngineContext, now: DateTime): void {
  const text = renderAlert(def, renderInputFor(alert), {
    transition: alert.state === 'resolved' ? 'resolved' : 'opened',
    wasNotified: alert.notified || alert.openedAt !== null,
    redact: false,
    zone: ctx.zone,
    now,
  })
  alert.title = text.title
  alert.body = text.body
  if (text.path) alert.path = text.path
}

function rank(severity: Severity): number {
  return SEVERITY_RANK[severity]
}

function eventSeverity(def: AlertTypeDef, rule: Rule, event: NormalizedEvent): Severity {
  return rule.severity !== 'auto' ? rule.severity : (event.severity ?? def.severity)
}

function phaseFor(def: AlertTypeDef, phase: EventPhase | null): EventPhase {
  if (def.kind === 'notice') return phase === 'clear' ? 'clear' : 'instant'
  if (phase === 'clear') return 'clear'
  return 'raise'
}

/* ------------------------------------------------------------------ */
/* Notify                                                              */
/* ------------------------------------------------------------------ */

async function notify(
  alert: Alert,
  def: AlertTypeDef,
  rule: Rule,
  transition: Transition,
  ctx: EngineContext,
  now: DateTime,
  options: { flapEnded?: boolean } = {}
): Promise<void> {
  if (!rule.notify) return
  const mute = await findMatchingMute(alert, now)
  if (mute) {
    if (!alert.muted) {
      alert.muted = true
      await alert.save()
    }
    return
  }
  if (alert.muted) {
    alert.muted = false
    await alert.save()
  }
  try {
    const created = await activeNotifier().notify({
      alert,
      def,
      rule,
      transition,
      flapEnded: options.flapEnded ?? false,
      now,
      settings: ctx.settings,
      zone: ctx.zone,
    })
    if (created > 0 && transition !== 'resolved' && !alert.notified) {
      alert.notified = true
      await alert.save()
    }
  } catch (error) {
    logger.error({ err: error, alertId: alert.id, transition }, 'alerts: routing failed')
  }
}

/* ------------------------------------------------------------------ */
/* State machine                                                       */
/* ------------------------------------------------------------------ */

type Result = { outcome: EventOutcome; alert: Alert | null }

/** Keys whose last reconcile raise was boot_grace / withheld_mass: repeats are not logged again. */
const SUPPRESSED_MAX = 4096
const suppressedRepeats = new Map<string, EventOutcome>()

function rememberSuppressed(key: string, outcome: EventOutcome | null): void {
  suppressedRepeats.delete(key)
  if (outcome === null) return
  suppressedRepeats.set(key, outcome)
  while (suppressedRepeats.size > SUPPRESSED_MAX) {
    const oldest = suppressedRepeats.keys().next().value
    if (oldest === undefined) break
    suppressedRepeats.delete(oldest)
  }
}

async function recordEvent(
  event: NormalizedEvent,
  fields: {
    phase: EventPhase
    severity: Severity
    category: string
    outcome: EventOutcome
    alertId: number | null
    now: DateTime
  }
): Promise<void> {
  await AlertEvent.create({
    type: event.type,
    phase: fields.phase,
    severity: fields.severity,
    category: fields.category,
    subjectKind: event.subjectKind,
    subjectRef: event.subjectRef,
    dedupeKey: event.dedupeKey,
    payload: event.payload,
    source: event.source,
    occurredAt: event.occurredAt,
    recordedAt: fields.now,
    alertId: fields.alertId,
    outcome: fields.outcome,
  })
}

async function processEvent(
  event: NormalizedEvent,
  options: { fromReconcile?: boolean } = {}
): Promise<void> {
  const now = alertNow()
  const def = getAlertType(event.type)
  const phaseGuess: EventPhase = event.phase ?? 'instant'
  if (!def) {
    logger.warn({ type: event.type, source: event.source }, 'alerts: unknown event type dropped')
    await recordEvent(event, {
      phase: phaseGuess,
      severity: event.severity ?? 'info',
      category: '',
      outcome: 'unknown_type',
      alertId: null,
      now,
    })
    return
  }
  const phase = phaseFor(def, event.phase)
  if (!def.subjects.includes(event.subject.kind)) {
    logger.warn(
      { type: event.type, subject: event.subjectKind, accepted: def.subjects },
      'alerts: event subject kind not accepted by its type, dropped'
    )
    await recordEvent(event, {
      phase,
      severity: event.severity ?? def.severity,
      category: def.category,
      outcome: 'invalid_subject',
      alertId: null,
      now,
    })
    return
  }
  const ctx = await engineContext()
  const rule = effectiveRule(def, ctx.settings)
  const severity = eventSeverity(def, rule, event)
  if (!rule.enabled) {
    if (options.fromReconcile) return
    await recordEvent(event, {
      phase,
      severity,
      category: def.category,
      outcome: 'disabled',
      alertId: null,
      now,
    })
    return
  }

  let result: Result
  if (def.kind === 'notice') {
    result =
      phase === 'clear'
        ? { outcome: 'no_active', alert: null }
        : await processNotice(def, rule, event, severity, ctx, now)
  } else if (phase === 'clear') {
    result = await processClear(def, rule, event, ctx, now)
  } else {
    result = await processRaise(def, rule, event, severity, ctx, now)
  }

  const suppressed = result.outcome === 'boot_grace' || result.outcome === 'withheld_mass'
  if (suppressed && options.fromReconcile) {
    if (suppressedRepeats.get(event.dedupeKey) === result.outcome) return
    rememberSuppressed(event.dedupeKey, result.outcome)
  } else {
    rememberSuppressed(event.dedupeKey, null)
  }
  await recordEvent(event, {
    phase,
    severity,
    category: def.category,
    outcome: result.outcome,
    alertId: result.alert?.id ?? null,
    now,
  })
}

async function liveAlert(key: string): Promise<Alert | null> {
  return Alert.query().where('active_key', key).first()
}

async function anyLive(types: string[]): Promise<boolean> {
  const row = await db
    .from('alerts')
    .whereIn('type', types)
    .whereNotNull('active_key')
    .select('id')
    .first()
  return Boolean(row)
}

/** Flapping starts at the threshold: one notice, then silence. */
function startsFlapping(alert: Alert, rule: Rule, now: DateTime): boolean {
  if (rule.flapThreshold <= 0 || alert.flapping) return false
  if (alert.transitions < rule.flapThreshold) return false
  alert.flapping = true
  alert.bumpedAt = now
  alert.nextReminderAt = null
  return true
}

function scheduleReminder(alert: Alert, rule: Rule, now: DateTime): void {
  alert.nextReminderAt =
    rule.repeatMinutes > 0 && !alert.flapping && !alert.acknowledgedAt
      ? now.plus({ minutes: rule.repeatMinutes })
      : null
}

async function applyLabel(alert: Alert, subject: AlertSubject): Promise<void> {
  const { label, path } = await resolveSubjectLabel(subject)
  alert.subjectLabel = label ? label.slice(0, 160) : null
  alert.path = path.slice(0, 255)
}

async function processRaise(
  def: AlertTypeDef,
  rule: Rule,
  event: NormalizedEvent,
  severity: Severity,
  ctx: EngineContext,
  now: DateTime
): Promise<Result> {
  const key = event.dedupeKey
  const live = await liveAlert(key)
  if (live) {
    live.lastEventAt = now
    live.eventCount += 1
    if (event.payload) live.payload = event.payload
    const rose = rank(severity) > rank(live.severity)
    if (rose) live.severity = severity
    if (live.state === 'active' && rose) {
      live.bumpedAt = now
      rerender(live, def, ctx, now)
      await live.save()
      if (live.notified && !live.flapping && !live.acknowledgedAt) {
        await notify(live, def, rule, 'escalated', ctx, now)
      }
      return { outcome: 'escalated', alert: live }
    }
    if (rose) rerender(live, def, ctx, now)
    await live.save()
    return { outcome: 'updated', alert: live }
  }

  const last = await Alert.query()
    .where('dedupe_key', key)
    .where('kind', 'condition')
    .orderBy('id', 'desc')
    .first()

  // Raised again inside the recovery hold: back to active, recovery cancelled,
  // not re-notified (you still believe it is down).
  if (last && last.state === 'resolved' && last.recoveryDueAt) {
    last.state = 'active'
    last.activeKey = key
    last.recoveryDueAt = null
    last.resolvedAt = null
    last.lastTransitionAt = now
    last.lastEventAt = now
    last.eventCount += 1
    last.transitions += 1
    if (event.payload) last.payload = event.payload
    if (rank(severity) > rank(last.severity)) last.severity = severity
    scheduleReminder(last, rule, now)
    const flapNow = startsFlapping(last, rule, now)
    rerender(last, def, ctx, now)
    await last.save()
    if (flapNow) await notify(last, def, rule, 'flapping', ctx, now)
    return { outcome: 'reopened', alert: last }
  }

  if (def.bootGrace && isInBootGrace(ctx.settings, now))
    return { outcome: 'boot_grace', alert: null }
  if (def.withheldBy && def.withheldBy.length > 0 && (await anyLive(def.withheldBy))) {
    return { outcome: 'withheld_mass', alert: null }
  }

  // A resolved alert of the same key inside the flap window is reopened (one
  // more transition) instead of starting a new one. A hand-resolved one is not.
  const reopen =
    last !== null &&
    last.state === 'resolved' &&
    last.resolvedByUserId === null &&
    rule.flapThreshold > 0 &&
    last.lastTransitionAt !== null &&
    last.lastTransitionAt >= now.minus({ minutes: rule.flapWindowMinutes })

  const alert = reopen && last ? last : new Alert()
  if (reopen) {
    alert.transitions += 1
    alert.acknowledgedAt = null
    alert.acknowledgedByUserId = null
    alert.ackNote = null
    alert.resolvedByUserId = null
    alert.severity = severity
  } else {
    alert.type = def.type
    alert.category = def.category
    alert.kind = 'condition'
    alert.severity = severity
    alert.dedupeKey = key
    alert.subjectKind = event.subjectKind
    alert.subjectRef = event.subjectRef
    alert.firstRaisedAt = now
    alert.eventCount = 0
    alert.transitions = 0
    alert.flapping = false
    alert.muted = false
    alert.notified = false
    alert.openedAt = null
    alert.bumpedAt = now
    alert.createdAt = now
    alert.path = pathFor(event.subject)
    await applyLabel(alert, event.subject)
  }
  alert.state = 'pending'
  alert.activeKey = key
  alert.raisedAt = now
  alert.lastEventAt = now
  alert.lastTransitionAt = now
  alert.eventCount += 1
  if (event.payload) alert.payload = event.payload
  else if (!reopen) alert.payload = null
  alert.resolvedAt = null
  alert.quietResolve = false
  alert.recoveryDueAt = null
  alert.nextReminderAt = null
  alert.notifyAt = now.plus({ seconds: rule.holdSeconds })

  const flapNow = reopen ? startsFlapping(alert, rule, now) : false
  if (rule.holdSeconds === 0) {
    alert.state = 'active'
    alert.openedAt = now
    alert.bumpedAt = now
    alert.notifyAt = null
    scheduleReminder(alert, rule, now)
  }
  rerender(alert, def, ctx, now)
  try {
    await alert.save()
  } catch (error) {
    // Another process (a CLI run) created the live alert first: treat as an update.
    const racing = await liveAlert(key)
    if (!racing) throw error
    return { outcome: 'updated', alert: racing }
  }

  if (flapNow) await notify(alert, def, rule, 'flapping', ctx, now)
  else if (alert.state === 'active' && !alert.flapping) {
    await notify(alert, def, rule, 'opened', ctx, now)
  }
  return { outcome: reopen ? 'reopened' : 'opened', alert }
}

async function processClear(
  def: AlertTypeDef,
  rule: Rule,
  event: NormalizedEvent,
  ctx: EngineContext,
  now: DateTime
): Promise<Result> {
  const live = await liveAlert(event.dedupeKey)
  if (!live) return { outcome: 'no_active', alert: null }
  live.lastEventAt = now
  live.eventCount += 1
  if (event.payload) live.payload = { ...(live.payload ?? {}), ...event.payload }
  live.activeKey = null
  live.resolvedAt = now
  live.lastTransitionAt = now
  live.notifyAt = null
  live.nextReminderAt = null

  if (live.state === 'pending') {
    // Cleared inside its hold: a blip, never notified.
    live.state = 'resolved'
    live.quietResolve = live.openedAt === null && !live.flapping
    rerender(live, def, ctx, now)
    await live.save()
    return { outcome: 'blip', alert: live }
  }

  live.state = 'resolved'
  live.quietResolve = false
  let recoveryNow = false
  if (!live.flapping && live.notified && rule.notifyRecovery) {
    if (rule.recoveryHoldSeconds > 0) {
      live.recoveryDueAt = now.plus({ seconds: rule.recoveryHoldSeconds })
    } else {
      recoveryNow = true
    }
  }
  rerender(live, def, ctx, now)
  await live.save()
  if (recoveryNow) {
    await notify(live, def, rule, 'resolved', ctx, now)
  } else if (!live.flapping && !live.recoveryDueAt) {
    await activeNotifier().collapse(live.id, now)
  }
  return { outcome: 'resolved', alert: live }
}

async function processNotice(
  def: AlertTypeDef,
  rule: Rule,
  event: NormalizedEvent,
  severity: Severity,
  ctx: EngineContext,
  now: DateTime
): Promise<Result> {
  if (rule.dedupeMinutes > 0) {
    const previous = await Alert.query()
      .where('dedupe_key', event.dedupeKey)
      .where('state', 'posted')
      .where('first_raised_at', '>=', sqlTime(now.minus({ minutes: rule.dedupeMinutes })))
      .orderBy('id', 'desc')
      .first()
    if (previous) {
      previous.eventCount += 1
      previous.lastEventAt = now
      if (event.payload) previous.payload = event.payload
      if (rank(severity) > rank(previous.severity)) previous.severity = severity
      await previous.save()
      return { outcome: 'merged', alert: previous }
    }
  }
  const alert = new Alert()
  alert.type = def.type
  alert.category = def.category
  alert.kind = 'notice'
  alert.state = 'posted'
  alert.severity = severity
  alert.dedupeKey = event.dedupeKey
  alert.activeKey = null
  alert.subjectKind = event.subjectKind
  alert.subjectRef = event.subjectRef
  alert.path = pathFor(event.subject)
  await applyLabel(alert, event.subject)
  alert.payload = event.payload
  alert.firstRaisedAt = now
  alert.raisedAt = now
  alert.lastEventAt = now
  alert.lastTransitionAt = now
  alert.openedAt = now
  alert.bumpedAt = now
  alert.createdAt = now
  alert.eventCount = 1
  alert.transitions = 0
  alert.flapping = false
  alert.muted = false
  alert.notified = false
  alert.quietResolve = false
  rerender(alert, def, ctx, now)
  await alert.save()
  await notify(alert, def, rule, 'opened', ctx, now)
  return { outcome: 'posted', alert }
}

/* ------------------------------------------------------------------ */
/* Reconcile                                                           */
/* ------------------------------------------------------------------ */

async function processReconcile(
  types: string[],
  current: NormalizedEvent[],
  scope?: string
): Promise<void> {
  if (types.length === 0) return
  const ctx = await engineContext()
  const rows = (await db
    .from('alerts')
    .whereIn('type', types)
    .whereNotNull('active_key')
    .select('type', 'dedupe_key', 'severity', 'subject_kind', 'subject_ref')) as Array<{
    type: string
    dedupe_key: string
    severity: Severity
    subject_kind: string
    subject_ref: string
  }>
  const live = new Map(rows.map((r) => [r.dedupe_key, r]))
  const seen = new Set<string>()

  for (const event of current) {
    if (seen.has(event.dedupeKey)) continue
    seen.add(event.dedupeKey)
    const def = getAlertType(event.type)
    if (!def) {
      await processEvent({ ...event, phase: 'raise' })
      continue
    }
    const rule = effectiveRule(def, ctx.settings)
    if (!rule.enabled) continue
    const held = live.get(event.dedupeKey)
    if (!held) {
      await processEvent({ ...event, phase: 'raise' }, { fromReconcile: true })
    } else if (rank(eventSeverity(def, rule, event)) > rank(held.severity)) {
      await processEvent({ ...event, phase: 'raise' }, { fromReconcile: true })
    }
  }

  for (const [key, held] of live) {
    if (seen.has(key)) continue
    if (scope && !key.startsWith(scope)) continue
    const subject = subjectFromRef(held.subject_kind, held.subject_ref)
    if (!subject) continue
    await processEvent(
      {
        type: held.type,
        phase: 'clear',
        subject,
        subjectKind: held.subject_kind,
        subjectRef: held.subject_ref,
        dedupeKey: key,
        severity: null,
        payload: null,
        occurredAt: alertNow(),
        source: 'reconcile',
      },
      { fromReconcile: true }
    )
  }
  // Keys not raised any more forget their suppressed-repeat marker.
  for (const key of [...suppressedRepeats.keys()]) {
    if (types.some((t) => key.startsWith(`${t}:`)) && !seen.has(key)) suppressedRepeats.delete(key)
  }
}

/** Normalizes the level-triggered input of `reconcileConditions` (emit.ts). */
export function normalizeConditions(current: ConditionInput[]): NormalizedEvent[] {
  const out: NormalizedEvent[] = []
  for (const input of current) {
    const event = normalizeEmit(input)
    if (event) out.push(event)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Tick                                                                */
/* ------------------------------------------------------------------ */

const TICK_BATCH = 200

function ruleOf(alert: Alert, ctx: EngineContext): { def: AlertTypeDef; rule: Rule } | null {
  const def = getAlertType(alert.type)
  return def ? { def, rule: effectiveRule(def, ctx.settings) } : null
}

async function processTick(): Promise<void> {
  const now = alertNow()
  const ctx = await engineContext()
  const at = sqlTime(now)

  // 1. Holds that passed: pending → active, notify `opened`.
  const due = await Alert.query()
    .where('state', 'pending')
    .whereNotNull('notify_at')
    .where('notify_at', '<=', at)
    .orderBy('notify_at', 'asc')
    .limit(TICK_BATCH)
  for (const alert of due) {
    const typed = ruleOf(alert, ctx)
    alert.state = 'active'
    alert.openedAt = now
    alert.notifyAt = null
    alert.bumpedAt = now
    if (typed) scheduleReminder(alert, typed.rule, now)
    if (typed) rerender(alert, typed.def, ctx, now)
    await alert.save()
    if (typed && !alert.flapping) await notify(alert, typed.def, typed.rule, 'opened', ctx, now)
  }

  // 2. Recovery holds that passed: notify `resolved`.
  const recovered = await Alert.query()
    .where('state', 'resolved')
    .whereNotNull('recovery_due_at')
    .where('recovery_due_at', '<=', at)
    .orderBy('recovery_due_at', 'asc')
    .limit(TICK_BATCH)
  for (const alert of recovered) {
    alert.recoveryDueAt = null
    await alert.save()
    const typed = ruleOf(alert, ctx)
    if (typed) await notify(alert, typed.def, typed.rule, 'resolved', ctx, now)
  }

  // 3. Flapping periods without a transition for a whole window end.
  const flapping = await Alert.query().where('flapping', true).limit(500)
  for (const alert of flapping) {
    const typed = ruleOf(alert, ctx)
    const window = typed?.rule.flapWindowMinutes ?? 30
    if (alert.lastTransitionAt && alert.lastTransitionAt > now.minus({ minutes: window })) continue
    alert.flapping = false
    alert.transitions = 0
    if (alert.state === 'active') {
      alert.bumpedAt = now
      if (typed) scheduleReminder(alert, typed.rule, now)
    }
    await alert.save()
    if (!typed) continue
    if (alert.state === 'resolved' && typed.rule.notifyRecovery) {
      await notify(alert, typed.def, typed.rule, 'resolved', ctx, now, { flapEnded: true })
    } else if (alert.state === 'active') {
      await notify(alert, typed.def, typed.rule, 'opened', ctx, now, { flapEnded: true })
    }
  }

  // 4. Reminders.
  const reminders = await Alert.query()
    .where('state', 'active')
    .whereNotNull('next_reminder_at')
    .where('next_reminder_at', '<=', at)
    .limit(TICK_BATCH)
  for (const alert of reminders) {
    const typed = ruleOf(alert, ctx)
    if (!typed || typed.rule.repeatMinutes === 0 || alert.acknowledgedAt || alert.flapping) {
      alert.nextReminderAt = null
      await alert.save()
      continue
    }
    alert.nextReminderAt = now.plus({ minutes: typed.rule.repeatMinutes })
    await alert.save()
    await notify(alert, typed.def, typed.rule, 'reminder', ctx, now)
  }

  // 5. Grouped and held deliveries.
  try {
    await activeNotifier().tick(now, ctx.settings, ctx.zone)
  } catch (error) {
    logger.error({ err: error }, 'alerts: routing tick failed')
  }
}

/* ------------------------------------------------------------------ */
/* Admin actions (run on the worker)                                   */
/* ------------------------------------------------------------------ */

export type ManualResolveHook = (alert: Alert) => Promise<void>
const manualResolveHooks = new Map<string, ManualResolveHook>()

/**
 * A detector's reaction to an admin resolving one of its alerts by hand
 * (`wan.down`: forget that WAN, events.md §3.2).
 */
export function onManualResolve(type: string, hook: ManualResolveHook): void {
  manualResolveHooks.set(type, hook)
}

export class AlertActionError extends Error {
  constructor(
    readonly code: 'alert_not_found' | 'alert_not_condition' | 'alert_not_active',
    message: string
  ) {
    super(message)
  }
}

/** Acknowledge: stops reminders and escalation notices; recovery still goes out. */
export function acknowledgeAlert(id: number, userId: number, note?: string | null): Promise<Alert> {
  return runOnEngine(async () => {
    const alert = await Alert.find(id)
    if (!alert) throw new AlertActionError('alert_not_found', `Alert ${id} does not exist.`)
    if (!alert.acknowledgedAt) {
      alert.acknowledgedAt = alertNow()
      alert.acknowledgedByUserId = userId
    }
    if (note !== undefined && note !== null) alert.ackNote = note.slice(0, 300)
    alert.nextReminderAt = null
    await alert.save()
    return alert
  })
}

/**
 * Resolve a condition by hand, without a recovery notice. If the detector
 * still sees it, the next tick opens a new alert (never reopens this one).
 */
export function resolveAlertManually(
  id: number,
  userId: number,
  note?: string | null
): Promise<Alert> {
  return runOnEngine(async () => {
    const alert = await Alert.find(id)
    if (!alert) throw new AlertActionError('alert_not_found', `Alert ${id} does not exist.`)
    if (alert.kind !== 'condition') {
      throw new AlertActionError('alert_not_condition', 'Only conditions can be resolved.')
    }
    if (alert.state !== 'pending' && alert.state !== 'active') {
      throw new AlertActionError('alert_not_active', 'This alert is already resolved.')
    }
    const now = alertNow()
    const ctx = await engineContext()
    alert.state = 'resolved'
    alert.activeKey = null
    alert.resolvedAt = now
    alert.lastTransitionAt = now
    alert.notifyAt = null
    alert.nextReminderAt = null
    alert.recoveryDueAt = null
    alert.flapping = false
    alert.resolvedByUserId = userId
    if (note) alert.ackNote = note.slice(0, 300)
    const def = getAlertType(alert.type)
    if (def) rerender(alert, def, ctx, now)
    await alert.save()
    await activeNotifier().collapse(alert.id, now)
    const hook = manualResolveHooks.get(alert.type)
    if (hook) {
      try {
        await hook(alert)
      } catch (error) {
        logger.error({ err: error, alertId: alert.id }, 'alerts: manual-resolve hook failed')
      }
    }
    return alert
  })
}

/**
 * Mutes that ended early (a maintenance window closed, a mute deleted):
 * active alerts they kept silent notify now, unless another mute still
 * matches them.
 */
export function releaseMutedAlerts(
  scopes: Array<{ type: string | null; subjectKind: string | null; subjectRef: string | null }>
): Promise<void> {
  return runOnEngine(async () => {
    if (scopes.length === 0) return
    const now = alertNow()
    const ctx = await engineContext()
    const alerts = await Alert.query()
      .where('state', 'active')
      .where('muted', true)
      .where((q) => {
        for (const scope of scopes) {
          q.orWhere((s) => {
            if (scope.type) s.where('type', scope.type)
            if (scope.subjectKind) {
              s.where('subject_kind', scope.subjectKind).where(
                'subject_ref',
                scope.subjectRef ?? ''
              )
            }
          })
        }
      })
      .limit(TICK_BATCH)
    for (const alert of alerts) {
      const typed = ruleOf(alert, ctx)
      if (!typed || alert.flapping) continue
      await notify(alert, typed.def, typed.rule, 'opened', ctx, now)
    }
  })
}

/** A rule turned off: its live alerts resolve quietly (no recovery notices). */
export function resolveTypeQuietly(types: string[]): Promise<number> {
  return runOnEngine(async () => {
    if (types.length === 0) return 0
    const now = alertNow()
    const ctx = await engineContext()
    const alerts = await Alert.query().whereIn('type', types).whereNotNull('active_key')
    for (const alert of alerts) {
      alert.state = 'resolved'
      alert.activeKey = null
      alert.resolvedAt = now
      alert.lastTransitionAt = now
      alert.notifyAt = null
      alert.nextReminderAt = null
      alert.recoveryDueAt = null
      alert.quietResolve = alert.openedAt === null
      const def = getAlertType(alert.type)
      if (def) rerender(alert, def, ctx, now)
      await alert.save()
      await activeNotifier().collapse(alert.id, now)
    }
    return alerts.length
  })
}
