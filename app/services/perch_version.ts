import { readFileSync } from 'node:fs'
import app from '@adonisjs/core/services/app'
import env from '#start/env'

/**
 * The controller's own version and the daemon versions it pairs with.
 *
 * - `version` is package.json's `version`, which the release commit sets to
 *   the tag without its `v` (`1.0.0-rc.2`). The build copies package.json, so
 *   the Docker image and the pm2 build read the same field.
 * - `apdVersion` / `collectorVersion` come from package.json's
 *   `perch.apdVersion` / `perch.collectorVersion`: the perch-apd and
 *   perch-collector releases this controller release was cut with. The
 *   dashboard's install commands download exactly those, so a controller
 *   never hands out an older daemon from `releases/latest` (a final release
 *   only; release candidates are pre-releases it never resolves to).
 *   `PERCH_APD_VERSION` / `PERCH_COLLECTOR_VERSION` override them at runtime;
 *   the value `latest` means GitHub's newest final release.
 *
 * Read once: package.json does not change under a running server.
 */

export type PerchVersions = {
  version: string
  apdVersion: string
  collectorVersion: string
}

let cached: PerchVersions | null = null

type PackageJson = {
  version?: unknown
  perch?: { apdVersion?: unknown; collectorVersion?: unknown }
}

function readPackageJson(): PackageJson {
  try {
    return JSON.parse(readFileSync(app.makePath('package.json'), 'utf8')) as PackageJson
  } catch {
    return {}
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/** A version as it appears in a tag: `1.0.0-rc.2` (a leading `v` is dropped), or `latest`. */
function normaliseDaemonVersion(value: string): string {
  return value === 'latest' ? value : value.replace(/^v/, '')
}

export function perchVersions(): PerchVersions {
  if (cached) return cached
  const pkg = readPackageJson()
  const version = stringOr(pkg.version, 'dev')
  cached = {
    version,
    apdVersion: normaliseDaemonVersion(
      stringOr(env.get('PERCH_APD_VERSION'), stringOr(pkg.perch?.apdVersion, version))
    ),
    collectorVersion: normaliseDaemonVersion(
      stringOr(env.get('PERCH_COLLECTOR_VERSION'), stringOr(pkg.perch?.collectorVersion, version))
    ),
  }
  return cached
}

/** Test-only: forget the cached read (tests change the env overrides). */
export function _resetPerchVersions(): void {
  cached = null
}

/**
 * GitHub download base for one release of a Perch repository:
 * `…/releases/download/v1.0.0-rc.2`, or `…/releases/latest/download` for `latest`.
 */
export function githubReleaseDownloadUrl(repository: string, version: string): string {
  const base = `https://github.com/capthndsme/${repository}/releases`
  return version === 'latest' ? `${base}/latest/download` : `${base}/download/v${version}`
}
