import AgentArtefact from '#models/agent_artefact'
import AgentRelease from '#models/agent_release'
import SystemSetting from '#models/system_setting'
import { PRODUCTS, type AgentProduct } from '#services/agent_updates/manifest'
import {
  ReleaseImportError,
  importRelease,
  type ReleaseImportErrorCode,
} from '#services/agent_updates/releases'
import type { AgentUpdateSettings } from '#services/agent_updates/settings'
import { storeArtefactStream } from '#services/agent_updates/store'
import { perchVersions } from '#services/perch_version'
import logger from '@adonisjs/core/services/logger'
import { Readable } from 'node:stream'
import { DateTime } from 'luxon'

/**
 * The GitHub mirror (agent-updates controller.md section 7.1).
 *
 * Every `githubCheckIntervalHours` (the tick) and on "Check now": list the
 * last 30 releases of each daemon repository, and for each non-draft release
 * with `perch-manifest.json` + `perch-manifest.json.sig` fetch both, verify
 * and import. Artefacts are fetched only when a job needs them (or ahead of
 * time for the fleet's targets when `prefetch` is on), verified against the
 * manifest before they count as stored.
 *
 * Nothing here runs unless `githubCheck` is on or an admin pressed "Check
 * now". Tests replace `fetch` with `setGithubFetchForTesting` (no network).
 */

export const GITHUB_REPOSITORIES: Record<AgentProduct, string> = {
  'perch-apd': 'capthndsme/perch-apd',
  'perch-collector': 'capthndsme/perch-collector',
}
export const MANIFEST_ASSET = 'perch-manifest.json'
export const SIGNATURE_ASSET = 'perch-manifest.json.sig'
const GITHUB_STATE_KEY = 'agent_updates_github'
const API_TIMEOUT_MS = 20_000
const SMALL_ASSET_MAX_BYTES = 1024 * 1024
const ARTEFACT_TIMEOUT_MS = 5 * 60_000

type Fetch = typeof globalThis.fetch
let fetchImpl: Fetch | null = null

/** Test-only: every GitHub request goes through `fake` (null = the real fetch). */
export function setGithubFetchForTesting(fake: Fetch | null): void {
  fetchImpl = fake
}

/** True while a test replaced `fetch` (the tick never calls GitHub from a test otherwise). */
export function githubFetchIsFaked(): boolean {
  return fetchImpl !== null
}

function githubFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('User-Agent', `perch-controller/${perchVersions().version}`)
  return (fetchImpl ?? globalThis.fetch)(url, { ...init, headers, redirect: 'follow' })
}

export class GithubUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GithubUnreachableError'
  }
}

export type CheckFound = {
  product: AgentProduct
  version: string
  status: 'new' | 'known' | 'unsigned' | 'rejected'
  reason: string | null
}

export type RejectedRelease = {
  product: AgentProduct
  version: string
  reason: ReleaseImportErrorCode
  keyId: string | null
  detail: string | null
}

export type GithubCheckResult = {
  checkedAt: string
  found: CheckFound[]
  /** The rejected ones again, for the caller's events. */
  rejected: RejectedRelease[]
  /** Ids of newly imported releases. */
  imported: number[]
}

type GithubAsset = { name?: unknown; browser_download_url?: unknown; size?: unknown }
type GithubRelease = {
  id?: unknown
  tag_name?: unknown
  draft?: unknown
  assets?: unknown
}

export type GithubState = { lastCheckAt: string | null; lastError: string | null }

export async function githubState(): Promise<GithubState> {
  const stored = await SystemSetting.get<Partial<GithubState>>(GITHUB_STATE_KEY)
  return {
    lastCheckAt: typeof stored?.lastCheckAt === 'string' ? stored.lastCheckAt : null,
    lastError: typeof stored?.lastError === 'string' ? stored.lastError : null,
  }
}

