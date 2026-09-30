import ApConfigApply from '#models/ap_config_apply'
import ApConfigEvent from '#models/ap_config_event'
import ApConfigRevision from '#models/ap_config_revision'
import ApConfigSection from '#models/ap_config_section'
import type WifiRollout from '#models/wifi_rollout'
import { AgentOfflineError, AgentRpcError, AgentTimeoutError } from '#services/ap_agent_hub'
import { GatewayPlaneError } from '#services/gateway_config/errors'
import { ReadRefusedError } from '#services/gateway_config/gateway_agent'
import { QueueFullError } from '#services/gateway_config/serial_queue'
import type { UciValue } from '#services/gateway_config/types'
import { ApOfflineError } from '#services/wifi_config/agent'
import {
  acceptApDrift,
  discardApDraft,
  dismissApRejoin,
  findApConfig,
  healthAp,
  patchAp,
  refreshAp,
  rejoinAp,
  resolveApSections,
  restoreApRevision,
  resumeApEnforcement,
  revertApDriftNow,
  setApSectionScope,
  syncStatusAp,
  type ResolveSectionItem,
} from '#services/wifi_config/ap_service'
import { adoptionPendingCount } from '#services/wifi_config/fleet_service'
import {
  adminConfirmAp,
  findApApply,
  planApJobs,
  revertApApply,
  validateApStates,
} from '#services/wifi_config/lifecycle'
import { activeRollout } from '#services/wifi_config/rollouts'
import { getWifiConfigSettings } from '#services/wifi_config/settings'
import { loadApSections } from '#services/wifi_config/store'
import {
  apApplyViewOf,
  apApplyViews,
  apConfigViews,
  apEventView,
  applyKeysFor,
  apRevisionView,
  apSectionView,
  networkViews,
  rolloutViewOf,
} from '#transformers/wifi_config'
import { userRefs } from '#transformers/gateway_transformer'
import {
  perchIdsValidator,
  sectionFilterValidator,
  sectionResolveValidator,
  sectionScopeValidator,
} from '#validators/gateways'
import { apPatchValidator, rejoinValidator, wifiPagingValidator } from '#validators/wifi_config'
import type { HttpContext } from '@adonisjs/core/http'
import WifiDivergence from '#models/wifi_divergence'

/**
 * The per-AP Wi-Fi plane over REST (docs/design/wifi controller.md section
 * 7.2, under `/api/v1/wifi/config/aps`: `/wifi/aps` is the monitoring
 * pages'). Reads for every signed-in user, writes admin-only (the routes
 * add `requireAdmin`); entering managed and Authoritative Mode ON need the
 * current password. Refusals are `{ error, message, ...data }`.
 */

type Response = HttpContext['response']

/** Maps the plane's errors to the documented statuses. */
export function wifiRefusal(response: Response, error: unknown) {
  if (error instanceof GatewayPlaneError) {
    return response
      .status(error.status)
      .send({ error: error.code, message: error.message, ...error.data })
  }
  if (error instanceof QueueFullError) {
    return response
      .status(503)
      .send({ error: 'ap_busy', message: 'Too much work is queued for this access point.' })
  }
  if (error instanceof AgentOfflineError || error instanceof ApOfflineError) {
    return response
      .status(409)
      .send({ error: 'agent_offline', message: 'The access point’s agent is not connected.' })
  }
  if (error instanceof AgentTimeoutError) {
    return response
      .status(504)
      .send({ error: 'agent_timeout', message: 'The access point’s agent did not answer in time.' })
  }
  if (error instanceof ReadRefusedError) {
    return response
      .status(error.code === 'mode_off' ? 409 : 502)
      .send({ error: error.code, message: error.message })
  }
  if (error instanceof AgentRpcError) {
    const data = (error.data ?? {}) as Record<string, unknown>
    return response.status(502).send({
      error: typeof data.error === 'string' ? data.error : 'agent_error',
      message: error.message,
    })
  }
  throw error
}

/** `?apply=0` keeps a write as a draft (no rollout). */
export function applyFlag(ctx: HttpContext): boolean {
  const value = ctx.request.qs().apply
  return !(value === '0' || value === 'false')
}

