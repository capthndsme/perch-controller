import Collector from '#models/collector'
import {
  announceSourceAddress,
  consumeAnnounceBudget,
  isAnnounceEnabled,
  recordAnnounce,
  setAnnounceEnabled,
} from '#services/collector_announce'
import { probeCollector } from '#services/collector_probe'
import {
  adoptCollector,
  countCollectorHistory,
  createCollector,
  deleteCollector,
  dismissCollector,
  findCollectorAtBaseUrl,
  listAdoptedCollectors,
  listCollectors,
  probeCollectorById,
  suggestCollectorName,
  updateCollector,
} from '#services/collector_registry'
import CollectorSummaryTransformer from '#transformers/collector_summary_transformer'
import CollectorTransformer from '#transformers/collector_transformer'
import {
  collectorAdoptValidator,
  collectorAnnounceValidator,
  collectorCreateValidator,
  collectorDiscoveryValidator,
  collectorProbeValidator,
  collectorUpdateValidator,
} from '#validators/collectors'
import type { HttpContext, HttpRequest } from '@adonisjs/core/http'

/**
 * Collector registry.
 *
 * `announce` is the one action outside `auth` and outside the
 * `requireSetupComplete` gate — a router that boots before the wizard has
 * been run must still be able to show up. `summary` is open to any signed-in
 * user and deliberately leaks no address. Everything else is mounted under
 * `/api/v1/settings` and is therefore
 * `auth + requirePasswordChange + requireAdmin`, so the role is never
 * re-checked here.
 */
export default class CollectorsController {
  /**
   * POST /api/v1/collectors/announce  (unauthenticated — see section 2.2)
   *
   * Creates or refreshes exactly one row and tells the daemon how long to
   * wait before announcing again. The address we would poll is derived from
   * the TCP source address, never from the announced `baseUrl`.
   */
  async announce({ request, response, serialize }: HttpContext) {
    // Budget first: this route is unauthenticated, so the cheapest possible
    // check has to come before anything that touches the database (the
    // feature switch is a SELECT) or runs a schema.
    const sourceAddress = announceSourceAddress(request.ip())
    const budget = consumeAnnounceBudget(sourceAddress)
    if (!budget.allowed) {
      response.header('Retry-After', String(budget.retryAfterSeconds))
      return response.tooManyRequests({
        error: 'announce_rate_limited',
        retryAfterSeconds: budget.retryAfterSeconds,
        message: 'Too many announces. Slow down and try again later.',
      })
    }

    if (!(await isAnnounceEnabled())) {
      return response.forbidden({
        error: 'announce_disabled',
        message: 'Collector self-announcement is switched off on this instance.',
      })
    }

    const payload = await request.validateUsing(collectorAnnounceValidator)
    const outcome = await recordAnnounce(payload, {
      sourceAddress,
      bearerToken: bearerTokenFrom(request),
      // A daemon announcing over HTTP is one the server polls (a socket
      // collector that went back to polling included).
      transport: 'poll',
    })

    if (outcome.status === 'rejected') {
      if (outcome.error === 'announce_key_mismatch') {
        return response.unauthorized({
          error: 'announce_key_mismatch',
          message: 'This instance id is already registered with a different API key.',
        })
      }
      return response.conflict({
        error: 'announce_pending_limit',
        message:
          'Too many collectors are already waiting for adoption. ' +
          'Adopt or dismiss some under Settings → Collectors first.',
      })
    }

    return serialize({
      status: outcome.lifecycle,
      collectorId: outcome.collectorId,
      announceIntervalSeconds: outcome.announceIntervalSeconds,
    })
  }

  /**
   * GET /api/v1/settings/collectors?includeDismissed=true
   */
  async index({ request, serialize }: HttpContext) {
    const includeDismissed = request.input('includeDismissed') === 'true'
    const rows = await listCollectors({ includeDismissed })
    return serialize(CollectorTransformer.transform(rows))
  }

  /**
   * GET /api/v1/settings/collectors/discovery
   *
   * State of the announce feature switch. Read straight from the system
   * setting on every call — the announce path does the same, so a change
   * needs no restart and no cache invalidation.
   */
  async discovery({ serialize }: HttpContext) {
    const announceEnabled = await isAnnounceEnabled()
    return serialize({ announceEnabled })
  }

  /**
   * PATCH /api/v1/settings/collectors/discovery
   *
   * Turning it off does not touch any existing row: already-adopted
   * collectors keep being polled, pending ones simply stop being refreshed.
   */
  async updateDiscovery({ request, serialize }: HttpContext) {
    const { announceEnabled } = await request.validateUsing(collectorDiscoveryValidator)
    await setAnnounceEnabled(announceEnabled)
    return serialize({ announceEnabled })
  }

  /**
   * POST /api/v1/settings/collectors
   *
   * Probes first, then persists with the result — a collector that is down
   * is still saved so the poller keeps retrying and the dashboard can show
   * why.
   */
  async store({ request, response, serialize }: HttpContext) {
    const payload = await request.validateUsing(collectorCreateValidator)

    const clash = await findCollectorAtBaseUrl(payload.baseUrl)
    if (clash) return baseUrlInUse(response, clash)

    const { collector, probe } = await createCollector(payload)
    // `serialize` is async, so the body has to be the returned promise
    // Adonis awaits — `response.created(serialize(...))` would send `{}`.
    response.status(201)
    return serialize({
      collector: CollectorTransformer.transform(collector),
      probe,
    })
  }

