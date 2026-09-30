import Alert from '#models/alert'
import SystemSetting from '#models/system_setting'
import { getAlertType, listAlertTypes } from '#services/alerts/catalogue/index'
import { deliveryEnabled } from '#services/alerts/delivery_worker'
import { emitAlertEvent } from '#services/alerts/emit'
import { instanceZone, resolveTypeQuietly, runOnEngine } from '#services/alerts/engine'
import type { AlertsSettings } from '#services/alerts/model'
import {
  ALERTS_DEFAULTS,
  applyAlertsSettingsPatch,
  effectiveRule,
  getAlertsSettings,
  limitsView,
  saveAlertsSettings,
  settingsView,
  vapidSubjectFor,
} from '#services/alerts/settings'
import { catalogueTypeViews } from '#transformers/alerts'
import {
  alertSettingsUpdateValidator,
  alertTestValidator,
  checkSettingsUrls,
  validateRulesPatch,
} from '#validators/alert_settings'
import type { HttpContext } from '@adonisjs/core/http'
import encryption from '@adonisjs/core/services/encryption'
import { randomUUID } from 'node:crypto'

/**
 * Settings → Alerts (docs/design/alerts/api.md §3.5): global settings, the
 * rules (catalogue defaults ⊕ overrides) and a test alert through the whole
 * pipeline. Admin-only (the routes add `requireAdmin`). The VAPID rotation of
 * the same group lives in the push controller (WP-A3).
 */

type StoredVapid = {
  keyId?: unknown
  publicKey?: unknown
  privateKeyEncrypted?: unknown
  createdAt?: unknown
}

/** The `alerts_vapid` row as the settings page shows it (the private key never leaves). */
async function vapidView(settings: AlertsSettings) {
  const stored = await SystemSetting.get<StoredVapid>('alerts_vapid')
  if (!stored || typeof stored.publicKey !== 'string') return null
  let readable = false
  try {
    readable =
      typeof stored.privateKeyEncrypted === 'string' &&
      Boolean(encryption.decrypt<string>(stored.privateKeyEncrypted))
  } catch {
    readable = false
  }
  return {
    keyId: typeof stored.keyId === 'string' ? stored.keyId : null,
    publicKey: stored.publicKey,
    createdAt: typeof stored.createdAt === 'string' ? stored.createdAt : null,
    readable,
    subject: vapidSubjectFor(settings),
  }
}

type HeartbeatStatus = {
  lastPingAt: string | null
  lastStatus: number | null
  lastError: string | null
}

/** Last heartbeat ping, from the controller-lifecycle side (WP-A5a) when it is present. */
async function heartbeatInfo(): Promise<HeartbeatStatus> {
  const empty = { lastPingAt: null, lastStatus: null, lastError: null }
  const specifier: string = '#services/alerts/detectors/heartbeat'
  try {
    const mod = (await import(specifier)) as { heartbeatStatus?: () => Partial<HeartbeatStatus> }
    const status = mod.heartbeatStatus?.()
    if (!status) return empty
    return {
      lastPingAt: status.lastPingAt ?? null,
      lastStatus: status.lastStatus ?? null,
      lastError: status.lastError ?? null,
    }
  } catch {
    return empty
  }
}

async function settingsBody(settings: AlertsSettings) {
  const types = listAlertTypes()
  return {
    settings: settingsView(settings),
    rules: Object.fromEntries(types.map((def) => [def.type, effectiveRule(def, settings)])),
    overrides: settings.rules,
    defaults: settingsView(ALERTS_DEFAULTS),
    limits: limitsView(),
    catalogue: await catalogueTypeViews(types),
    timezone: await instanceZone(),
    vapid: await vapidView(settings),
    heartbeat: await heartbeatInfo(),
    deliveryEnabled: deliveryEnabled(),
  }
}

export default class AlertSettingsController {
  /**
   * GET /api/v1/settings/alerts
   */
  async show({ serialize }: HttpContext) {
    return serialize(await settingsBody(await getAlertsSettings()))
  }

  /**
   * PATCH /api/v1/settings/alerts
   *
   * Any subset of the settings plus `rules` (per type: a partial rule, or
   * null for the catalogue default). Records the request's origin as
   * `capturedOrigin`. A rule turned off resolves that type's live alerts
   * quietly.
   */
  async update({ request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(alertSettingsUpdateValidator)
    const errors = [
      ...checkSettingsUrls(payload),
      ...validateRulesPatch(payload.rules ?? {}, getAlertType),
    ]
    if (errors.length > 0) return response.unprocessableEntity({ errors })

    const before = await getAlertsSettings()
    const after = applyAlertsSettingsPatch(
      before,
      { ...payload, rules: payload.rules as Record<string, Record<string, unknown> | null> },
      { origin: `${request.protocol()}://${request.host()}`, lookup: getAlertType }
    )
    await saveAlertsSettings(after)

    const turnedOff = listAlertTypes()
      .filter((def) => effectiveRule(def, before).enabled && !effectiveRule(def, after).enabled)
      .map((def) => def.type)
    if (turnedOff.length > 0) await resolveTypeQuietly(turnedOff)
    return serialize(await settingsBody(after))
  }

  /**
   * POST /api/v1/settings/alerts/test
   *
   * A `system.test` notice through the whole pipeline (rules, filters, quiet
   * hours, grouping, rate limits). Answers once the engine has recorded it.
   */
  async test({ request, response, serialize }: HttpContext) {
    const body = await request.validateUsing(alertTestValidator)
    const dedupeKey = `system.test:${randomUUID()}`
    emitAlertEvent({
      type: 'system.test',
      subject: { kind: 'controller' },
      dedupeKey,
      severity: body.severity,
      payload: { from: 'Settings → Alerts', ...(body.title ? { title: body.title } : {}) },
      source: 'settings',
    })
    const alert = await runOnEngine(() => Alert.query().where('dedupe_key', dedupeKey).first())
    response.status(202)
    return serialize({ alertId: alert ? Number(alert.id) : null })
  }
}
