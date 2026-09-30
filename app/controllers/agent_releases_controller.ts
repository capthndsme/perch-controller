import AgentUpdateRollout, { OPEN_ROLLOUT_STATES } from '#models/agent_update_rollout'
import { pauseRolloutsOfRelease } from '#services/agent_updates/rollouts'
import AgentArtefact from '#models/agent_artefact'
import AgentRelease from '#models/agent_release'
import AgentUpdateJob from '#models/agent_update_job'
import { recordUpdateEvent } from '#services/agent_updates/events'
import { eligibleCounts } from '#services/agent_updates/fleet'
import { GithubUnreachableError, checkGithubReleases } from '#services/agent_updates/github'
import {
  ReleaseImportError,
  artefactView,
  importRelease,
  listReleases,
  releaseDeviceCounts,
  releaseView,
  runningVersions,
} from '#services/agent_updates/releases'
import { getAgentUpdateSettings } from '#services/agent_updates/settings'
import { afterGithubCheck, announceAvailable } from '#services/agent_updates/tick'
import {
  StoreError,
  deleteReleaseDirectory,
  storeArtefactStream,
} from '#services/agent_updates/store'
import {
  releaseCreateValidator,
  releaseUpdateValidator,
  releasesIndexValidator,
} from '#validators/agent_updates'
import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'

/** Largest artefact accepted by an upload (protocol.md 1.1: 64 MiB). */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024
/** Multipart framing on top of the file. */
const MULTIPART_OVERHEAD = 1024 * 1024

/**
 * Releases of the Perch daemons (agent-updates controller.md sections 7 and
 * 9.2, endpoints 5, 6 and 15-19): the list, owner uploads of local builds
 * (manifest + signature first, then one PUT per file), the GitHub check,
 * withdraw and delete. Reads for any signed-in user, writes admin only.
 */
export default class AgentReleasesController {
  /** GET /api/v1/agent-updates/releases */
  async index({ request, serialize }: HttpContext) {
    const query = await releasesIndexValidator.validate(request.qs())
    const settings = await getAgentUpdateSettings()
    const { releases, artefacts } = await listReleases({
      product: query.product,
      includeWithdrawn: query.includeWithdrawn ?? false,
    })
    const counts = await releaseDeviceCounts(releases, await eligibleCounts(settings))
    return serialize({
      releases: releases.map((release) => releaseView(release, artefacts, settings, counts)),
    })
  }

  /** GET /api/v1/agent-updates/releases/:id */
  async show({ params, response, serialize }: HttpContext) {
    const release = await AgentRelease.find(Number(params.id))
    if (!release) return releaseNotFound(response, params.id)
    const settings = await getAgentUpdateSettings()
    const artefacts = await AgentArtefact.query().where('release_id', release.id).orderBy('id')
    const counts = await releaseDeviceCounts([release], await eligibleCounts(settings))
    return serialize({
      ...releaseView(release, artefacts, settings, counts),
      manifest: JSON.parse(release.manifest) as unknown,
    })
  }

  /** POST /api/v1/agent-updates/releases/check */
  async check({ response, auth, serialize }: HttpContext) {
    const settings = await getAgentUpdateSettings()
    try {
      const result = await checkGithubReleases(settings)
      await afterGithubCheck(result, settings, auth.user?.id ?? null)
      return serialize({ checkedAt: result.checkedAt, found: result.found })
    } catch (error) {
      if (error instanceof GithubUnreachableError) {
        return response.status(502).send({ error: 'github_unreachable', message: error.message })
      }
      throw error
    }
  }

  /** POST /api/v1/agent-updates/releases (a local build: manifest + signature) */
  async store({ request, response, auth, serialize }: HttpContext) {
    const payload = await request.validateUsing(releaseCreateValidator)
    const manifestBytes = Buffer.from(payload.manifest.replace(/\s+/g, ''), 'base64')
    const settings = await getAgentUpdateSettings()
    const userId = auth.user?.id ?? null
    try {
      const { release, created } = await importRelease(
        { manifestBytes, signature: payload.signature, source: 'upload', userId },
        settings
      )
      if (created) {
        await recordUpdateEvent('release_imported', {
          releaseId: release.id,
          userId,
          detail: { product: release.product, version: release.version, source: 'upload' },
        })
        void announceAvailable(settings).catch(() => {})
      }
      const artefacts = await AgentArtefact.query().where('release_id', release.id).orderBy('id')
      const counts = await releaseDeviceCounts([release])
      response.status(created ? 201 : 200)
      return serialize(releaseView(release, artefacts, settings, counts))
    } catch (error) {
      if (!(error instanceof ReleaseImportError)) throw error
      if (error.code !== 'release_exists_different') {
        await recordUpdateEvent('agent_update.release_rejected', {
          userId,
          detail: {
            source: 'upload',
            product: error.extra.product ?? null,
            version: error.extra.version ?? null,
            reason: error.code,
            keyId: error.extra.keyId ?? null,
            detail: error.extra.detail ?? null,
          },
        })
      }
      if (error.code === 'release_exists_different') {
        return response.conflict({ error: error.code, message: error.message })
      }
      return response.unprocessableEntity({
        error:
          error.code === 'unknown_key' || error.code === 'bad_signature'
            ? error.code
            : 'manifest_invalid',
        message: error.message,
        ...(error.code === 'unknown_key' ? { keyId: error.extra.keyId } : {}),
        ...(error.code === 'manifest_invalid' ? { detail: error.extra.detail } : {}),
      })
    }
  }

