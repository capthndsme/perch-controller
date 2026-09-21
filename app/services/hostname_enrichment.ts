import {
  getHostnameEnrichmentSettings,
  type HostnameEnrichmentSettings,
} from '#services/hostname_enrichment_settings'
import logger from '@adonisjs/core/services/logger'
import { spawn } from 'node:child_process'

export type HostnameSource = 'dhcp_lease' | 'openwrt_static'

export type HostnameMatch = {
  hostname: string
  source: HostnameSource
}

type HostnameMaps = {
  byMac: Map<string, HostnameMatch>
  byIp: Map<string, HostnameMatch>
}

type HostnameState = HostnameMaps & {
  fetchedAtMs: number
}

type HostnameIdentity = {
  mac: string
  primaryIp: string | null
  ips: string[]
}

type HostnameCommandRunner = (
  settings: HostnameEnrichmentSettings,
  command: string[],
  timeoutMs: number
) => Promise<string>

let stateCache: HostnameState | null = null
let inFlightRefresh: Promise<HostnameState> | null = null
let commandRunner: HostnameCommandRunner = runHostnameCommand

function emptyState(): HostnameState {
  return {
    fetchedAtMs: Date.now(),
    byMac: new Map(),
    byIp: new Map(),
  }
}

function normalizeHostname(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = raw.trim().replace(/^['"]|['"]$/g, '')
  if (!cleaned || cleaned === '*') return null
  return cleaned
}

function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = raw.trim()
  return cleaned.length > 0 ? cleaned : null
}

function normalizeMac(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = raw.trim().toLowerCase().replace(/-/g, ':')
  const match = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(cleaned)
  return match ? cleaned : null
}

type ParsedHostnameEntry = {
  hostname: string
  source: HostnameSource
  mac?: string
  ip?: string
}

function upsertMaps(maps: HostnameMaps, entry: ParsedHostnameEntry, overwrite: boolean) {
  if (entry.mac) {
    if (overwrite || !maps.byMac.has(entry.mac)) {
      maps.byMac.set(entry.mac, { hostname: entry.hostname, source: entry.source })
    }
  }

  if (entry.ip) {
    if (overwrite || !maps.byIp.has(entry.ip)) {
      maps.byIp.set(entry.ip, { hostname: entry.hostname, source: entry.source })
    }
  }
}

export function parseDhcpLeases(raw: string): ParsedHostnameEntry[] {
  if (!raw.trim()) return []

  const out: ParsedHostnameEntry[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const parts = trimmed.split(/\s+/)
    if (parts.length < 4) continue

    const mac = normalizeMac(parts[1])
    const ip = normalizeIp(parts[2])
    const hostname = normalizeHostname(parts[3])
    if (!hostname) continue

    out.push({
      hostname,
      source: 'dhcp_lease',
      ...(mac ? { mac } : {}),
      ...(ip ? { ip } : {}),
    })
  }

  return out
}

function unwrapUciValue(raw: string): string {
  const trimmed = raw.trim()
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function parseOpenWrtStaticHosts(raw: string): ParsedHostnameEntry[] {
  if (!raw.trim()) return []

  type Section = {
    type?: string
    name?: string
    mac?: string
    ip?: string
  }

  const sections = new Map<string, Section>()

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const idx = trimmed.indexOf('=')
    if (idx === -1) continue

    const left = trimmed.slice(0, idx).trim()
    const right = unwrapUciValue(trimmed.slice(idx + 1))

    const match = /^dhcp\.([^.=]+(?:\[\d+\])?)(?:\.(\w+))?$/.exec(left)
    if (!match) continue

    const sectionId = match[1]
    const field = match[2]
    const section = sections.get(sectionId) ?? {}

    if (!field) {
      section.type = right
    } else if (field === 'name') {
      section.name = right
    } else if (field === 'mac') {
      section.mac = right
    } else if (field === 'ip') {
      section.ip = right
    }

    sections.set(sectionId, section)
  }

  const out: ParsedHostnameEntry[] = []
  for (const section of sections.values()) {
    if (section.type !== 'host') continue
    const hostname = normalizeHostname(section.name)
    if (!hostname) continue

    const ip = normalizeIp(section.ip)
    const macs = (section.mac ?? '')
      .split(/[,\s]+/)
      .map((part) => normalizeMac(part))
      .filter((mac): mac is string => Boolean(mac))

    if (macs.length === 0 && !ip) continue

    if (macs.length === 0) {
      out.push({
        hostname,
        source: 'openwrt_static',
        ...(ip ? { ip } : {}),
      })
      continue
    }

    for (const mac of macs) {
      out.push({
        hostname,
        source: 'openwrt_static',
        mac,
        ...(ip ? { ip } : {}),
      })
    }
  }

  return out
}

function sshArgs(
  settings: Extract<HostnameEnrichmentSettings, { transport: 'ssh' }>,
  command: string[]
) {
  const args = [
    '-p',
    String(settings.ssh.port),
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${Math.max(1, Math.ceil(settings.timeoutMs / 1000))}`,
  ]

  if (settings.ssh.privateKeyPath) {
    args.push('-i', settings.ssh.privateKeyPath)
  }

  args.push(`${settings.ssh.username}@${settings.ssh.host}`, ...command)
  return args
}

function runProcess(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })

    let done = false
    let timedOut = false
    let stdout = ''
    let stderr = ''

    const finish = (error: Error | null, output?: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (error) return reject(error)
      return resolve(output ?? '')
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    child.on('error', (error) => finish(error))
    child.on('close', (code, signal) => {
      if (timedOut) {
        return finish(new Error(`Command timed out after ${timeoutMs}ms`))
      }

      if (code !== 0) {
        const reason =
          stderr.trim() || `exit code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`
        return finish(new Error(reason))
      }

      return finish(null, stdout)
    })
  })
}

async function runHostnameCommand(
  settings: HostnameEnrichmentSettings,
  command: string[],
  timeoutMs: number
): Promise<string> {
  if (settings.transport === 'lxc') {
    return runProcess('lxc', ['exec', settings.lxc.containerName, '--', ...command], timeoutMs)
  }

  return runProcess('ssh', sshArgs(settings, command), timeoutMs)
}

async function loadHostnameState(settings: HostnameEnrichmentSettings): Promise<HostnameState> {
  if (!settings.enabled) {
    const empty = emptyState()
    stateCache = empty
    return empty
  }

  const maps: HostnameMaps = { byMac: new Map(), byIp: new Map() }
  const timeoutMs = settings.timeoutMs

  const [leaseRaw, staticRaw] = await Promise.all([
    commandRunner(settings, ['cat', settings.leaseFilePath], timeoutMs).catch((error) => {
      logger.warn(
        {
          err: error,
          transport: settings.transport,
        },
        'hostname_enrichment: failed to fetch DHCP lease file'
      )
      return ''
    }),
    commandRunner(settings, ['uci', 'show', 'dhcp'], timeoutMs).catch((error) => {
      logger.debug(
        {
          err: error,
          transport: settings.transport,
        },
        'hostname_enrichment: failed to fetch OpenWrt static host config'
      )
      return ''
    }),
  ])

  for (const entry of parseDhcpLeases(leaseRaw)) {
    upsertMaps(maps, entry, false)
  }
  for (const entry of parseOpenWrtStaticHosts(staticRaw)) {
    // Static leases are user-defined and should override dynamic labels.
    upsertMaps(maps, entry, true)
  }

  const nextState: HostnameState = {
    fetchedAtMs: Date.now(),
    byMac: maps.byMac,
    byIp: maps.byIp,
  }
  stateCache = nextState
  return nextState
}

async function getHostnameState(): Promise<HostnameState> {
  const settings = await getHostnameEnrichmentSettings()
  if (!settings.enabled) return loadHostnameState(settings)

  const now = Date.now()
  const ttlMs = settings.refreshSeconds * 1000
  if (stateCache && now - stateCache.fetchedAtMs < ttlMs) {
    return stateCache
  }

  // Stale or cold: kick off (at most) one refresh in the background.
  if (!inFlightRefresh) {
    inFlightRefresh = loadHostnameState(settings).finally(() => {
      inFlightRefresh = null
    })
  }

  // Stale-while-revalidate: with any prior state, serve it immediately and
  // let the refresh finish in the background. Only the cold first load blocks
  // on the (possibly slow) lxc/ssh command — which is what made the first
  // request after each TTL window pay ~1.5 s while the rest were sub-50 ms.
  if (stateCache) {
    inFlightRefresh.catch(() => {})
    return stateCache
  }

  return inFlightRefresh
}

/** Pure mac/IP lookup of one identity against an already-loaded state. */
function matchHostname(state: HostnameState, identity: HostnameIdentity): HostnameMatch | null {
  const mac = normalizeMac(identity.mac)
  if (mac) {
    const byMac = state.byMac.get(mac)
    if (byMac) return byMac
  }

  const allIps = [identity.primaryIp, ...identity.ips]
    .map((ip) => normalizeIp(ip))
    .filter((ip): ip is string => Boolean(ip))

  for (const ip of allIps) {
    const byIp = state.byIp.get(ip)
    if (byIp) return byIp
  }

  return null
}

export async function getHostnameMatch(identity: HostnameIdentity): Promise<HostnameMatch | null> {
  return matchHostname(await getHostnameState(), identity)
}

/**
 * Batched form of `getHostnameMatch`: resolves the hostname state **once**
 * and matches every identity against it in memory, returned in input order.
 * Read paths that enrich a whole device list use this so N devices cost a
 * single state lookup instead of N (each of which re-reads settings from the
 * DB and could trigger the lxc/ssh refresh).
 */
export async function getHostnameMatches(
  identities: HostnameIdentity[]
): Promise<Array<HostnameMatch | null>> {
  const state = await getHostnameState()
  return identities.map((identity) => matchHostname(state, identity))
}

/**
 * Test hook: resets memoized lookup state between tests.
 */
export function resetHostnameEnrichmentCacheForTesting() {
  stateCache = null
  inFlightRefresh = null
}

/**
 * Test hook: swaps command execution with a deterministic fake.
 */
export function setHostnameCommandRunnerForTesting(runner: HostnameCommandRunner | null) {
  commandRunner = runner ?? runHostnameCommand
}