async function readSmallAsset(url: string): Promise<Buffer> {
  const response = await githubFetch(url, {
    headers: { Accept: 'application/octet-stream' },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  const length = Number(response.headers.get('content-length') ?? '0')
  if (length > SMALL_ASSET_MAX_BYTES) throw new Error(`${url} is larger than 1 MiB`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > SMALL_ASSET_MAX_BYTES) throw new Error(`${url} is larger than 1 MiB`)
  return bytes
}

function assetsOf(release: GithubRelease): Map<string, string> {
  const map = new Map<string, string>()
  if (!Array.isArray(release.assets)) return map
  for (const asset of release.assets as GithubAsset[]) {
    if (typeof asset?.name === 'string' && typeof asset.browser_download_url === 'string') {
      map.set(asset.name, asset.browser_download_url)
    }
  }
  return map
}

async function listGithubReleases(product: AgentProduct): Promise<GithubRelease[]> {
  const url = `https://api.github.com/repos/${GITHUB_REPOSITORIES[product]}/releases?per_page=30`
  let response: Response
  try {
    response = await githubFetch(url, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    })
  } catch (error) {
    throw new GithubUnreachableError(
      `GitHub did not answer for ${product}: ${error instanceof Error ? error.message : error}`
    )
  }
  if (!response.ok) {
    throw new GithubUnreachableError(`GitHub answered HTTP ${response.status} for ${product}`)
  }
  const body = (await response.json()) as unknown
  if (!Array.isArray(body)) throw new GithubUnreachableError('GitHub answered an unexpected body')
  return body as GithubRelease[]
}

async function checkProduct(
  product: AgentProduct,
  settings: AgentUpdateSettings,
  result: GithubCheckResult
): Promise<void> {
  const releases = await listGithubReleases(product)
  for (const entry of releases) {
    if (entry.draft === true || typeof entry.tag_name !== 'string') continue
    const version = entry.tag_name.replace(/^v/, '')
    const githubId = typeof entry.id === 'number' ? entry.id : null
    const assets = assetsOf(entry)
    const manifestUrl = assets.get(MANIFEST_ASSET)
    if (!manifestUrl) continue // releases from before signed manifests
    const signatureUrl = assets.get(SIGNATURE_ASSET)
    if (!signatureUrl) {
      result.found.push({ product, version, status: 'unsigned', reason: 'no signature yet' })
      continue
    }

    const known = await AgentRelease.query()
      .where('product', product)
      .where('version', version)
      .first()
    if (known && githubId !== null && known.githubReleaseId === githubId) {
      result.found.push({ product, version, status: 'known', reason: null })
      continue
    }

    let manifestBytes: Buffer
    let signature: string
    try {
      manifestBytes = await readSmallAsset(manifestUrl)
      const signatureBytes = await readSmallAsset(signatureUrl)
      signature = signatureBytes.toString('utf8')
    } catch (error) {
      result.found.push({
        product,
        version,
        status: 'rejected',
        reason: `download failed: ${error instanceof Error ? error.message : error}`.slice(0, 200),
      })
      continue
    }

    try {
      const imported = await importRelease(
        {
          manifestBytes,
          signature,
          source: 'github',
          githubReleaseId: githubId,
          assetUrls: assets,
          expect: { product, version },
        },
        settings
      )
      if (imported.created) result.imported.push(imported.release.id)
      result.found.push({
        product,
        version,
        status: imported.created ? 'new' : 'known',
        reason: null,
      })
    } catch (error) {
      if (!(error instanceof ReleaseImportError)) throw error
      result.found.push({ product, version, status: 'rejected', reason: error.code })
      result.rejected.push({
        product,
        version,
        reason: error.code,
        keyId: error.extra.keyId ?? null,
        detail: error.extra.detail ?? null,
      })
    }
  }
}

/**
 * One check of both repositories. Throws `GithubUnreachableError` when a
 * repository could not be listed (releases of the other one found before
 * that are kept). The time and outcome are remembered for the fleet view and
 * the tick's schedule either way.
 */
export async function checkGithubReleases(
  settings: AgentUpdateSettings,
  now: DateTime = DateTime.utc()
): Promise<GithubCheckResult> {
  const result: GithubCheckResult = {
    checkedAt: now.toISO()!,
    found: [],
    rejected: [],
    imported: [],
  }
  let failure: GithubUnreachableError | null = null
  for (const product of PRODUCTS) {
    try {
      await checkProduct(product, settings, result)
    } catch (error) {
      if (!(error instanceof GithubUnreachableError)) throw error
      failure = error
    }
  }
  await SystemSetting.set<GithubState>(GITHUB_STATE_KEY, {
    lastCheckAt: result.checkedAt,
    lastError: failure?.message ?? null,
  })
  if (failure) throw failure
  return result
}

const inFlight = new Map<number, Promise<AgentArtefact>>()

/**
 * Fetches a GitHub artefact into the store (follows redirects, 64 MiB cap by
 * the manifest size, 5 minutes). Concurrent calls for one artefact share the
 * download. Throws when the artefact has no source URL or the file does not
 * match the manifest.
 */
export function fetchArtefact(artefact: AgentArtefact): Promise<AgentArtefact> {
  const running = inFlight.get(artefact.id)
  if (running) return running
  const job = (async () => {
    if (!artefact.sourceUrl) throw new Error(`${artefact.fileName} has no download source`)
    const release = await AgentRelease.findOrFail(artefact.releaseId)
    const response = await githubFetch(artefact.sourceUrl, {
      headers: { Accept: 'application/octet-stream' },
      signal: AbortSignal.timeout(ARTEFACT_TIMEOUT_MS),
    })
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} for ${artefact.fileName}`)
    }
    const fresh = await AgentArtefact.findOrFail(artefact.id)
    const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
    await storeArtefactStream(release, fresh, source)
    logger.info(
      { artefactId: fresh.id, file: fresh.fileName, version: release.version },
      'agent_updates: artefact fetched from GitHub'
    )
    return fresh
  })()
  inFlight.set(artefact.id, job)
  job
    .finally(() => inFlight.delete(artefact.id))
    .catch(() => {
      // The caller sees the rejection; this branch only keeps it from being unhandled.
    })
  return job
}

/** True while `fetchArtefact` runs for this artefact. */
export function isFetching(artefactId: number): boolean {
  return inFlight.has(artefactId)
}
