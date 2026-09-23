import GatewayApply from '#models/gateway_apply'
import GatewayConfigEvent from '#models/gateway_config_event'
import GatewayRevision from '#models/gateway_revision'
import GatewaySection from '#models/gateway_section'
import { AgentOfflineError, AgentRpcError, AgentTimeoutError } from '#services/collector_agent_hub'
import {
  adminConfirm,
  findApply,
  requestApply,
  requestPackageInstall,
  revertApply,
  plannedOrders,
  validateStates,
} from '#services/gateway_config/apply_lifecycle'
import { planApply } from '#services/gateway_config/apply_plan'
import { loadOrders } from '#services/gateway_config/order_store'
import { domainRegistry } from '#services/gateway_config/domains/index'
import { GatewayPlaneError } from '#services/gateway_config/errors'
import { GatewayOfflineError, ReadRefusedError } from '#services/gateway_config/gateway_agent'
import {
  acceptDriftSections,
  bindGateway,
  discardDraft,
  dismissRejoin,
  findGateway,
  patchGateway,
  refreshGateway,
  resolveSections,
  restoreRevision,
  resumeEnforcement,
  revertDriftNow,
  setSectionScope,
  setSignKey,
  syncStatus,
  type ResolveItem,
} from '#services/gateway_config/gateway_config_service'
import { getGatewayConfigSettings } from '#services/gateway_config/gateway_config_settings'
import { ensureGatewayRows, normalizeMode } from '#services/gateway_config/gateway_registry'
import { loadSections } from '#services/gateway_config/gateway_store'
import { confirmPairing, pairingView, startPairing, unpair } from '#services/gateway_config/pairing'
import { QueueFullError } from '#services/gateway_config/serial_queue'
import type { UciValue } from '#services/gateway_config/types'
import {
  applyViewOf,
  applyViews,
  eventView,
  gatewayViews,
  revisionView,
  sectionView,
  userRefs,
} from '#transformers/gateway_transformer'
import {
  applyCreateValidator,
  gatewayBindValidator,
  gatewayPatchValidator,
  packageInstallValidator,
  pagingValidator,
  pairingConfirmValidator,
  pairingStartValidator,
  perchIdsValidator,
  sectionFilterValidator,
  sectionResolveValidator,
  sectionScopeValidator,
  signKeyValidator,
} from '#validators/gateways'
import type { HttpContext } from '@adonisjs/core/http'
import Gateway from '#models/gateway'

/**
 * The managed gateway's config plane over REST (docs/gateway/config-plane.md
 * section 10). Reads are open to every signed-in user; writes are admin-only
 * (the routes add `requireAdmin`), and entering managed mode or turning
 * Authoritative Mode on needs the admin's current password as well.
 * Refusals are `{ error, message, ...data }` with the documented status.
 */

type Response = HttpContext['response']

