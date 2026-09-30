import AgentArtefact from '#models/agent_artefact'
import type AgentRelease from '#models/agent_release'
import SystemSetting from '#models/system_setting'
import type { AgentProduct } from '#services/agent_updates/manifest'
import { importRelease } from '#services/agent_updates/releases'
import {
  AGENT_UPDATE_SETTINGS_KEY,
  getAgentUpdateSettings,
  type AgentUpdateSettings,
} from '#services/agent_updates/settings'
import { setStoreRootForTesting, storeArtefactStream } from '#services/agent_updates/store'
import app from '@adonisjs/core/services/app'
import type { ApiClient, ApiRequest } from '@japa/api-client'
import { createHash, createPrivateKey, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'

/**
 * Test side of agent updates: the test-only signify key in
 * `tests/fixtures/agent_updates/signify/` (never trusted outside tests; it is
 * not in `RELEASE_KEYS`), manifests signed with it, and a scratch artefact
 * store.
 */

export const FIXTURES_DIR = app.makePath('tests/fixtures/agent_updates')

export function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURES_DIR, name))
}

/** The test public key file (two lines). */
export const TEST_PUBLIC_KEY = fixture('signify/test.pub').toString('utf8')
export const TEST_KEY_LINE = TEST_PUBLIC_KEY.trim().split('\n')[1]
export const TEST_KEY_ID = Buffer.from(TEST_KEY_LINE, 'base64').subarray(2, 10).toString('hex')

const seed = Buffer.from(fixture('signify/test.seed').toString('utf8').trim(), 'hex')
const publicRaw = Buffer.from(TEST_KEY_LINE, 'base64').subarray(10)
const privateKey = createPrivateKey({
  key: {
    kty: 'OKP',
    crv: 'Ed25519',
    d: seed.toString('base64url'),
    x: publicRaw.toString('base64url'),
  },
  format: 'jwk',
})

