import AgentArtefact from '#models/agent_artefact'
import AgentRelease from '#models/agent_release'
import { keyLabel, trustedKeys } from '#services/agent_updates/keys'
import {
  ManifestError,
  parseManifest,
  type AgentProduct,
  type ReleaseManifest,
} from '#services/agent_updates/manifest'
import type { AgentUpdateSettings } from '#services/agent_updates/settings'
import { verifySignature } from '#services/agent_updates/signify'
import { compareVersions, versionSortKey } from '#services/agent_updates/versions'
import { perchVersions } from '#services/perch_version'
import db from '@adonisjs/lucid/services/db'
import { createHash } from 'node:crypto'
import { DateTime } from 'luxon'

/**
 * Importing signed releases into `agent_releases` / `agent_artefacts` (from an
 * owner upload or the GitHub mirror) and the release views of the REST API
 * (agent-updates controller.md sections 7 and 9.1).
 *
 * Import order: the signature against the trusted keys (protocol.md 1.3 rule
 * 1), then the manifest schema. Only a release that passes both is stored.
 * The same manifest bytes again are a no-op; different bytes for a known
 * (product, version) are refused.
 */

export type ReleaseImportErrorCode =
  | 'unknown_key'
  | 'bad_signature'
  | 'manifest_invalid'
  | 'release_exists_different'
  | 'product_mismatch'
  | 'version_mismatch'

export class ReleaseImportError extends Error {
  constructor(
    readonly code: ReleaseImportErrorCode,
    message: string,
    readonly extra: {
      keyId?: string | null
      detail?: string
      product?: string
      version?: string
    } = {}
  ) {
    super(message)
    this.name = 'ReleaseImportError'
  }
}

export type ImportInput = {
  manifestBytes: Buffer
  signature: string
  source: 'github' | 'upload'
  userId?: number | null
  githubReleaseId?: number | null
  /** GitHub asset download URLs by file name (source_url of each artefact). */
  assetUrls?: Map<string, string>
  /** GitHub: the release must be this product and version (from the repo and tag). */
  expect?: { product: AgentProduct; version: string }
}

export type ImportResult = { release: AgentRelease; created: boolean; manifest: ReleaseManifest }