/** A write's `WriteResult` envelope with the rollout's view. */
export async function writeResult<T>(
  object: T,
  outcome: {
    issues: unknown[]
    rollout: WifiRollout | null
    rolloutError: { error: string; message: string } | null
  }
) {
  return {
    object,
    issues: outcome.issues,
    rollout: outcome.rollout ? await rolloutViewOf(outcome.rollout) : null,
    rolloutError: outcome.rolloutError,
  }
}

function paging(input: { limit?: number; before?: number }) {
  return { limit: input.limit ?? 50, before: input.before ?? null }
}

async function apView(apId: number, detail = false) {
  const [view] = await apConfigViews(await getWifiConfigSettings(), { apIds: [apId], detail })
  return view ?? null
}

export default class WifiConfigApsController {
  /** GET /api/v1/wifi/config: APs, networks, open divergences, the active rollout, pending adoption. */
  async overview({ serialize }: HttpContext) {
    const settings = await getWifiConfigSettings()
    const [aps, networks, rollout, divergences, adoptionPending] = await Promise.all([
      apConfigViews(settings),
      networkViews(settings),
      activeRollout(),
      WifiDivergence.query().whereNull('resolved_at').count('* as total'),
      adoptionPendingCount(),
    ])
    return serialize({
      aps,
      networks,
      divergences: Number(divergences[0].$extras.total),
      rollout: rollout ? await rolloutViewOf(rollout) : null,
      adoptionPending,
    })
  }

  /** GET /api/v1/wifi/config/aps */
  async index(_ctx: HttpContext) {
    return { data: await apConfigViews(await getWifiConfigSettings()) }
  }

  /** GET /api/v1/wifi/config/aps/:apId */
  async show({ params, response, serialize }: HttpContext) {
    const view = await apView(Number(params.apId), true)
    if (!view)
      return response.status(404).send({ error: 'ap_not_found', message: 'No such access point.' })
    return serialize(view)
  }