/** Maps the plane's errors to the documented statuses. */
export function planeRefusal(response: Response, error: unknown) {
  if (error instanceof GatewayPlaneError) {
    return response
      .status(error.status)
      .send({ error: error.code, message: error.message, ...error.data })
  }
  if (error instanceof QueueFullError) {
    return response
      .status(503)
      .send({ error: 'gateway_busy', message: 'Too much work is queued for this gateway.' })
  }
  if (error instanceof AgentOfflineError || error instanceof GatewayOfflineError) {
    return response
      .status(409)
      .send({ error: 'agent_offline', message: 'The gateway agent is not connected.' })
  }
  if (error instanceof AgentTimeoutError) {
    return response
      .status(504)
      .send({ error: 'agent_timeout', message: 'The gateway agent did not answer in time.' })
  }
  if (error instanceof ReadRefusedError) {
    return response.status(error.code === 'mode_off' ? 409 : 502).send({
      error: error.code,
      message: error.message,
    })
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

function paging(input: { limit?: number; before?: number }) {
  return { limit: input.limit ?? 50, before: input.before ?? null }
}

async function applyKeysFor(ids: Array<bigint | number | null>): Promise<Map<number, string>> {
  const wanted = [...new Set(ids.filter((id) => id !== null).map((id) => Number(id)))]
  if (wanted.length === 0) return new Map()
  const rows = await GatewayApply.query().whereIn('id', wanted).select('id', 'apply_key')
  return new Map(rows.map((r) => [Number(r.id), r.applyKey]))
}

export default class GatewaysController {
  /** GET /api/v1/gateways */
  async index(_ctx: HttpContext) {
    await ensureGatewayRows()
    const gateways = await Gateway.query().orderBy('id')
    // A plain array is not wrapped by `serialize`: wrap it here.
    return { data: await gatewayViews(gateways, await getGatewayConfigSettings()) }
  }

  /** GET /api/v1/gateways/:id */
  async show({ params, response, serialize }: HttpContext) {
    try {
      const gateway = await findGateway(Number(params.id))
      const [view] = await gatewayViews([gateway], await getGatewayConfigSettings(), {
        detail: true,
      })
      return serialize(view)
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** PATCH /api/v1/gateways/:id */
  async update({ params, request, response, auth, serialize }: HttpContext) {
    const payload = await request.validateUsing(gatewayPatchValidator)
    try {
      const gateway = await patchGateway(Number(params.id), auth.getUserOrFail(), payload)
      const [view] = await gatewayViews([gateway], await getGatewayConfigSettings())
      return serialize(view)
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** POST /api/v1/gateways/:id/bind */
  async bind({ params, request, response, auth, serialize }: HttpContext) {
    const { collectorId } = await request.validateUsing(gatewayBindValidator)
    try {
      const gateway = await bindGateway(Number(params.id), auth.getUserOrFail().id, collectorId)
      const [view] = await gatewayViews([gateway], await getGatewayConfigSettings())
      return serialize(view)
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** POST /api/v1/gateways/:id/refresh */
  async refresh({ params, response, serialize }: HttpContext) {
    try {
      return serialize(await refreshGateway(Number(params.id)))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** GET /api/v1/gateways/:id/sync-status?fresh=0|1 */
  async syncStatus({ params, request, response, serialize }: HttpContext) {
    const fresh = ['1', 'true'].includes(String(request.input('fresh', '0')))
    try {
      return serialize(await syncStatus(Number(params.id), fresh))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** GET /api/v1/gateways/:id/sections?config=&scope=&status=&domain= */
  async sections({ params, request, response }: HttpContext) {
    const filter = await sectionFilterValidator.validate(request.qs())
    try {
      const gateway = await findGateway(Number(params.id))
      const settings = await getGatewayConfigSettings()
      const query = GatewaySection.query()
        .where('gateway_id', gateway.id)
        .orderBy('config')
        .orderBy('position')
        .orderBy('id')
      if (filter.config) query.where('config', filter.config)
      if (filter.scope) query.where('scope', filter.scope)
      if (filter.status) query.where('status', filter.status)
      if (filter.domain) query.where('domain', filter.domain)
      const rows = await query
      const context = {
        authoritative: normalizeMode(gateway.mode) === 'managed' && Boolean(gateway.authoritative),
        revertDelaySeconds: settings.authoritativeRevertDelaySeconds,
      }
      return { data: rows.map((row) => sectionView(row, context)) }
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /**
   * GET /api/v1/gateways/:id/sections/:perchId — the section with its
   * history: the revisions whose diff touches it, newest first (paged).
   */
  async section({ params, request, response, serialize }: HttpContext) {
    const page = paging(await pagingValidator.validate(request.qs()))
    try {
      const gateway = await findGateway(Number(params.id))
      const row = await GatewaySection.query()
        .where('gateway_id', gateway.id)
        .where('perch_id', params.perchId)
        .first()
      if (!row) {
        return response
          .status(404)
          .send({ error: 'section_not_found', message: `No section ${params.perchId}.` })
      }
      const settings = await getGatewayConfigSettings()
      const query = GatewayRevision.query()
        .where('gateway_id', gateway.id)
        .where('diff', 'like', `%"perchId":"${row.perchId}"%`)
        .orderBy('number', 'desc')
        .limit(page.limit)
      if (page.before) query.where('number', '<', page.before)
      const revisions = await query
      const users = await userRefs(revisions.map((r) => r.authorUserId))
      const keys = await applyKeysFor(revisions.map((r) => r.applyId))
      const history = revisions
        .map((r) => ({
          ...revisionView(r, users, keys),
          change: r.diff.find((d) => d.perchId === row.perchId) ?? null,
        }))
        .filter((h) => h.change !== null)
      return serialize({
        section: sectionView(row, {
          authoritative:
            normalizeMode(gateway.mode) === 'managed' && Boolean(gateway.authoritative),
          revertDelaySeconds: settings.authoritativeRevertDelaySeconds,
        }),
        history: {
          items: history,
          nextBefore:
            revisions.length === page.limit ? revisions[revisions.length - 1].number : null,
        },
      })
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** PATCH /api/v1/gateways/:id/sections/:perchId {scope} */
  async updateSection({ params, request, response, auth, serialize }: HttpContext) {
    const { scope } = await request.validateUsing(sectionScopeValidator)
    try {
      await setSectionScope(Number(params.id), auth.getUserOrFail().id, params.perchId, scope)
      const gateway = await findGateway(Number(params.id))
      const settings = await getGatewayConfigSettings()
      const row = await GatewaySection.query()
        .where('gateway_id', gateway.id)
        .where('perch_id', params.perchId)
        .firstOrFail()
      return serialize(
        sectionView(row, {
          authoritative: Boolean(gateway.authoritative),
          revertDelaySeconds: settings.authoritativeRevertDelaySeconds,
        })
      )
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** POST /api/v1/gateways/:id/sections/resolve */
  async resolve({ params, request, response, auth, serialize }: HttpContext) {
    const { items } = await request.validateUsing(sectionResolveValidator)
    const parsed: ResolveItem[] = []
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
      if (item.take === 'custom' && Object.keys(options).length === 0) {
        return response.unprocessableEntity({
          errors: [{ field: 'items.options', rule: 'required', message: 'custom needs options' }],
        })
      }
      parsed.push({ perchId: item.perchId, take: item.take, options })
    }
    try {
      const gatewayId = Number(params.id)
      const ids = await resolveSections(gatewayId, auth.getUserOrFail().id, parsed)
      const gateway = await findGateway(gatewayId)
      const settings = await getGatewayConfigSettings()
      const rows = await GatewaySection.query()
        .where('gateway_id', gatewayId)
        .whereIn('perch_id', ids)
      return serialize({
        sections: rows.map((row) =>
          sectionView(row, {
            authoritative: Boolean(gateway.authoritative),
            revertDelaySeconds: settings.authoritativeRevertDelaySeconds,
          })
        ),
      })
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** GET /api/v1/gateways/:id/draft */
  async draft({ params, response, serialize }: HttpContext) {
    try {
      const gateway = await findGateway(Number(params.id))
      const { states } = await loadSections(gateway.id)
      const plan = planApply({
        sections: states,
        kind: 'apply',
        ledger: gateway.observedLedger ?? [],
        hashes: gateway.observedHashes ?? {},
        management: gateway.managementPath,
        registry: domainRegistry(),
        orders: plannedOrders(await loadOrders(gateway.id), 'apply'),
      })
      return serialize({
        changes: plan.jobs.flatMap((j) => j.changes),
        jobs: plan.jobs.map((j) => ({
          kind: j.kind,
          protected: j.protected,
          configs: j.configs,
          perchIds: j.perchIds,
        })),
        issues: validateStates(gateway, states),
        blockedByConflicts: plan.blocked
          .filter((b) => b.reason === 'conflict')
          .map((b) => b.perchId),
      })
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** DELETE /api/v1/gateways/:id/draft {perchIds?} */
  async discardDraft({ params, request, response, auth, serialize }: HttpContext) {
    const { perchIds } = await request.validateUsing(perchIdsValidator)
    try {
      const discarded = await discardDraft(Number(params.id), auth.getUserOrFail().id, perchIds)
      return serialize({ discarded })
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** POST /api/v1/gateways/:id/applies */
  async createApply({ params, request, response, auth, serialize }: HttpContext) {
    const payload = await request.validateUsing(applyCreateValidator)
    try {
      const result = await requestApply(Number(params.id), {
        userId: auth.getUserOrFail().id,
        perchIds: payload.perchIds,
        dryRun: payload.dryRun,
        confirmMode: payload.confirmMode,
        note: payload.note ?? null,
      })
      if (result instanceof GatewayApply) {
        response.status(202)
        return serialize(await applyViewOf(result, { changes: true }))
      }
      return serialize(result)
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** POST /api/v1/gateways/:id/packages (README 7.7: "Install on gateway") */
  async installPackages({ params, request, response, auth, serialize }: HttpContext) {
    const payload = await request.validateUsing(packageInstallValidator)
    try {
      const result = await requestPackageInstall(Number(params.id), {
        userId: auth.getUserOrFail().id,
        packages: payload.packages,
        dryRun: payload.dryRun,
        note: payload.note ?? null,
      })
      if (result instanceof GatewayApply) {
        response.status(202)
        return serialize(await applyViewOf(result))
      }
      return serialize(result)
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** PUT /api/v1/gateways/:id/sign-key {key, currentPassword} */
  async setSignKey({ params, request, response, auth, serialize }: HttpContext) {
    const payload = await request.validateUsing(signKeyValidator)
    try {
      const gateway = await setSignKey(
        Number(params.id),
        auth.getUserOrFail(),
        payload.key,
        payload.currentPassword
      )
      const [view] = await gatewayViews([gateway], await getGatewayConfigSettings())
      return serialize(view)
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** DELETE /api/v1/gateways/:id/sign-key */
  async clearSignKey({ params, response, auth, serialize }: HttpContext) {
    try {
      const gateway = await setSignKey(Number(params.id), auth.getUserOrFail(), null, undefined)
      const [view] = await gatewayViews([gateway], await getGatewayConfigSettings())
      return serialize(view)
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** GET /api/v1/gateways/:id/pairing */
  async pairing({ params, response, serialize }: HttpContext) {
    try {
      const gateway = await findGateway(Number(params.id))
      return serialize({ pairing: pairingView(gateway) })
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** POST /api/v1/gateways/:id/pairing {currentPassword} */
  async startPairing({ params, request, response, auth, serialize }: HttpContext) {
    const { currentPassword } = await request.validateUsing(pairingStartValidator)
    try {
      const pairing = await startPairing(Number(params.id), auth.getUserOrFail(), currentPassword)
      return serialize({ pairing })
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** POST /api/v1/gateways/:id/pairing/confirm {code} */
  async confirmPairing({ params, request, response, auth, serialize }: HttpContext) {
    const { code } = await request.validateUsing(pairingConfirmValidator)
    try {
      const pairing = await confirmPairing(Number(params.id), auth.getUserOrFail(), code)
      return serialize({ pairing })
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** DELETE /api/v1/gateways/:id/pairing */
  async unpair({ params, response, auth, serialize }: HttpContext) {
    try {
      await unpair(Number(params.id), auth.getUserOrFail())
      return serialize({ pairing: null })
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** GET /api/v1/gateways/:id/applies?state=&limit=&before= */
  async applies({ params, request, response, serialize }: HttpContext) {
    const input = await pagingValidator.validate(request.qs())
    const page = paging(input)
    try {
      const gateway = await findGateway(Number(params.id))
      const query = GatewayApply.query()
        .where('gateway_id', gateway.id)
        .orderBy('id', 'desc')
        .limit(page.limit)
      if (page.before) query.where('id', '<', page.before)
      if (input.state) query.where('state', input.state)
      const rows = await query
      return serialize({
        items: await applyViews(rows),
        nextBefore: rows.length === page.limit ? Number(rows[rows.length - 1].id) : null,
      })
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** GET /api/v1/gateways/:id/applies/:applyId */
  async apply({ params, response, serialize }: HttpContext) {
    try {
      const gateway = await findGateway(Number(params.id))
      const apply = await findApply(gateway.id, params.applyId)
      return serialize(await applyViewOf(apply, { changes: true }))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** POST /api/v1/gateways/:id/applies/:applyId/confirm ("Keep changes") */
  async confirmApply({ params, response, auth, serialize }: HttpContext) {
    try {
      const apply = await adminConfirm(Number(params.id), params.applyId, auth.getUserOrFail().id)
      return serialize(await applyViewOf(apply))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** POST /api/v1/gateways/:id/applies/:applyId/revert */
  async revertApply({ params, response, auth, serialize }: HttpContext) {
    try {
      const apply = await revertApply(Number(params.id), params.applyId, auth.getUserOrFail().id)
      return serialize(await applyViewOf(apply))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** GET /api/v1/gateways/:id/revisions?limit=&before= */
  async revisions({ params, request, response, serialize }: HttpContext) {
    const page = paging(await pagingValidator.validate(request.qs()))
    try {
      const gateway = await findGateway(Number(params.id))
      const query = GatewayRevision.query()
        .where('gateway_id', gateway.id)
        .orderBy('number', 'desc')
        .limit(page.limit)
      if (page.before) query.where('number', '<', page.before)
      const rows = await query
      const users = await userRefs(rows.map((r) => r.authorUserId))
      const keys = await applyKeysFor(rows.map((r) => r.applyId))
      return serialize({
        items: rows.map((r) => revisionView(r, users, keys)),
        nextBefore: rows.length === page.limit ? rows[rows.length - 1].number : null,
      })
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** GET /api/v1/gateways/:id/revisions/:number */
  async revision({ params, request, response, serialize }: HttpContext) {
    try {
      const gateway = await findGateway(Number(params.id))
      const row = await GatewayRevision.query()
        .where('gateway_id', gateway.id)
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
      return serialize(revisionView(row, users, keys, { diff: true, snapshot }))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** POST /api/v1/gateways/:id/revisions/:number/restore */
  async restoreRevision({ params, response, auth, serialize }: HttpContext) {
    try {
      const gatewayId = Number(params.id)
      const perchIds = await restoreRevision(
        gatewayId,
        auth.getUserOrFail().id,
        Number(params.number)
      )
      const gateway = await findGateway(gatewayId)
      const { states } = await loadSections(gateway.id)
      const plan = planApply({
        sections: states,
        perchIds,
        kind: 'apply',
        ledger: gateway.observedLedger ?? [],
        hashes: gateway.observedHashes ?? {},
        management: gateway.managementPath,
        registry: domainRegistry(),
        orders: plannedOrders(await loadOrders(gateway.id), 'apply'),
      })
      return serialize({ perchIds, changes: plan.jobs.flatMap((j) => j.changes) })
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** POST /api/v1/gateways/:id/rejoin/dismiss */
  async dismissRejoin({ params, response, auth, serialize }: HttpContext) {
    try {
      const gateway = await dismissRejoin(Number(params.id), auth.getUserOrFail().id)
      const [view] = await gatewayViews([gateway], await getGatewayConfigSettings())
      return serialize(view)
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** POST /api/v1/gateways/:id/drift/accept {perchIds?} */
  async acceptDrift({ params, request, response, auth, serialize }: HttpContext) {
    const { perchIds } = await request.validateUsing(perchIdsValidator)
    try {
      const ids = await acceptDriftSections(Number(params.id), auth.getUserOrFail().id, perchIds)
      return serialize({ accepted: ids })
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** POST /api/v1/gateways/:id/drift/revert-now {perchIds?} */
  async revertDrift({ params, request, response, auth, serialize }: HttpContext) {
    const { perchIds } = await request.validateUsing(perchIdsValidator)
    try {
      const apply = await revertDriftNow(Number(params.id), auth.getUserOrFail().id, perchIds)
      response.status(202)
      return serialize(await applyViewOf(apply))
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** POST /api/v1/gateways/:id/enforcement/resume */
  async resumeEnforcement({ params, response, auth, serialize }: HttpContext) {
    try {
      const gateway = await resumeEnforcement(Number(params.id), auth.getUserOrFail().id)
      const [view] = await gatewayViews([gateway], await getGatewayConfigSettings())
      return serialize(view)
    } catch (error) {
      return planeRefusal(response, error)
    }
  }

  /** GET /api/v1/gateways/:id/events?limit=&before= */
  async events({ params, request, response, serialize }: HttpContext) {
    const page = paging(await pagingValidator.validate(request.qs()))
    try {
      const gateway = await findGateway(Number(params.id))
      const query = GatewayConfigEvent.query()
        .where('gateway_id', gateway.id)
        .orderBy('id', 'desc')
        .limit(page.limit)
      if (page.before) query.where('id', '<', page.before)
      const rows = await query
      const users = await userRefs(rows.map((r) => r.userId))
      const keys = await applyKeysFor(rows.map((r) => r.applyId))
      return serialize({
        items: rows.map((r) => eventView(r, users, keys)),
        nextBefore: rows.length === page.limit ? Number(rows[rows.length - 1].id) : null,
      })
    } catch (error) {
      return planeRefusal(response, error)
    }
  }
}
