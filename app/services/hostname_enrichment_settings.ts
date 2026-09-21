import SystemSetting from '#models/system_setting'

export const HOSTNAME_ENRICHMENT_SETTING_KEY = 'hostname_enrichment'

export const HOSTNAME_ENRICHMENT_MODE = 'command_execution'
export type HostnameEnrichmentMode = typeof HOSTNAME_ENRICHMENT_MODE

export const HOSTNAME_ENRICHMENT_TRANSPORTS = ['lxc', 'ssh'] as const
export type HostnameEnrichmentTransport = (typeof HOSTNAME_ENRICHMENT_TRANSPORTS)[number]

export const HOSTNAME_ENRICHMENT_REFRESH_SECONDS_MIN = 5
export const HOSTNAME_ENRICHMENT_REFRESH_SECONDS_MAX = 3600
export const HOSTNAME_ENRICHMENT_TIMEOUT_MS_MIN = 500
export const HOSTNAME_ENRICHMENT_TIMEOUT_MS_MAX = 15000

export type HostnameEnrichmentLxcConfig = {
  containerName: string
}

export type HostnameEnrichmentSshConfig = {
  host: string
  port: number
  username: string
  privateKeyPath?: string
}

type HostnameEnrichmentBase = {
  enabled: boolean
  mode: HostnameEnrichmentMode
  transport: HostnameEnrichmentTransport
  leaseFilePath: string
  refreshSeconds: number
  timeoutMs: number
}

export type HostnameEnrichmentSettings =
  | (HostnameEnrichmentBase & {
      transport: 'lxc'
      lxc: HostnameEnrichmentLxcConfig
    })
  | (HostnameEnrichmentBase & {
      transport: 'ssh'
      ssh: HostnameEnrichmentSshConfig
    })

type UnknownObject = Record<string, unknown>

const DEFAULT_LEASE_FILE_PATH = '/tmp/dhcp.leases'
const DEFAULT_LXC_CONTAINER_NAME = 'openwrt'
const DEFAULT_REFRESH_SECONDS = 60
const DEFAULT_TIMEOUT_MS = 1500

const DEFAULT_SSH: HostnameEnrichmentSshConfig = {
  host: '127.0.0.1',
  port: 22,
  username: 'root',
}

function isObject(value: unknown): value is UnknownObject {
  return typeof value === 'object' && value !== null
}

function normalizeRequiredString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback
  if (value < min || value > max) return fallback
  return value
}

function normalizeTransport(value: unknown): HostnameEnrichmentTransport {
  return value === 'ssh' ? 'ssh' : 'lxc'
}

function normalizeLxcConfig(value: unknown): HostnameEnrichmentLxcConfig {
  if (!isObject(value)) {
    return { containerName: DEFAULT_LXC_CONTAINER_NAME }
  }

  return {
    containerName: normalizeRequiredString(value.containerName, DEFAULT_LXC_CONTAINER_NAME),
  }
}

function normalizeSshConfig(value: unknown): HostnameEnrichmentSshConfig {
  if (!isObject(value)) {
    return { ...DEFAULT_SSH }
  }

  return {
    host: normalizeRequiredString(value.host, DEFAULT_SSH.host),
    port: normalizeInteger(value.port, 1, 65535, DEFAULT_SSH.port),
    username: normalizeRequiredString(value.username, DEFAULT_SSH.username),
    privateKeyPath: normalizeOptionalString(value.privateKeyPath),
  }
}

export function defaultHostnameEnrichmentSettings(): HostnameEnrichmentSettings {
  return {
    enabled: false,
    mode: HOSTNAME_ENRICHMENT_MODE,
    transport: 'lxc',
    leaseFilePath: DEFAULT_LEASE_FILE_PATH,
    refreshSeconds: DEFAULT_REFRESH_SECONDS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    lxc: {
      containerName: DEFAULT_LXC_CONTAINER_NAME,
    },
  }
}

export function normalizeHostnameEnrichmentSettings(value: unknown): HostnameEnrichmentSettings {
  const defaults = defaultHostnameEnrichmentSettings()
  if (!isObject(value)) return defaults

  const transport = normalizeTransport(value.transport)
  const common: HostnameEnrichmentBase = {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : defaults.enabled,
    mode: HOSTNAME_ENRICHMENT_MODE,
    transport,
    leaseFilePath: normalizeRequiredString(value.leaseFilePath, defaults.leaseFilePath),
    refreshSeconds: normalizeInteger(
      value.refreshSeconds,
      HOSTNAME_ENRICHMENT_REFRESH_SECONDS_MIN,
      HOSTNAME_ENRICHMENT_REFRESH_SECONDS_MAX,
      defaults.refreshSeconds
    ),
    timeoutMs: normalizeInteger(
      value.timeoutMs,
      HOSTNAME_ENRICHMENT_TIMEOUT_MS_MIN,
      HOSTNAME_ENRICHMENT_TIMEOUT_MS_MAX,
      defaults.timeoutMs
    ),
  }

  if (transport === 'ssh') {
    return {
      ...common,
      transport: 'ssh',
      ssh: normalizeSshConfig(value.ssh),
    }
  }

  return {
    ...common,
    transport: 'lxc',
    lxc: normalizeLxcConfig(value.lxc),
  }
}

export async function getHostnameEnrichmentSettings(): Promise<HostnameEnrichmentSettings> {
  const stored = await SystemSetting.get<unknown>(HOSTNAME_ENRICHMENT_SETTING_KEY)
  return normalizeHostnameEnrichmentSettings(stored)
}

export async function setHostnameEnrichmentSettings(
  settings: HostnameEnrichmentSettings
): Promise<HostnameEnrichmentSettings> {
  const normalized = normalizeHostnameEnrichmentSettings(settings)
  await SystemSetting.set(HOSTNAME_ENRICHMENT_SETTING_KEY, normalized)
  return normalized
}
