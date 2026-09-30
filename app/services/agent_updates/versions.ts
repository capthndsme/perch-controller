/**
 * Version order of Perch daemon releases (agent-updates protocol.md 1.4).
 *
 * Semantic Versioning 2.0 precedence on `MAJOR.MINOR.PATCH[-PRERELEASE]`,
 * build metadata (`+…`) ignored. Pre-release identifiers compare per SemVer:
 * numeric below alphanumeric, numbers by value, text in ASCII order, and a
 * shorter list below a longer one it prefixes. `dev` or anything else that
 * does not parse is **unknown** and sorts below every version (a device
 * running `dev` accepts any target at or above its floor).
 *
 * The kit (`perch-agentkit/update/version.go`) implements the same order; both
 * suites run the shared vectors in `tests/fixtures/agent_updates/versions.json`.
 */

export type ParsedVersion = {
  major: number
  minor: number
  patch: number
  /** Pre-release identifiers; numbers are numeric identifiers. Empty = a release. */
  pre: Array<string | number>
}

const VERSION_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

/** Longest version string accepted anywhere (the columns are varchar(64)). */
export const MAX_VERSION_LENGTH = 64

/** Parses a release version (`1.2.0`, `1.1.0-pre.5`); null when it is not one. */
export function parseVersion(value: unknown): ParsedVersion | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_VERSION_LENGTH) {
    return null
  }
  const match = VERSION_REGEX.exec(value)
  if (!match) return null
  const numbers = [match[1], match[2], match[3]].map(Number)
  if (numbers.some((n) => !Number.isSafeInteger(n))) return null
  const pre = match[4] ? match[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : []
  if (pre.some((id) => typeof id === 'number' && !Number.isSafeInteger(id))) return null
  return { major: numbers[0], minor: numbers[1], patch: numbers[2], pre }
}

export function isValidVersion(value: unknown): value is string {
  return parseVersion(value) !== null
}

export function isPrerelease(value: string): boolean {
  const parsed = parseVersion(value)
  return parsed !== null && parsed.pre.length > 0
}

function compareIdentifiers(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return Math.sign(a - b)
  if (typeof a === 'number') return -1
  if (typeof b === 'number') return 1
  return a < b ? -1 : a > b ? 1 : 0
}

function compareParsed(a: ParsedVersion, b: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return Math.sign(a[key] - b[key])
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const length = Math.min(a.pre.length, b.pre.length)
  for (let i = 0; i < length; i++) {
    const order = compareIdentifiers(a.pre[i], b.pre[i])
    if (order !== 0) return order
  }
  return Math.sign(a.pre.length - b.pre.length)
}

/**
 * -1, 0 or 1. Unknown versions (null, `dev`, garbage) are below every known
 * version and equal to each other.
 */
export function compareVersions(
  a: string | null | undefined,
  b: string | null | undefined
): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left && !right) return 0
  if (!left) return -1
  if (!right) return 1
  return compareParsed(left, right)
}

/** Newest first. */
export function sortVersionsDescending<T>(items: T[], versionOf: (item: T) => string): T[] {
  return [...items].sort((a, b) => compareVersions(versionOf(b), versionOf(a)))
}

const PAD = 10

function pad(value: number): string {
  return String(Math.min(value, 9_999_999_999)).padStart(PAD, '0')
}

/**
 * A string whose binary order is the version order, for `agent_releases.
 * version_sort` (a `utf8mb4_bin` column, so ORDER BY compares bytes):
 * zero-padded numbers, a release marked `~` above its pre-releases (`-`),
 * numeric identifiers (`0…`) below alphanumeric ones (`1…`), joined with `!`
 * (below every character an identifier may hold). Unknown versions give ''.
 * Final ordering in code always goes through `compareVersions`.
 */
export function versionSortKey(value: string): string {
  const parsed = parseVersion(value)
  if (!parsed) return ''
  const core = `${pad(parsed.major)}.${pad(parsed.minor)}.${pad(parsed.patch)}`
  if (parsed.pre.length === 0) return `${core}~`
  const ids = parsed.pre.map((id) => (typeof id === 'number' ? `0${pad(id)}` : `1${id}`))
  return `${core}-${ids.join('!')}`.slice(0, 96)
}

/**
 * A package database version as the release version it stands for: the
 * `-rN` package release is dropped, then `~rc2` (opkg) or `_rc2` (apk)
 * becomes `-rc.2`. `1.0.0~rc2-r1` and `1.0.0_rc2-r1` are both `1.0.0-rc.2`.
 * Null when the result is not a version.
 */
export function normalisePackageVersion(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const withoutRelease = value.trim().replace(/-r\d+$/, '')
  const normalised = withoutRelease.replace(/[~_](alpha|beta|pre|rc)(\d+)$/, '-$1.$2')
  return isValidVersion(normalised) ? normalised : null
}