  /** PUT /api/v1/agent-updates/releases/:id/files/:file (multipart, one part `file`) */
  async upload({ params, request, response, auth, serialize }: HttpContext) {
    const release = await AgentRelease.find(Number(params.id))
    if (!release) return releaseNotFound(response, params.id)
    const artefact = await AgentArtefact.query()
      .where('release_id', release.id)
      .where('file_name', String(params.file))
      .first()
    if (!artefact) {
      return response.notFound({
        error: 'artefact_not_in_manifest',
        message: `${params.file} is not listed in the manifest of ${release.product} ${release.version}.`,
      })
    }
    const declared = Number(request.header('content-length') ?? '0')
    if (declared > MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD) return tooLarge(response)
    if (!request.multipart) {
      return response.unprocessableEntity({
        error: 'file_missing',
        message: 'Send the artefact as multipart/form-data, part "file".',
      })
    }

    let stored: AgentArtefact | null = null
    let failure: unknown = null
    request.multipart.onFile('file', {}, async (part) => {
      try {
        stored = await storeArtefactStream(release, artefact, part)
      } catch (error) {
        failure = error
        part.resume()
      }
    })
    try {
      await request.multipart.process({ limit: MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD })
    } catch (error) {
      failure ??= error
    }

    if (failure instanceof StoreError) {
      if (failure.code === 'hash_mismatch' || failure.code === 'size_mismatch') {
        await recordUpdateEvent('agent_update.release_rejected', {
          releaseId: release.id,
          userId: auth.user?.id ?? null,
          detail: {
            source: 'upload',
            product: release.product,
            version: release.version,
            reason: failure.code,
            file: artefact.fileName,
          },
        })
      }
      if (failure.code === 'too_large') return tooLarge(response, failure.message)
      return response.unprocessableEntity({ error: failure.code, message: failure.message })
    }
    if (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      if (/limit|too large/i.test(message)) return tooLarge(response)
      throw failure
    }
    if (!stored) {
      return response.unprocessableEntity({
        error: 'file_missing',
        message: 'Send the artefact as the multipart part named "file".',
      })
    }
    return serialize(artefactView(stored))
  }

  /** PATCH /api/v1/agent-updates/releases/:id  {withdrawn} */
  async update({ params, request, response, auth, serialize }: HttpContext) {
    const release = await AgentRelease.find(Number(params.id))
    if (!release) return releaseNotFound(response, params.id)
    const payload = await request.validateUsing(releaseUpdateValidator)
    const wasWithdrawn = release.withdrawnAt !== null
    if (payload.withdrawn !== wasWithdrawn) {
      release.withdrawnAt = payload.withdrawn ? DateTime.utc() : null
      release.withdrawnByUserId = payload.withdrawn ? (auth.user?.id ?? null) : null
      await release.save()
      await recordUpdateEvent(payload.withdrawn ? 'release_withdrawn' : 'release_restored', {
        releaseId: release.id,
        userId: auth.user?.id ?? null,
        detail: { product: release.product, version: release.version },
      })
      // A withdrawn release stops its rollouts (resume once it is restored).
      if (payload.withdrawn) await pauseRolloutsOfRelease(release.id, auth.user?.id ?? null)
    }
    const settings = await getAgentUpdateSettings()
    const artefacts = await AgentArtefact.query().where('release_id', release.id).orderBy('id')
    const counts = await releaseDeviceCounts([release])
    return serialize(releaseView(release, artefacts, settings, counts))
  }

  /** DELETE /api/v1/agent-updates/releases/:id */
  async destroy({ params, response, auth }: HttpContext) {
    const release = await AgentRelease.find(Number(params.id))
    if (!release) return releaseNotFound(response, params.id)
    const running = await runningVersions()
    const openJobs = await AgentUpdateJob.query()
      .where('release_id', release.id)
      .whereNotNull('active_key')
    const openRollouts = await AgentUpdateRollout.query()
      .where('release_id', release.id)
      .whereIn('state', [...OPEN_ROLLOUT_STATES])
    const usage = {
      jobs: openJobs.length,
      rollouts: openRollouts.length,
      devices: running[release.product].filter((version) => version === release.version).length,
    }
    if (usage.jobs > 0 || usage.rollouts > 0 || usage.devices > 0) {
      return response.conflict({
        error: 'release_in_use',
        message: `${release.product} ${release.version} is still in use.`,
        ...usage,
      })
    }
    await recordUpdateEvent('release_deleted', {
      userId: auth.user?.id ?? null,
      detail: { product: release.product, version: release.version, releaseId: release.id },
    })
    await release.delete()
    await deleteReleaseDirectory(release.product, release.version)
    return response.noContent()
  }
}

function releaseNotFound(response: HttpContext['response'], id: unknown) {
  return response.notFound({ error: 'release_not_found', message: `Release ${id} does not exist.` })
}

function tooLarge(response: HttpContext['response'], message = 'Files are at most 64 MiB.') {
  return response.status(413).send({ error: 'too_large', message })
}