/** A detached signify signature file over `bytes`, made with the test key. */
export function signWithTestKey(bytes: Buffer): string {
  const keynum = Buffer.from(TEST_KEY_LINE, 'base64').subarray(2, 10)
  const signature = sign(null, bytes, privateKey)
  const line = Buffer.concat([Buffer.from('Ed'), keynum, signature]).toString('base64')
  return `untrusted comment: verify with test.pub\n${line}\n`
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Deterministic fake contents of an artefact. */
export function artefactBytes(product: string, version: string, file: string): Buffer {
  return Buffer.from(`${product} ${version} ${file}\n`.repeat(40))
}

export type TestArtefact =
  | { file: string; kind: 'binary'; arch: string; variant?: string }
  | {
      file: string
      kind: 'package'
      manager: 'opkg' | 'apk'
      openwrt: string
      pkgArch: string
      package?: string
    }
  | { file: string; kind: 'files'; paths: string[] }

export type BuiltManifest = {
  bytes: Buffer
  signature: string
  files: Map<string, Buffer>
  manifest: Record<string, unknown>
}

const DEFAULT_ARTEFACTS: Record<AgentProduct, TestArtefact[]> = {
  'perch-apd': [
    { file: 'perch-apd-linux-mipsle', kind: 'binary', arch: 'mipsle' },
    { file: 'perch-apd-linux-arm64', kind: 'binary', arch: 'arm64' },
  ],
  'perch-collector': [
    {
      file: 'perch-collector-linux-amd64-ndpi',
      kind: 'binary',
      arch: 'amd64',
      variant: 'ndpi-static',
    },
  ],
}

/** A signed `perch-release/1` manifest with fake artefacts. */
export function buildManifest(
  options: {
    product?: AgentProduct
    version?: string
    channel?: 'stable' | 'pre' | 'local'
    minVersion?: string | null
    minFromVersion?: string | null
    minControllerVersion?: string | null
    artefacts?: TestArtefact[]
    extra?: Record<string, unknown>
  } = {}
): BuiltManifest {
  const product = options.product ?? 'perch-apd'
  const version = options.version ?? '1.2.0'
  const files = new Map<string, Buffer>()
  const artefacts = (options.artefacts ?? DEFAULT_ARTEFACTS[product]).map((entry) => {
    const bytes = artefactBytes(product, version, entry.file)
    files.set(entry.file, bytes)
    const base = { file: entry.file, size: bytes.length, sha256: sha256(bytes) }
    if (entry.kind === 'binary') {
      return {
        ...base,
        kind: 'binary',
        arch: entry.arch,
        ...(entry.variant ? { variant: entry.variant } : {}),
        gzipSize: Math.ceil(bytes.length / 10),
      }
    }
    if (entry.kind === 'package') {
      const pkg = entry.package ?? product
      const payload = artefactBytes(product, version, 'payload')
      return {
        ...base,
        kind: 'package',
        manager: entry.manager,
        openwrt: entry.openwrt,
        pkgArch: entry.pkgArch,
        package: pkg,
        packageVersion: `${version.replace(/-(alpha|beta|pre|rc)\.(\d+)$/, entry.manager === 'opkg' ? '~$1$2' : '_$1$2')}-r1`,
        ...(pkg === product
          ? { payloadPath: `/usr/bin/${product}`, payloadSha256: sha256(payload) }
          : {}),
      }
    }
    return {
      ...base,
      kind: 'files',
      members: entry.paths.map((path, i) => ({
        name: `member${i}`,
        path,
        mode: '0755',
        sha256: sha256(Buffer.from(path)),
        installKinds: ['swapped', 'unowned', 'manual'],
        when: 'always',
      })),
    }
  })
  const manifest: Record<string, unknown> = {
    schema: 'perch-release/1',
    product,
    version,
    channel: options.channel ?? (/-/.test(version) ? 'pre' : 'stable'),
    releasedAt: '2026-10-20T09:00:00Z',
    commit: '1e4605b',
    minVersion: options.minVersion ?? null,
    minFromVersion: options.minFromVersion ?? null,
    minControllerVersion: options.minControllerVersion ?? null,
    notesUrl: `https://github.com/capthndsme/${product}/releases/tag/v${version}`,
    artefacts,
    ...options.extra,
  }
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
  return { bytes, signature: signWithTestKey(bytes), files, manifest }
}

/** Stores settings with the test key trusted (plus any overrides). */
export async function trustTestKey(
  overrides: Partial<AgentUpdateSettings> = {}
): Promise<AgentUpdateSettings> {
  await SystemSetting.set(AGENT_UPDATE_SETTINGS_KEY, {
    extraTrustedKeys: [TEST_PUBLIC_KEY],
    ...overrides,
  })
  return getAgentUpdateSettings()
}

/** Imports a signed release; with `store`, puts its artefacts in the store too. */
export async function seedRelease(
  options: Parameters<typeof buildManifest>[0] & {
    store?: boolean
    source?: 'github' | 'upload'
  } = {}
): Promise<{ release: AgentRelease; built: BuiltManifest; artefacts: AgentArtefact[] }> {
  const built = buildManifest(options)
  const settings = await getAgentUpdateSettings()
  const { release } = await importRelease(
    { manifestBytes: built.bytes, signature: built.signature, source: options.source ?? 'upload' },
    settings
  )
  const artefacts = await AgentArtefact.query().where('release_id', release.id).orderBy('id')
  if (options.store) {
    for (const artefact of artefacts) {
      await storeArtefactStream(
        release,
        artefact,
        Readable.from([built.files.get(artefact.fileName)!])
      )
    }
  }
  return { release, built, artefacts }
}

/** A throwaway artefact store for one test; returns its cleanup. */
export async function useScratchStore(): Promise<() => Promise<void>> {
  const root = await mkdtemp(join(app.tmpPath(), 'agent-artefacts-test-'))
  setStoreRootForTesting(root)
  return async () => {
    setStoreRootForTesting(null)
    await rm(root, { recursive: true, force: true })
  }
}

/** An `update` status block (protocol.md section 3) as a self-updating agent reports it. */
export function updateBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: 1,
    enabled: true,
    refusal: null,
    keyIds: [TEST_KEY_ID],
    floor: null,
    installKind: 'swapped',
    methods: ['binary'],
    binaryPath: '/usr/bin/perch-apd',
    binarySha256: 'a'.repeat(64),
    packageManager: 'apk',
    packageVersion: '1.0.0_rc2-r1',
    openwrt: { release: '25.12.4', series: '25.12', pkgArch: 'mipsel_24kc' },
    arch: 'mipsle',
    variant: null,
    flash: { path: '/overlay', fsType: 'jffs2', freeBytes: 4308992, totalBytes: 8060928 },
    ram: { memAvailableBytes: 28561408, tmpFreeBytes: 58912768 },
    guard: 'missing',
    previous: null,
    active: null,
    results: [],
    ...overrides,
  }
}

/** A preflight answer (protocol.md 4.2). */
export function preflightAnswer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    problems: [],
    method: 'binary',
    installKind: 'swapped',
    rollbackStore: 'flash',
    staging: 'ram',
    downloadBytes: 1560,
    flash: {
      path: '/overlay',
      fsType: 'jffs2',
      freeBytes: 4308992,
      needBytes: 3719977,
      reserveBytes: 524288,
      estimate: 'gzip_x1.15',
      hardlink: true,
    },
    ram: {
      memAvailableBytes: 28561408,
      tmpFreeBytes: 58912768,
      needBytes: 20910273,
      reserveBytes: 12582912,
    },
    busy: null,
    ...overrides,
  }
}

type UntypedRequest = ApiRequest<any, any, any>
type UntypedClient = Record<
  'get' | 'post' | 'patch' | 'put' | 'delete',
  (url: string) => UntypedRequest
>

/**
 * The test client without the route registry's inferred types: bodies and
 * responses are plain JSON here, and inferring a body type for every path
 * across the ~300 registered routes makes the checker give up elsewhere
 * (other suites' `.json()` turned `never`).
 */
export function api(client: ApiClient): UntypedClient {
  return client as unknown as UntypedClient
}
