import AgentArtefact from '#models/agent_artefact'
import { checkArtefactToken, downloadKey } from '#services/agent_updates/download_tokens'
import { fetchArtefact } from '#services/agent_updates/github'
import { absoluteStorePath, storedFileSize } from '#services/agent_updates/store'
import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'
import { createReadStream } from 'node:fs'

/**
 * Downloading more than this many files at once for one device key answers
 * 429 (protocol.md section 2: one concurrent download per device). Entries
 * leave when their response closes, so the set holds at most one per device.
 */
const activeDownloads = new Set<string>()

/**
 * GET /api/v1/agent-updates/files/:artefactId/:file?d=&exp=&sig=
 * (agent-updates protocol.md section 2): the only way agents fetch artefacts.
 * No session auth: the short-lived HMAC in the URL is the capability. Whole
 * file (200) or one `Range: bytes=N-` (206), `If-Range` on the SHA-256 ETag,
 * 416 past the end.
 */
export default class AgentArtefactsController {
  async download({ params, request, response }: HttpContext) {
    const artefactId = Number(params.artefactId)
    const file = String(params.file)
    const query = request.qs()
    const check = checkArtefactToken(await downloadKey(), {
      artefactId,
      file,
      d: query.d,
      exp: query.exp,
      sig: query.sig,
    })
    if (!check.ok) {
      return response.forbidden({
        error: check.error,
        message:
          check.error === 'expired'
            ? 'This download link has expired.'
            : 'This download link is not valid.',
      })
    }

    const artefact = await AgentArtefact.find(artefactId)
    if (!artefact || artefact.fileName !== file) {
      return response.notFound({ error: 'artefact_not_found', message: 'No such artefact.' })
    }
    const size = await storedFileSize(artefact)
    if (size === null || size !== artefact.sizeBytes) {
      // Fetch-on-demand: a GitHub artefact starts downloading now; the agent retries.
      if (artefact.sourceUrl) {
        fetchArtefact(artefact).catch((error) =>
          logger.warn({ artefactId, err: error }, 'agent_updates: on-demand artefact fetch failed')
        )
      }
      response.header('Retry-After', '10')
      return response.notFound({
        error: 'artefact_not_stored',
        message: 'This artefact is not on the controller yet.',
      })
    }

    const deviceKey = String(query.d)
    if (activeDownloads.has(deviceKey)) {
      response.header('Retry-After', '5')
      return response.tooManyRequests({
        error: 'busy',
        message: 'This device is already downloading a file.',
      })
    }

    const etag = `"sha256:${artefact.sha256}"`
    let start = 0
    let end = size - 1
    let partial = false
    const range = request.header('range')
    const ifRange = request.header('if-range')
    if (range && (!ifRange || ifRange === etag)) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range.trim())
      if (match) {
        start = Number(match[1])
        if (match[2] !== '') end = Math.min(Number(match[2]), size - 1)
        if (start >= size || start > end) {
          response.header('Content-Range', `bytes */${size}`)
          return response.status(416).send({
            error: 'range_not_satisfiable',
            message: `The file is ${size} bytes.`,
          })
        }
        partial = true
      }
    }

    response.header('Accept-Ranges', 'bytes')
    response.header('ETag', etag)
    response.header('Content-Type', 'application/octet-stream')
    response.header('Cache-Control', 'no-store')
    response.header('Content-Length', String(end - start + 1))
    if (partial) {
      response.status(206)
      response.header('Content-Range', `bytes ${start}-${end}/${size}`)
    } else {
      response.status(200)
    }

    activeDownloads.add(deviceKey)
    response.response.once('close', () => activeDownloads.delete(deviceKey))
    const stream = createReadStream(absoluteStorePath(artefact.storedPath!), { start, end })
    return response.stream(stream)
  }
}