  /**
   * POST /api/v1/settings/collectors/probe
   *
   * Live "test this address" for the create form. Nothing is persisted.
   */
  async probeDraft({ request, serialize }: HttpContext) {
    const payload = await request.validateUsing(collectorProbeValidator)
    const probe = await probeCollector(payload.baseUrl, { apiKey: payload.apiKey ?? null })
    return serialize({
      probe,
      suggestedName: suggestCollectorName(payload.baseUrl, probe),
    })
  }

  /**
   * PUT /api/v1/settings/collectors/:id  (`?probe=false` to skip the re-probe)
   */
  async update({ params, request, response, serialize }: HttpContext) {
    const collector = await Collector.find(Number(params.id))
    if (!collector) return notFound(response, params.id)

    const payload = await request.validateUsing(collectorUpdateValidator)
    if (payload.baseUrl !== undefined) {
      const clash = await findCollectorAtBaseUrl(payload.baseUrl, collector.id)
      if (clash) return baseUrlInUse(response, clash)
    }

    const shouldProbe = request.input('probe') !== 'false'
    const {
      collector: updated,
      probe,
      warnings,
    } = await updateCollector(collector, payload, { probeAfterUpdate: shouldProbe })

    return serialize({
      collector: CollectorTransformer.transform(updated),
      probe,
      warnings,
    })
  }

  /**
   * DELETE /api/v1/settings/collectors/:id
   *
   * Refuses while the collector owns history: all fourteen child tables are
   * ON DELETE CASCADE and those tables *are* the database, so a bare delete
   * would hold one multi-minute transaction inside an HTTP request. Disable
   * keeps the charts; `node ace collectors:purge` does it in batches.
   */
  async destroy({ params, response }: HttpContext) {
    const collector = await Collector.find(Number(params.id))
    if (!collector) return notFound(response, params.id)

    const counts = await countCollectorHistory(collector.id)
    if (counts.hasData) {
      return response.conflict({
        error: 'collector_has_history',
        message:
          `Collector ${collector.id} has recorded data ` +
          `(${counts.bucketRows} traffic buckets, ${counts.identityRows} device identities). ` +
          `Disable it to stop polling and keep the history, or purge it with ` +
          `\`node ace collectors:purge --id=${collector.id}\`.`,
        bucketRows: counts.bucketRows,
        identityRows: counts.identityRows,
      })
    }

    await deleteCollector(collector)
    return response.noContent()
  }

  /**
   * POST /api/v1/settings/collectors/:id/probe
   */
  async probe({ params, response, serialize }: HttpContext) {
    const collector = await Collector.find(Number(params.id))
    if (!collector) return notFound(response, params.id)

    const probe = await probeCollectorById(collector)
    return serialize({
      collector: CollectorTransformer.transform(collector),
      probe,
    })
  }

  /**
   * POST /api/v1/settings/collectors/:id/adopt
   */
  async adopt({ params, request, response, serialize }: HttpContext) {
    const collector = await Collector.find(Number(params.id))
    if (!collector) return notFound(response, params.id)

    if (collector.lifecycle === 'adopted') {
      return response.unprocessableEntity({
        error: 'collector_not_pending',
        message: `Collector ${collector.id} is already adopted.`,
      })
    }

    const payload = await request.validateUsing(collectorAdoptValidator)
    const result = await adoptCollector(collector, payload)
    if (result.status === 'key_mismatch') {
      return response.unprocessableEntity({
        error: 'collector_api_key_mismatch',
        message:
          'The key you supplied does not match the fingerprint this collector announced. ' +
          'Re-send with "acceptKeyChange": true if that is intentional.',
      })
    }

    return serialize({
      collector: CollectorTransformer.transform(result.collector),
      probe: result.probe,
    })
  }

  /**
   * POST /api/v1/settings/collectors/:id/dismiss
   *
   * Allowed from any lifecycle: "stop talking to this thing" must always be
   * available.
   */
  async dismiss({ params, response, serialize }: HttpContext) {
    const collector = await Collector.find(Number(params.id))
    if (!collector) return notFound(response, params.id)

    const dismissed = await dismissCollector(collector)
    return serialize({
      collector: CollectorTransformer.transform(dismissed),
    })
  }

  /**
   * GET /api/v1/collectors
   *
   * Non-admin safe: no address, no key material, no status detail. An
   * operator needs this to populate a collector filter and nothing more.
   */
  async summary({ serialize }: HttpContext) {
    const rows = await listAdoptedCollectors()
    return serialize(CollectorSummaryTransformer.transform(rows))
  }
}

/** Shape copied from `settings_controller.ts`'s wifi-source 404. */
function notFound(response: HttpContext['response'], id: unknown) {
  return response.notFound({
    error: 'collector_not_found',
    message: `Collector ${id} does not exist.`,
  })
}

/**
 * Two rows pointing at one daemon would double-write every bucket under two
 * `collector_id`s and double every cross-collector aggregate, so an address
 * collision is refused rather than merged.
 */
function baseUrlInUse(response: HttpContext['response'], clash: Collector) {
  return response.unprocessableEntity({
    error: 'collector_base_url_in_use',
    message: `Collector ${clash.id} (${clash.name}) is already registered at that address.`,
  })
}

/**
 * The `Authorization: Bearer …` value, if the collector sent one. A daemon
 * that dislikes keys in bodies can authenticate its re-announces with the
 * header alone.
 */
function bearerTokenFrom(request: HttpRequest): string | null {
  const header = request.header('authorization')
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : null
}