  /** PATCH /api/v1/wifi/config/aps/:apId[?apply=0] → WriteResult<ApConfig> */
  async update(ctx: HttpContext) {
    const { params, request, response, auth, serialize } = ctx
    const payload = await request.validateUsing(apPatchValidator)
    try {
      const apId = Number(params.apId)
      const outcome = await patchAp(apId, auth.getUserOrFail(), payload, {
        apply: applyFlag(ctx),
        adminAddress: request.ip(),
      })
      return serialize(await writeResult(await apView(apId, true), outcome))
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** POST /api/v1/wifi/config/aps/:apId/refresh */
  async refresh({ params, response, serialize }: HttpContext) {
    try {
      return serialize(await refreshAp(Number(params.apId)))
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** GET /api/v1/wifi/config/aps/:apId/health?fresh=1 */
  async health({ params, request, response }: HttpContext) {
    const fresh = ['1', 'true'].includes(String(request.input('fresh', '0')))
    try {
      await findApConfig(Number(params.apId))
      return { data: await healthAp(Number(params.apId), fresh) }
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** POST /api/v1/wifi/config/aps/:apId/rejoin {use} */
  async rejoin({ params, request, response, auth, serialize }: HttpContext) {
    const { use } = await request.validateUsing(rejoinValidator)
    try {
      const rollout = await rejoinAp(Number(params.apId), auth.getUserOrFail(), use, {
        adminAddress: request.ip(),
      })
      response.status(202)
      return serialize(await rolloutViewOf(rollout))
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** POST /api/v1/wifi/config/aps/:apId/rejoin/dismiss */
  async dismissRejoin({ params, response, auth, serialize }: HttpContext) {
    try {
      await dismissApRejoin(Number(params.apId), auth.getUserOrFail().id)
      return serialize(await apView(Number(params.apId)))
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** GET /api/v1/wifi/config/aps/:apId/sync-status?fresh=0|1 */
  async syncStatus({ params, request, response, serialize }: HttpContext) {
    const fresh = ['1', 'true'].includes(String(request.input('fresh', '0')))
    try {
      return serialize(await syncStatusAp(Number(params.apId), fresh))
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** GET /api/v1/wifi/config/aps/:apId/sections?config=&scope=&status=&domain= */
  async sections({ params, request, response }: HttpContext) {
    const filter = await sectionFilterValidator.validate(request.qs())
    try {
      const ap = await findApConfig(Number(params.apId))
      const settings = await getWifiConfigSettings()
      const query = ApConfigSection.query()
        .where('ap_id', ap.apId)
        .orderBy('config')
        .orderBy('position')
        .orderBy('id')
      if (filter.config) query.where('config', filter.config)
      if (filter.scope) query.where('scope', filter.scope)
      if (filter.status) query.where('status', filter.status)
      if (filter.domain) query.where('domain', filter.domain)
      const rows = await query
      const context = {
        authoritative: ap.mode === 'managed' && Boolean(ap.authoritative),
        revertDelaySeconds: settings.authoritativeRevertDelaySeconds,
      }
      return { data: rows.map((row) => apSectionView(row, context)) }
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** GET /api/v1/wifi/config/aps/:apId/sections/:perchId?limit=&before= */
  async section({ params, request, response, serialize }: HttpContext) {
    const page = paging(await wifiPagingValidator.validate(request.qs()))
    try {
      const ap = await findApConfig(Number(params.apId))
      const row = await ApConfigSection.query()
        .where('ap_id', ap.apId)
        .where('perch_id', params.perchId)
        .first()
      if (!row) {
        return response
          .status(404)
          .send({ error: 'section_not_found', message: `No section ${params.perchId}.` })
      }
      const settings = await getWifiConfigSettings()
      const query = ApConfigRevision.query()
        .where('ap_id', ap.apId)
        .where('diff', 'like', `%"perchId":"${row.perchId}"%`)
        .orderBy('number', 'desc')
        .limit(page.limit)
      if (page.before) query.where('number', '<', page.before)
      const revisions = await query
      const users = await userRefs(revisions.map((r) => r.authorUserId))
      const keys = await applyKeysFor(revisions.map((r) => r.applyId))
      return serialize({
        section: apSectionView(row, {
          authoritative: ap.mode === 'managed' && Boolean(ap.authoritative),
          revertDelaySeconds: settings.authoritativeRevertDelaySeconds,
        }),
        history: {
          items: revisions
            .map((r) => ({
              ...apRevisionView(r, users, keys),
              change: r.diff.find((d) => d.perchId === row.perchId) ?? null,
            }))
            .filter((h) => h.change !== null),
          nextBefore:
            revisions.length === page.limit ? revisions[revisions.length - 1].number : null,
        },
      })
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** PATCH /api/v1/wifi/config/aps/:apId/sections/:perchId {scope} */
  async updateSection({ params, request, response, auth, serialize }: HttpContext) {
    const { scope } = await request.validateUsing(sectionScopeValidator)
    try {
      const apId = Number(params.apId)
      await setApSectionScope(apId, auth.getUserOrFail().id, params.perchId, scope)
      const ap = await findApConfig(apId)
      const settings = await getWifiConfigSettings()
      const row = await ApConfigSection.query()
        .where('ap_id', apId)
        .where('perch_id', params.perchId)
        .firstOrFail()
      return serialize(
        apSectionView(row, {
          authoritative: Boolean(ap.authoritative),
          revertDelaySeconds: settings.authoritativeRevertDelaySeconds,
        })
      )
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** POST /api/v1/wifi/config/aps/:apId/sections/resolve */
  async resolve({ params, request, response, auth, serialize }: HttpContext) {
    const { items } = await request.validateUsing(sectionResolveValidator)
    const parsed: ResolveSectionItem[] = []
    for (const item of items) {
      const options: Record<string, UciValue | null> = {}
      for (const [name, value] of Object.entries(item.options ?? {})) {
        const ok =
          value === null ||
          typeof value === 'string' ||
          (Array.isArray(value) && value.every((v) => typeof v === 'string'))
        if (!ok || !/^[A-Za-z0-9_]{1,64}$/.test(name)) {
          return response.unprocessableEntity({
            errors: [
              {
                field: `items.options.${name}`,
                rule: 'uciValue',
                message: 'An option value is a string, a list of strings, or null',
              },
            ],
          })
        }
        options[name] = value as UciValue | null
      }
      parsed.push({ perchId: item.perchId, take: item.take, options })
    }
    try {
      const apId = Number(params.apId)
      const ids = await resolveApSections(apId, auth.getUserOrFail().id, parsed)
      const ap = await findApConfig(apId)
      const settings = await getWifiConfigSettings()
      const rows = await ApConfigSection.query().where('ap_id', apId).whereIn('perch_id', ids)
      return serialize({
        sections: rows.map((row) =>
          apSectionView(row, {
            authoritative: Boolean(ap.authoritative),
            revertDelaySeconds: settings.authoritativeRevertDelaySeconds,
          })
        ),
      })
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** GET /api/v1/wifi/config/aps/:apId/draft */
  async draft({ params, response, serialize }: HttpContext) {
    try {
      const ap = await findApConfig(Number(params.apId))
      const { states } = await loadApSections(ap.apId)
      const plan = planApJobs(ap, states, {})
      return serialize({
        changes: plan.jobs.flatMap((j) => j.changes),
        jobs: plan.jobs.map((j) => ({
          kind: j.kind,
          protected: j.protected,
          configs: j.configs,
          perchIds: j.perchIds,
        })),
        issues: validateApStates(ap, states),
        blockedByConflicts: plan.blocked
          .filter((b) => b.reason === 'conflict')
          .map((b) => b.perchId),
      })
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** DELETE /api/v1/wifi/config/aps/:apId/draft {perchIds?} */
  async discardDraft({ params, request, response, auth, serialize }: HttpContext) {
    const { perchIds } = await request.validateUsing(perchIdsValidator)
    try {
      const discarded = await discardApDraft(Number(params.apId), auth.getUserOrFail().id, perchIds)
      return serialize({ discarded })
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** GET /api/v1/wifi/config/aps/:apId/applies?state=&limit=&before= */
  async applies({ params, request, response, serialize }: HttpContext) {
    const input = await wifiPagingValidator.validate(request.qs())
    const page = paging(input)
    try {
      const ap = await findApConfig(Number(params.apId))
      const query = ApConfigApply.query()
        .where('ap_id', ap.apId)
        .orderBy('id', 'desc')
        .limit(page.limit)
      if (page.before) query.where('id', '<', page.before)
      if (input.state) query.where('state', input.state)
      const rows = await query
      return serialize({
        items: await apApplyViews(rows),
        nextBefore: rows.length === page.limit ? Number(rows[rows.length - 1].id) : null,
      })
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** GET /api/v1/wifi/config/aps/:apId/applies/:applyId */
  async apply({ params, response, serialize }: HttpContext) {
    try {
      const apply = await findApApply(Number(params.apId), params.applyId)
      return serialize(await apApplyViewOf(apply, { changes: true }))
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** POST /api/v1/wifi/config/aps/:apId/applies/:applyId/confirm ("Keep changes") */
  async confirmApply({ params, response, auth, serialize }: HttpContext) {
    try {
      const apply = await adminConfirmAp(
        Number(params.apId),
        params.applyId,
        auth.getUserOrFail().id
      )
      return serialize(await apApplyViewOf(apply))
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** POST /api/v1/wifi/config/aps/:apId/applies/:applyId/revert */
  async revertApply({ params, response, auth, serialize }: HttpContext) {
    try {
      const apply = await revertApApply(
        Number(params.apId),
        params.applyId,
        auth.getUserOrFail().id
      )
      return serialize(await apApplyViewOf(apply))
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** GET /api/v1/wifi/config/aps/:apId/revisions?limit=&before= */
  async revisions({ params, request, response, serialize }: HttpContext) {
    const page = paging(await wifiPagingValidator.validate(request.qs()))
    try {
      const ap = await findApConfig(Number(params.apId))
      const query = ApConfigRevision.query()
        .where('ap_id', ap.apId)
        .orderBy('number', 'desc')
        .limit(page.limit)
      if (page.before) query.where('number', '<', page.before)
      const rows = await query
      const users = await userRefs(rows.map((r) => r.authorUserId))
      const keys = await applyKeysFor(rows.map((r) => r.applyId))
      return serialize({
        items: rows.map((r) => apRevisionView(r, users, keys)),
        nextBefore: rows.length === page.limit ? rows[rows.length - 1].number : null,
      })
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** GET /api/v1/wifi/config/aps/:apId/revisions/:number?snapshot=1 */
  async revision({ params, request, response, serialize }: HttpContext) {
    try {
      const ap = await findApConfig(Number(params.apId))
      const row = await ApConfigRevision.query()
        .where('ap_id', ap.apId)
        .where('number', Number(params.number))
        .first()
      if (!row) {
        return response
          .status(404)
          .send({ error: 'revision_not_found', message: `No revision ${params.number}.` })
      }
      const users = await userRefs([row.authorUserId])
      const keys = await applyKeysFor([row.applyId])
      const snapshot = ['1', 'true'].includes(String(request.input('snapshot', '0')))
      return serialize(apRevisionView(row, users, keys, { diff: true, snapshot }))
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /**
   * POST /api/v1/wifi/config/aps/:apId/revisions/:number/restore[?apply=0]
   * → `{ perchIds, changes, rollout, rolloutError }` (C := the snapshot; a
   * one-AP rollout unless `?apply=0`).
   */
  async restoreRevision(ctx: HttpContext) {
    const { params, request, response, auth, serialize } = ctx
    try {
      const apId = Number(params.apId)
      const outcome = await restoreApRevision(apId, auth.getUserOrFail(), Number(params.number), {
        apply: applyFlag(ctx),
        adminAddress: request.ip(),
      })
      const ap = await findApConfig(apId)
      const { states } = await loadApSections(apId)
      const plan =
        outcome.perchIds.length > 0
          ? planApJobs(ap, states, { perchIds: outcome.perchIds })
          : { jobs: [] }
      return serialize({
        perchIds: outcome.perchIds,
        changes: plan.jobs.flatMap((j) => j.changes),
        rollout: outcome.rollout ? await rolloutViewOf(outcome.rollout) : null,
        rolloutError: outcome.rolloutError,
      })
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** POST /api/v1/wifi/config/aps/:apId/drift/accept {perchIds?} */
  async acceptDrift({ params, request, response, auth, serialize }: HttpContext) {
    const { perchIds } = await request.validateUsing(perchIdsValidator)
    try {
      const ids = await acceptApDrift(Number(params.apId), auth.getUserOrFail().id, perchIds)
      return serialize({ accepted: ids })
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** POST /api/v1/wifi/config/aps/:apId/drift/revert-now {perchIds?} */
  async revertDrift({ params, request, response, auth, serialize }: HttpContext) {
    const { perchIds } = await request.validateUsing(perchIdsValidator)
    try {
      const apply = await revertApDriftNow(Number(params.apId), auth.getUserOrFail().id, perchIds)
      response.status(202)
      return serialize(await apApplyViewOf(apply))
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** POST /api/v1/wifi/config/aps/:apId/enforcement/resume */
  async resumeEnforcement({ params, response, auth, serialize }: HttpContext) {
    try {
      await resumeApEnforcement(Number(params.apId), auth.getUserOrFail().id)
      return serialize(await apView(Number(params.apId)))
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** GET /api/v1/wifi/config/aps/:apId/events?limit=&before= */
  async events({ params, request, response, serialize }: HttpContext) {
    const page = paging(await wifiPagingValidator.validate(request.qs()))
    try {
      const ap = await findApConfig(Number(params.apId))
      const query = ApConfigEvent.query()
        .where('ap_id', ap.apId)
        .orderBy('id', 'desc')
        .limit(page.limit)
      if (page.before) query.where('id', '<', page.before)
      const rows = await query
      const users = await userRefs(rows.map((r) => r.userId))
      const keys = await applyKeysFor(rows.map((r) => r.applyId))
      return serialize({
        items: rows.map((r) => apEventView(r, users, keys)),
        nextBefore: rows.length === page.limit ? Number(rows[rows.length - 1].id) : null,
      })
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** GET /api/v1/wifi/config/aps/:apId/pairing (phase 3: pairing is not built yet) */
  async pairing({ params, response, serialize }: HttpContext) {
    try {
      const ap = await findApConfig(Number(params.apId))
      return serialize({ pairing: ap.pairing ?? null })
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }

  /** POST|DELETE …/pairing, POST …/pairing/confirm: refused until phase 3. */
  async pairingUnavailable({ params, response }: HttpContext) {
    try {
      await findApConfig(Number(params.apId))
      return response.status(409).send({
        error: 'pairing_unavailable',
        message: 'Pairing for plain-HTTP writes comes with a later release: use verified TLS.',
      })
    } catch (error) {
      return wifiRefusal(response, error)
    }
  }
}
