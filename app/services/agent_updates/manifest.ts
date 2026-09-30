import { isPrerelease, isValidVersion } from '#services/agent_updates/versions'

/**
 * The signed release manifest, schema `perch-release/1` (agent-updates
 * protocol.md 1.1): one per (product, version), binding every artefact's
 * SHA-256, size and target. The controller stores the bytes exactly as
 * received and never re-serialises them; this module only reads them.
 */

export const MANIFEST_SCHEMA = 'perch-release/1'
/** The `update.protocol` a device needs to read this schema. */
export const MANIFEST_SCHEMA_VERSION = 1
export const MAX_MANIFEST_BYTES = 1024 * 1024
export const MAX_ARTEFACT_BYTES = 64 * 1024 * 1024

export const PRODUCTS = ['perch-apd', 'perch-collector'] as const
export type AgentProduct = (typeof PRODUCTS)[number]

export const RELEASE_ARCHES = ['amd64', 'arm64', 'armv7', 'armv5', 'mipsle', 'mips'] as const
export const PACKAGE_MANAGERS = ['opkg', 'apk'] as const
export type PackageManager = (typeof PACKAGE_MANAGERS)[number]
export const INSTALL_KINDS = ['package', 'swapped', 'unowned', 'manual', 'docker', 'other'] as const
export type InstallKind = (typeof INSTALL_KINDS)[number]

/** Packages a product's manifest may list (device.md section 10). */
export const PRODUCT_PACKAGES: Record<AgentProduct, readonly string[]> = {
  'perch-apd': ['perch-apd'],
  'perch-collector': ['perch-collector', 'perch-qos'],
}

/**
 * Where a `files` bundle may write, per product (device.md section 10). The
 * device enforces its own copy; the controller refuses a manifest that could
 * never install anywhere.
 */
export const FILES_ALLOWLIST: Record<AgentProduct, readonly string[]> = {
  'perch-apd': [
    '/etc/init.d/perch-apd',
    '/etc/init.d/perch-apd-guard',
    '/lib/upgrade/keep.d/perch-apd',
  ],
  'perch-collector': [
    '/etc/init.d/perch-collector',
    '/etc/init.d/perch-collector-guard',
    '/lib/upgrade/keep.d/perch-collector',
    '/etc/init.d/perch-qos',
    '/etc/hotplug.d/iface/40-perch-qos',
    '/etc/hotplug.d/ntp/40-perch-qos',
    '/lib/upgrade/keep.d/perch-qos',
  ],
}

export type FilesMember = {
  name: string
  path: string
  mode: '0644' | '0755'
  sha256: string
  installKinds: InstallKind[]
  when: 'always' | 'if-exists'
}

type ArtefactBase = { file: string; size: number; sha256: string }

export type BinaryArtefact = ArtefactBase & {
  kind: 'binary'
  arch: string
  variant: string | null
  gzipSize: number | null
}

export type PackageArtefact = ArtefactBase & {
  kind: 'package'
  manager: PackageManager
  openwrt: string
  pkgArch: string
  package: string
  packageVersion: string
  payloadPath: string | null
  payloadSha256: string | null
}

export type FilesArtefact = ArtefactBase & { kind: 'files'; members: FilesMember[] }

export type ManifestArtefact = BinaryArtefact | PackageArtefact | FilesArtefact

export type ReleaseManifest = {
  schema: typeof MANIFEST_SCHEMA
  product: AgentProduct
  version: string
  channel: 'stable' | 'pre' | 'local'
  releasedAt: string | null
  commit: string | null
  minVersion: string | null
  minFromVersion: string | null
  minControllerVersion: string | null
  notesUrl: string | null
  artefacts: ManifestArtefact[]
}

export class ManifestError extends Error {
  constructor(readonly detail: string) {
    super(`manifest_invalid: ${detail}`)
    this.name = 'ManifestError'
  }
}