/** Checks and stores a signed release. Throws `ReleaseImportError`. */
export async function importRelease(
  input: ImportInput,
  settings: AgentUpdateSettings
): Promise<ImportResult> {
  const verified = verifySignature(input.manifestBytes, input.signature, trustedKeys(settings))
  if (!verified.ok) {
    throw new ReleaseImportError(
      verified.error,
      verified.error === 'unknown_key'
        ? `The manifest is signed with key ${verified.keyId}, which this controller does not trust.`
        : 'The signature does not match the manifest.',
      { keyId: verified.keyId }
    )
  }

  let manifest: ReleaseManifest
  try {
    // Stored as text and handed to agents as those bytes again: only UTF-8
    // survives that round trip byte for byte.
    if (!Buffer.from(input.manifestBytes.toString('utf8'), 'utf8').equals(input.manifestBytes)) {
      throw new ManifestError('not UTF-8')
    }
    manifest = parseManifest(input.manifestBytes)
  } catch (error) {
    const detail = error instanceof ManifestError ? error.detail : String(error)
    throw new ReleaseImportError('manifest_invalid', `The manifest is invalid: ${detail}.`, {
      keyId: verified.keyId,
      detail,
    })
  }
  if (input.expect && manifest.product !== input.expect.product) {
    throw new ReleaseImportError('product_mismatch', 'The manifest names another product.', {
      keyId: verified.keyId,
      product: manifest.product,
      version: manifest.version,
    })
  }
  if (input.expect && manifest.version !== input.expect.version) {
    throw new ReleaseImportError('version_mismatch', 'The manifest version is not the tag.', {
      keyId: verified.keyId,
      product: manifest.product,
      version: manifest.version,
    })
  }

  const manifestSha256 = createHash('sha256').update(input.manifestBytes).digest('hex')
  const existing = await AgentRelease.query()
    .where('product', manifest.product)
    .where('version', manifest.version)
    .first()
  if (existing) {
    if (existing.manifestSha256 === manifestSha256) {
      if (input.githubReleaseId && existing.githubReleaseId === null) {
        existing.githubReleaseId = input.githubReleaseId
        await existing.save()
      }
      return { release: existing, created: false, manifest }
    }
    throw new ReleaseImportError(
      'release_exists_different',
      `${manifest.product} ${manifest.version} is already known with a different manifest.`,
      { keyId: verified.keyId, product: manifest.product, version: manifest.version }
    )
  }

  const release = await db.transaction(async (trx) => {
    const row = new AgentRelease()
    row.product = manifest.product
    row.version = manifest.version
    row.versionSort = versionSortKey(manifest.version)
    row.channel = manifest.channel
    row.source = input.source
    row.manifest = input.manifestBytes.toString('utf8')
    row.manifestSha256 = manifestSha256
    row.signature = input.signature
    row.keyId = verified.keyId
    row.minVersion = manifest.minVersion
    row.minFromVersion = manifest.minFromVersion
    row.minControllerVersion = manifest.minControllerVersion
    const releasedAt = manifest.releasedAt ? DateTime.fromISO(manifest.releasedAt) : null
    row.releasedAt = releasedAt && releasedAt.isValid ? releasedAt.toUTC() : null
    row.notesUrl = manifest.notesUrl
    row.githubReleaseId = input.githubReleaseId ?? null
    row.importedAt = DateTime.utc()
    row.importedByUserId = input.userId ?? null
    row.withdrawnAt = null
    row.withdrawnByUserId = null
    row.useTransaction(trx)
    await row.save()

    for (const entry of manifest.artefacts) {
      const artefact = new AgentArtefact()
      artefact.releaseId = row.id
      artefact.fileName = entry.file
      artefact.kind = entry.kind
      artefact.arch = entry.kind === 'binary' ? entry.arch : null
      artefact.variant = entry.kind === 'binary' ? entry.variant : null
      artefact.manager = entry.kind === 'package' ? entry.manager : null
      artefact.openwrtSeries = entry.kind === 'package' ? entry.openwrt : null
      artefact.pkgArch = entry.kind === 'package' ? entry.pkgArch : null
      artefact.packageName = entry.kind === 'package' ? entry.package : null
      artefact.packageVersion = entry.kind === 'package' ? entry.packageVersion : null
      artefact.sizeBytes = entry.size
      artefact.gzipBytes = entry.kind === 'binary' ? entry.gzipSize : null
      artefact.sha256 = entry.sha256
      artefact.sourceUrl = input.assetUrls?.get(entry.file)?.slice(0, 1000) ?? null
      artefact.storedPath = null
      artefact.storedAt = null
      artefact.useTransaction(trx)
      await artefact.save()
    }
    return row
  })

  return { release, created: true, manifest }
}

/** The parsed manifest of a stored release (it was validated on import). */
export function releaseManifest(release: AgentRelease): ReleaseManifest {
  return parseManifest(release.manifest)
}

export type NotOfferableReason = 'withdrawn' | 'controller_too_old'

/** Why a release must not be offered to any device, or null. */
export function notOfferableReason(
  release: Pick<AgentRelease, 'withdrawnAt' | 'minControllerVersion'>
): NotOfferableReason | null {
  if (release.withdrawnAt) return 'withdrawn'
  if (
    release.minControllerVersion &&
    compareVersions(perchVersions().version, release.minControllerVersion) < 0
  ) {
    return 'controller_too_old'
  }
  return null
}

export type AgentArtefactView = {
  id: number
  file: string
  kind: 'binary' | 'package' | 'files'
  arch: string | null
  variant: string | null
  manager: 'opkg' | 'apk' | null
  openwrtSeries: string | null
  pkgArch: string | null
  sizeBytes: number
  sha256: string
  stored: boolean
}

