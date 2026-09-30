import type AgentArtefact from '#models/agent_artefact'
import type AgentRelease from '#models/agent_release'
import env from '#start/env'
import app from '@adonisjs/core/services/app'
import { createHash } from 'node:crypto'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { DateTime } from 'luxon'

/**
 * The artefact store (agent-updates controller.md section 3): files under
 * `${PERCH_DATA_DIR}/agent-artefacts` (the container's `/data` volume), else
 * `tmp/agent-artefacts`. Path `<product>/<version>/<file>`. A file is written
 * to `<file>.part`, its size and SHA-256 checked against the manifest while it
 * streams, fsynced and renamed; only then does the row get `stored_path`.
 * Nothing is cached in memory.
 */

export class StoreError extends Error {
  constructor(
    readonly code: 'too_large' | 'size_mismatch' | 'hash_mismatch' | 'path_invalid',
    message: string
  ) {
    super(message)
    this.name = 'StoreError'
  }
}

let rootOverride: string | null = null

export function storeRoot(): string {
  if (rootOverride) return rootOverride
  const dataDir = env.get('PERCH_DATA_DIR')
  return dataDir ? join(dataDir, 'agent-artefacts') : app.tmpPath('agent-artefacts')
}

/** Test-only: point the store somewhere else (null = back to the default). */
export function setStoreRootForTesting(path: string | null): void {
  rootOverride = path
}

const SEGMENT_REGEX = /^[A-Za-z0-9._+~-]{1,128}$/

export function relativeArtefactPath(product: string, version: string, fileName: string): string {
  for (const segment of [product, version, fileName]) {
    if (!SEGMENT_REGEX.test(segment) || segment === '.' || segment === '..') {
      throw new StoreError('path_invalid', `invalid path segment ${segment}`)
    }
  }
  return `${product}/${version}/${fileName}`
}

/** The absolute path of a stored file; refuses anything outside the root. */
export function absoluteStorePath(relativePath: string): string {
  const root = resolve(storeRoot())
  const full = resolve(root, relativePath)
  if (full !== root && !full.startsWith(root + sep)) {
    throw new StoreError('path_invalid', 'path escapes the store')
  }
  return full
}

/**
 * Streams `source` into the store as `artefact` of `release`, checking size
 * and hash against the row (which came from the verified manifest), then
 * marks the row stored. The `.part` file is removed on any failure.
 */
export async function storeArtefactStream(
  release: Pick<AgentRelease, 'product' | 'version'>,
  artefact: AgentArtefact,
  source: Readable
): Promise<AgentArtefact> {
  const relativePath = relativeArtefactPath(release.product, release.version, artefact.fileName)
  const target = absoluteStorePath(relativePath)
  const part = `${target}.part`
  await mkdir(dirname(target), { recursive: true })

  const hash = createHash('sha256')
  let written = 0
  const handle = await open(part, 'w', 0o644)
  try {
    for await (const chunk of source) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      written += buffer.length
      if (written > artefact.sizeBytes) {
        source.destroy()
        throw new StoreError(
          'too_large',
          `more than the manifest's ${artefact.sizeBytes} bytes for ${artefact.fileName}`
        )
      }
      hash.update(buffer)
      await handle.write(buffer)
    }
    if (written !== artefact.sizeBytes) {
      throw new StoreError(
        'size_mismatch',
        `${artefact.fileName} is ${written} bytes, the manifest says ${artefact.sizeBytes}`
      )
    }
    const digest = hash.digest('hex')
    if (digest !== artefact.sha256) {
      throw new StoreError('hash_mismatch', `${artefact.fileName} does not match its SHA-256`)
    }
    await handle.sync()
    await handle.close()
  } catch (error) {
    await handle.close().catch(() => {})
    await rm(part, { force: true })
    throw error
  }
  await rename(part, target)

  artefact.storedPath = relativePath
  artefact.storedAt = DateTime.utc()
  await artefact.save()
  return artefact
}

/** Size of the stored file, or null when the row says stored but the file is gone. */
export async function storedFileSize(artefact: AgentArtefact): Promise<number | null> {
  if (!artefact.storedPath) return null
  try {
    const info = await stat(absoluteStorePath(artefact.storedPath))
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

/** Deletes a stored file and clears the row's `stored_path` (the row stays). */
export async function deleteStoredArtefact(artefact: AgentArtefact): Promise<void> {
  if (artefact.storedPath) {
    await rm(absoluteStorePath(artefact.storedPath), { force: true })
  }
  artefact.storedPath = null
  artefact.storedAt = null
  await artefact.save()
}

/** Removes a release's directory (after its rows were deleted). */
export async function deleteReleaseDirectory(product: string, version: string): Promise<void> {
  const dir = absoluteStorePath(`${product}/${version}`)
  if (relative(resolve(storeRoot()), dir).split(sep).length !== 2) return
  await rm(dir, { recursive: true, force: true })
}