const FILE_REGEX = /^[A-Za-z0-9._+~-]{1,128}$/
const MEMBER_NAME_REGEX = /^[A-Za-z0-9._-]{1,64}$/
const SHA256_REGEX = /^[0-9a-f]{64}$/
const COMMIT_REGEX = /^[0-9a-f]{7,40}$/
const SERIES_REGEX = /^\d{2}\.\d{2}$/
const PKG_ARCH_REGEX = /^[A-Za-z0-9_-]{1,48}$/
const VARIANT_REGEX = /^[a-z0-9-]{1,16}$/
const PACKAGE_VERSION_REGEX = /^[A-Za-z0-9.+~_-]{1,64}$/

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(detail: string): never {
  throw new ManifestError(detail)
}

function optionalString(
  value: unknown,
  field: string,
  check: (v: string) => boolean,
  max = 500
): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > max || !check(value)) fail(`${field} is invalid`)
  return value
}

function optionalVersion(value: unknown, field: string): string | null {
  return optionalString(value, field, isValidVersion, 64)
}

function size(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    fail(`${field} must be a positive whole number`)
  }
  if (value > MAX_ARTEFACT_BYTES) fail(`${field} exceeds 64 MiB`)
  return value
}

function sha(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256_REGEX.test(value)) {
    fail(`${field} must be 64 lowercase hex`)
  }
  return value
}

function parseMember(value: unknown, index: number, product: AgentProduct): FilesMember {
  const at = `members[${index}]`
  if (!isObject(value)) fail(`${at} is not an object`)
  if (typeof value.name !== 'string' || !MEMBER_NAME_REGEX.test(value.name)) {
    fail(`${at}.name is invalid`)
  }
  if (typeof value.path !== 'string' || !FILES_ALLOWLIST[product].includes(value.path)) {
    fail(`${at}.path is not on the ${product} allowlist`)
  }
  if (value.mode !== '0644' && value.mode !== '0755') fail(`${at}.mode must be 0644 or 0755`)
  if (
    !Array.isArray(value.installKinds) ||
    value.installKinds.length === 0 ||
    value.installKinds.some((kind) => !INSTALL_KINDS.includes(kind as InstallKind))
  ) {
    fail(`${at}.installKinds is invalid`)
  }
  if (value.when !== 'always' && value.when !== 'if-exists') {
    fail(`${at}.when must be always or if-exists`)
  }
  return {
    name: value.name,
    path: value.path,
    mode: value.mode,
    sha256: sha(value.sha256, `${at}.sha256`),
    installKinds: [...new Set(value.installKinds as InstallKind[])],
    when: value.when,
  }
}