export function artefactView(artefact: AgentArtefact): AgentArtefactView {
  return {
    id: artefact.id,
    file: artefact.fileName,
    kind: artefact.kind,
    arch: artefact.arch,
    variant: artefact.variant,
    manager: artefact.manager,
    openwrtSeries: artefact.openwrtSeries,
    pkgArch: artefact.pkgArch,
    sizeBytes: artefact.sizeBytes,
    sha256: artefact.sha256,
    stored: artefact.storedPath !== null,
  }
}

export type AgentReleaseView = {
  id: number
  product: AgentProduct
  version: string
  channel: 'stable' | 'pre' | 'local'
  source: 'github' | 'upload'
  keyId: string
  keyLabel: string | null
  minVersion: string | null
  minFromVersion: string | null
  minControllerVersion: string | null
  releasedAt: string | null
  importedAt: string
  notesUrl: string | null
  withdrawnAt: string | null
  artefacts: AgentArtefactView[]
  devicesOn: number
  devicesEligible: number
  offerable: boolean
  notOfferableReason: NotOfferableReason | null
}

export type ReleaseDeviceCounts = Map<number, { on: number; eligible: number }>

export function releaseView(
  release: AgentRelease,
  artefacts: AgentArtefact[],
  settings: AgentUpdateSettings,
  counts?: ReleaseDeviceCounts
): AgentReleaseView {
  const reason = notOfferableReason(release)
  const count = counts?.get(release.id)
  return {
    id: release.id,
    product: release.product,
    version: release.version,
    channel: release.channel,
    source: release.source,
    keyId: release.keyId,
    keyLabel: keyLabel(release.keyId, settings),
    minVersion: release.minVersion,
    minFromVersion: release.minFromVersion,
    minControllerVersion: release.minControllerVersion,
    releasedAt: release.releasedAt?.toISO() ?? null,
    importedAt: release.importedAt.toISO()!,
    notesUrl: release.notesUrl,
    withdrawnAt: release.withdrawnAt?.toISO() ?? null,
    artefacts: artefacts
      .filter((artefact) => artefact.releaseId === release.id)
      .sort((a, b) => a.id - b.id)
      .map(artefactView),
    devicesOn: count?.on ?? 0,
    devicesEligible: count?.eligible ?? 0,
    offerable: reason === null,
    notOfferableReason: reason,
  }
}

/** Releases newest first per product (perch-apd, then perch-collector). */
export async function listReleases(
  options: { product?: AgentProduct; includeWithdrawn?: boolean } = {}
): Promise<{ releases: AgentRelease[]; artefacts: AgentArtefact[] }> {
  const query = AgentRelease.query()
  if (options.product) query.where('product', options.product)
  if (!options.includeWithdrawn) query.whereNull('withdrawn_at')
  const rows = await query
  const releases = rows.sort(
    (a, b) => a.product.localeCompare(b.product) || compareVersions(b.version, a.version)
  )
  const ids = releases.map((release) => release.id)
  const artefacts =
    ids.length === 0 ? [] : await AgentArtefact.query().whereIn('release_id', ids).orderBy('id')
  return { releases, artefacts }
}

/** Versions the fleet reports running, per product (agent rows and adopted collectors). */
export async function runningVersions(): Promise<Record<AgentProduct, string[]>> {
  const aps = await db
    .from('wifi_access_points')
    .whereNotNull('agent_id')
    .whereNotNull('agent_version')
    .select('agent_version')
  const collectors = await db
    .from('collectors')
    .where('lifecycle', 'adopted')
    .whereNotNull('version')
    .select('version')
  return {
    'perch-apd': aps.map((row: { agent_version: string }) => row.agent_version),
    'perch-collector': collectors.map((row: { version: string }) => row.version),
  }
}

/** How many devices run each release (`devicesOn`); `devicesEligible` comes from the fleet. */
export async function releaseDeviceCounts(
  releases: AgentRelease[],
  eligible: Map<number, number> = new Map()
): Promise<ReleaseDeviceCounts> {
  const counts: ReleaseDeviceCounts = new Map()
  if (releases.length === 0) return counts
  const running = await runningVersions()
  for (const release of releases) {
    counts.set(release.id, {
      on: running[release.product].filter((version) => version === release.version).length,
      eligible: eligible.get(release.id) ?? 0,
    })
  }
  return counts
}