function parseArtefact(value: unknown, index: number, product: AgentProduct): ManifestArtefact {
  const at = `artefacts[${index}]`
  if (!isObject(value)) fail(`${at} is not an object`)
  if (typeof value.file !== 'string' || !FILE_REGEX.test(value.file)) fail(`${at}.file is invalid`)
  const base: ArtefactBase = {
    file: value.file,
    size: size(value.size, `${at}.size`),
    sha256: sha(value.sha256, `${at}.sha256`),
  }
  switch (value.kind) {
    case 'binary': {
      if (!RELEASE_ARCHES.includes(value.arch as (typeof RELEASE_ARCHES)[number])) {
        fail(`${at}.arch is not a release arch`)
      }
      const variant = optionalString(value.variant, `${at}.variant`, (v) => VARIANT_REGEX.test(v))
      const gzipSize =
        value.gzipSize === undefined || value.gzipSize === null
          ? null
          : size(value.gzipSize, `${at}.gzipSize`)
      return { ...base, kind: 'binary', arch: value.arch as string, variant, gzipSize }
    }
    case 'package': {
      if (!PACKAGE_MANAGERS.includes(value.manager as PackageManager)) {
        fail(`${at}.manager must be opkg or apk`)
      }
      if (typeof value.openwrt !== 'string' || !SERIES_REGEX.test(value.openwrt)) {
        fail(`${at}.openwrt must be a series like 24.10`)
      }
      if (typeof value.pkgArch !== 'string' || !PKG_ARCH_REGEX.test(value.pkgArch)) {
        fail(`${at}.pkgArch is invalid`)
      }
      if (typeof value.package !== 'string' || !PRODUCT_PACKAGES[product].includes(value.package)) {
        fail(`${at}.package is not a ${product} package`)
      }
      if (
        typeof value.packageVersion !== 'string' ||
        !PACKAGE_VERSION_REGEX.test(value.packageVersion)
      ) {
        fail(`${at}.packageVersion is invalid`)
      }
      const isDaemon = value.package === product
      const payloadPath = optionalString(
        value.payloadPath,
        `${at}.payloadPath`,
        (v) => v.startsWith('/') && !v.includes('..'),
        200
      )
      const payloadSha256 =
        value.payloadSha256 === undefined || value.payloadSha256 === null
          ? null
          : sha(value.payloadSha256, `${at}.payloadSha256`)
      if (isDaemon && (payloadPath === null || payloadSha256 === null)) {
        fail(`${at} needs payloadPath and payloadSha256`)
      }
      return {
        ...base,
        kind: 'package',
        manager: value.manager as PackageManager,
        openwrt: value.openwrt,
        pkgArch: value.pkgArch,
        package: value.package,
        packageVersion: value.packageVersion,
        payloadPath,
        payloadSha256,
      }
    }
    case 'files': {
      if (!Array.isArray(value.members) || value.members.length === 0) {
        fail(`${at}.members must list at least one file`)
      }
      if (value.members.length > 64) fail(`${at}.members lists more than 64 files`)
      const members = value.members.map((member, i) => parseMember(member, i, product))
      const names = new Set(members.map((member) => member.name))
      if (names.size !== members.length) fail(`${at}.members has duplicate names`)
      return { ...base, kind: 'files', members }
    }
    default:
      return fail(`${at}.kind must be binary, package or files`)
  }
}

/** Parses and validates manifest bytes; throws `ManifestError` with a detail. */
export function parseManifest(bytes: Buffer | string): ReleaseManifest {
  const text = typeof bytes === 'string' ? bytes : bytes.toString('utf8')
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) fail('larger than 1 MiB')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    fail('not JSON')
  }
  if (!isObject(value)) fail('not a JSON object')
  if (value.schema !== MANIFEST_SCHEMA) fail(`schema must be ${MANIFEST_SCHEMA}`)
  if (!PRODUCTS.includes(value.product as AgentProduct)) fail('product is not a Perch daemon')
  const product = value.product as AgentProduct
  if (typeof value.version !== 'string' || !isValidVersion(value.version)) {
    fail('version is not a release version')
  }
  const version = value.version
  if (value.channel !== 'stable' && value.channel !== 'pre' && value.channel !== 'local') {
    fail('channel must be stable, pre or local')
  }
  if (value.channel === 'stable' && isPrerelease(version)) {
    fail('a stable release cannot have a pre-release version')
  }
  const releasedAt = optionalString(value.releasedAt, 'releasedAt', (v) =>
    Number.isFinite(Date.parse(v))
  )
  const commit = optionalString(value.commit, 'commit', (v) => COMMIT_REGEX.test(v))
  const notesUrl = optionalString(value.notesUrl, 'notesUrl', (v) => {
    try {
      return new URL(v).protocol === 'https:'
    } catch {
      return false
    }
  })
  if (!Array.isArray(value.artefacts) || value.artefacts.length === 0) {
    fail('artefacts must list at least one file')
  }
  if (value.artefacts.length > 64) fail('artefacts lists more than 64 files')
  const artefacts = value.artefacts.map((entry, i) => parseArtefact(entry, i, product))
  const files = new Set(artefacts.map((artefact) => artefact.file))
  if (files.size !== artefacts.length) fail('artefacts has duplicate file names')

  return {
    schema: MANIFEST_SCHEMA,
    product,
    version,
    channel: value.channel,
    releasedAt,
    commit,
    minVersion: optionalVersion(value.minVersion, 'minVersion'),
    minFromVersion: optionalVersion(value.minFromVersion, 'minFromVersion'),
    minControllerVersion: optionalVersion(value.minControllerVersion, 'minControllerVersion'),
    notesUrl,
    artefacts,
  }
}
