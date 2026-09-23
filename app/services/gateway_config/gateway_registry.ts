import type Collector from '#models/collector'
import Gateway from '#models/gateway'
import collectorHub from '#services/collector_agent_hub'
import {
  getGatewayConfigSettings,
  type GatewayConfigSettings,
} from '#services/gateway_config/gateway_config_settings'
import { parseSigning, type AgentSigning } from '#services/gateway_config/rpc_signing'
import {
  AGENT_ACCESS_LEVELS,
  GATEWAY_MODES,
  type AgentAccess,
  type GatewayCapabilities,
  type GatewayMode,
  type ManagementPath,
} from '#services/gateway_config/types'
import { DateTime } from 'luxon'

/**
 * Gateway rows and their live session context (docs/gateway/config-plane.md
 * sections 2, 4 and 11).
 *
 * - `ensureGateway`: one `gateways` row per adopted collector that is a
 *   gateway (`isGatewayCapability`, or gateway stats), created in mode `off`.
 * - The hello's `gatewayConfig` block (access, transportOk, hashes, the apply
 *   state, unacked results, the signing challenge) is session state, kept in
 *   memory per collector and dropped when the session ends. Bounded by the
 *   number of live collector sessions.
 * - `configureBlock`: the `gatewayConfig` part of `agent.configure`, cached
 *   per collector so the synchronous configure builder can add it.
 * - `writeAccess`: README 7.1: writes need verified TLS on both ends
 *   (`connection.secure === true` and the agent's `transportOk`), or both
 *   opt-ins (the `allowInsecureTransport` setting and the router's
 *   `config_allow_insecure '1'`) plus a pairing (owner decision 29), in
 *   which case the write RPCs are signed with the paired key.
 */

export const GATEWAY_CAPABILITY = 'gateway_config'

/**
 * Hello capabilities that make a collector a gateway (it runs on the
 * router): the config plane, gateway stats, or any observation part
 * (`observe.*`, `gateway.observe`, `gateway.backup`, `net.conntrack_flush`).
 * Every adopted such collector gets a `gateways` row, so observation-only
 * gateways have an id too (orchestrator decision 2026-09-23: `gateways.id`
 * is the canonical `:id` of every `/api/v1/gateways/:id/...` route).
 */
export function isGatewayCapability(capability: string): boolean {
  return (
    capability === GATEWAY_CAPABILITY ||
    capability === 'gateway_stats' ||
    capability === 'net.conntrack_flush' ||
    capability.startsWith('observe.') ||
    capability.startsWith('gateway.')
  )
}

/** The hello's `gatewayConfig` block (section 4), as far as it parses. */
export type HelloGatewayConfig = {
  protocol: number | null
  access: AgentAccess | null
  accessConfigured: AgentAccess | null
  transportOk: boolean | null
  hashes: Record<string, string>
  apply: HelloApplyState
  results: AgentApplyResult[]
  signing: AgentSigning | null
  /** README 3.8: how the agent reaches the controller (`ip route get`). */
  management: ManagementPath | null
}

export type HelloApplyState = {
  state: string
  applyId?: string
  kind?: string
  deadline?: string
  protected?: boolean
}

/** One outcome the agent reports (`gateway.config.result`, or the hello's `results`). */
export type AgentApplyResult = {
  applyId: string
  kind?: string
  outcome: 'confirmed' | 'rolled_back' | 'failed' | string
  reason?: string
  at?: string
  hashes?: Record<string, string>
  /** By config: the router's sections the rollback threw away (redacted like a read). */
  discarded?: Record<string, DiscardedSection[]>
  packages?: string[]
  detail?: string
}

export type DiscardedSection = {
  name: string
  type: string
  anonymous?: boolean
  index?: number
  options?: Record<string, string | string[]>
  secrets?: Record<string, string>
  change?: 'added' | 'changed' | 'removed' | string
}

export type GatewaySessionContext = {
  /** Increases per session of this process; identifies "a fresh session". */
  seq: number
  connectedAt: DateTime
  secure: boolean | null
  hello: HelloGatewayConfig
  /** The hello's `capabilities`. */
  capabilities: string[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringMap(value: unknown): Record<string, string> {
  if (!isObject(value)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' && k.length <= 64) out[k] = v.slice(0, 128)
  }
  return out
}

function access(value: unknown): AgentAccess | null {
  return (AGENT_ACCESS_LEVELS as readonly unknown[]).includes(value) ? (value as AgentAccess) : null
}

export function parseApplyResult(value: unknown): AgentApplyResult | null {
  if (!isObject(value) || typeof value.applyId !== 'string' || typeof value.outcome !== 'string') {
    return null
  }
  const discarded: Record<string, DiscardedSection[]> = {}
  if (isObject(value.discarded)) {
    for (const [config, list] of Object.entries(value.discarded)) {
      if (!Array.isArray(list)) continue
      discarded[config] = list
        .filter((s): s is Record<string, unknown> => isObject(s) && typeof s.name === 'string')
        .slice(0, 2000)
        .map((s) => ({
          name: String(s.name),
          type: typeof s.type === 'string' ? s.type : '',
          anonymous: s.anonymous === true,
          index: typeof s.index === 'number' ? s.index : undefined,
          options: isObject(s.options) ? (s.options as DiscardedSection['options']) : {},
          secrets: isObject(s.secrets) ? stringMap(s.secrets) : undefined,
          change: typeof s.change === 'string' ? s.change : undefined,
        }))
    }
  }
  return {
    applyId: value.applyId.slice(0, 64),
    kind: typeof value.kind === 'string' ? value.kind : undefined,
    outcome: value.outcome,
    reason: typeof value.reason === 'string' ? value.reason : undefined,
    at: typeof value.at === 'string' ? value.at : undefined,
    hashes: stringMap(value.hashes),
    discarded: Object.keys(discarded).length > 0 ? discarded : undefined,
    packages: Array.isArray(value.packages)
      ? value.packages.filter((p): p is string => typeof p === 'string').slice(0, 64)
      : undefined,
    detail: typeof value.detail === 'string' ? value.detail.slice(0, 1000) : undefined,
  }
}

/** A hello/capabilities `management` block (README 3.8), or null. */
export function parseManagementPath(value: unknown): ManagementPath | null {
  if (!isObject(value) || typeof value.device !== 'string' || value.device.length === 0) {
    return null
  }
  return {
    network: typeof value.network === 'string' ? value.network.slice(0, 32) : null,
    device: value.device.slice(0, 32),
    controllerAddress:
      typeof value.controllerAddress === 'string'
        ? value.controllerAddress.slice(0, 64)
        : undefined,
    reportedAt:
      typeof value.reportedAt === 'string'
        ? value.reportedAt.slice(0, 40)
        : new Date().toISOString(),
  }
}

/** Parses the hello's `gatewayConfig` block; tolerant of older and newer agents. */
export function parseHelloGatewayConfig(value: unknown): HelloGatewayConfig | null {
  if (!isObject(value)) return null
  const apply: HelloApplyState = { state: 'idle' }
  if (isObject(value.apply) && typeof value.apply.state === 'string') {
    apply.state = value.apply.state
    if (typeof value.apply.applyId === 'string') apply.applyId = value.apply.applyId
    if (typeof value.apply.kind === 'string') apply.kind = value.apply.kind
    if (typeof value.apply.deadline === 'string') apply.deadline = value.apply.deadline
    if (typeof value.apply.protected === 'boolean') apply.protected = value.apply.protected
  }
  return {
    protocol: typeof value.protocol === 'number' ? value.protocol : null,
    access: access(value.access),
    accessConfigured: access(value.accessConfigured),
    transportOk: typeof value.transportOk === 'boolean' ? value.transportOk : null,
    hashes: stringMap(value.hashes),
    apply,
    results: Array.isArray(value.results)
      ? value.results
          .slice(0, 64)
          .map(parseApplyResult)
          .filter((r): r is AgentApplyResult => r !== null)
      : [],
    signing: parseSigning(value.signing),
    management: parseManagementPath(value.management),
  }
}

// ── session context ──────────────────────────────────────────────────────

const sessions = new Map<number, GatewaySessionContext>()
let sessionSeq = 0

export function rememberGatewaySession(
  collectorId: number,
  hello: HelloGatewayConfig,
  info: { connectedAt: DateTime; secure: boolean | null; capabilities?: string[] }
): GatewaySessionContext {
  const context: GatewaySessionContext = {
    seq: ++sessionSeq,
    connectedAt: info.connectedAt,
    secure: info.secure,
    hello,
    capabilities: info.capabilities ?? [],
  }
  sessions.set(collectorId, context)
  return context
}

/** The collector's live session context, when it is online with the plane. */
export function gatewaySession(collectorId: number | null): GatewaySessionContext | null {
  if (collectorId === null) return null
  const context = sessions.get(collectorId)
  if (!context) return null
  if (!collectorHub.isOnline(collectorId)) {
    sessions.delete(collectorId)
    return null
  }
  return context
}

/**
 * The router switched its signing key during the session (a pairing
 * completed, or it forgot the key): the session's hello block follows, so
 * writes use the new key without waiting for a reconnect.
 */
export function updateSessionSigning(
  collectorId: number | null,
  signing: { key: string; keyId?: string }
): void {
  const context = gatewaySession(collectorId)
  if (!context?.hello.signing) return
  context.hello.signing = { ...context.hello.signing, key: signing.key, keyId: signing.keyId }
}

export function forgetGatewaySession(collectorId: number): void {
  sessions.delete(collectorId)
}

/** Test-only. */
export function _resetGatewaySessions(): void {
  sessions.clear()
  configureBlocks.clear()
}

// ── agent.configure block ────────────────────────────────────────────────

export type GatewayConfigureBlock = {
  mode: GatewayMode
  authoritative: boolean
  watchSeconds: number
  debounceSeconds: number
}

const configureBlocks = new Map<number, GatewayConfigureBlock>()

export function configureBlockFor(collectorId: number): GatewayConfigureBlock | null {
  return configureBlocks.get(collectorId) ?? null
}

export function setConfigureBlock(
  gateway: Gateway,
  settings: Pick<GatewayConfigSettings, 'watchSeconds' | 'importDebounceSeconds'>
): void {
  if (gateway.collectorId === null) return
  // Only collectors with the config plane get the block (observation-only
  // gateways have nothing to watch).
  if (gateway.capabilities?.capable !== true) {
    configureBlocks.delete(gateway.collectorId)
    return
  }
  const mode = normalizeMode(gateway.mode)
  configureBlocks.set(gateway.collectorId, {
    mode,
    authoritative: mode === 'managed' && Boolean(gateway.authoritative),
    watchSeconds: settings.watchSeconds,
    debounceSeconds: settings.importDebounceSeconds,
  })
}

export function clearConfigureBlock(collectorId: number): void {
  configureBlocks.delete(collectorId)
}

export function normalizeMode(value: string): GatewayMode {
  return (GATEWAY_MODES as readonly string[]).includes(value) ? (value as GatewayMode) : 'off'
}

// ── rows ─────────────────────────────────────────────────────────────────

/** The gateway row of a collector (for routes keyed by collector, e.g. observation ingest). */
export async function gatewayForCollector(collectorId: number): Promise<Gateway | null> {
  return Gateway.query().where('collector_id', collectorId).first()
}

/** The gateway behind `/api/v1/gateways/:id` (canonical id: `gateways.id`). */
export async function resolveGateway(id: unknown): Promise<Gateway | null> {
  const n = Number(id)
  if (!Number.isInteger(n) || n < 1) return null
  return Gateway.find(n)
}

/**
 * The collector's gateway row, created (mode `off`) when the collector is
 * adopted and is a gateway (`isGatewayCapability`, or it reports gateway
 * stats). Hello data is copied onto it: the router's access and transport
 * flag, and whether it has the config plane (`capabilities.capable`).
 * Returns null when the collector has no gateway and should not get one.
 */
export async function ensureGateway(
  collector: Collector,
  hello: HelloGatewayConfig | null,
  capabilities: string[] | null
): Promise<Gateway | null> {
  const capable = capabilities?.includes(GATEWAY_CAPABILITY) ?? false
  const isGateway =
    (capabilities ?? []).some(isGatewayCapability) || Boolean(collector.lastStatus?.gateway)
  let gateway = await gatewayForCollector(collector.id)
  if (!gateway) {
    if (!isGateway || collector.lifecycle !== 'adopted') return null
    gateway = new Gateway()
    gateway.collectorId = collector.id
    gateway.mode = 'off'
    gateway.authoritative = false
    gateway.enforcement = 'active'
    gateway.headRevision = 0
    gateway.syncState = 'unknown'
    gateway.createdAt = DateTime.utc()
  }
  const caps: GatewayCapabilities = { ...(gateway.capabilities ?? {}) }
  if (capabilities) {
    caps.capable = capable
    caps.helloCapabilities = capabilities.slice(0, 32)
  }
  if (hello) {
    gateway.agentAccess = hello.access
    caps.access = hello.access ?? undefined
    if (hello.accessConfigured) caps.accessConfigured = hello.accessConfigured
    else delete caps.accessConfigured
    if (hello.transportOk !== null) caps.transportOk = hello.transportOk
    if (hello.protocol !== null) caps.protocol = hello.protocol
    if (hello.management) gateway.managementPath = hello.management
  }
  gateway.capabilities = caps
  await gateway.save()
  setConfigureBlock(gateway, await getGatewayConfigSettings())
  return gateway
}

/**
 * Creates the rows `ensureGateway` would for adopted collectors that have
 * none yet: live sessions that said they are gateways (adopted after their
 * hello), and polled collectors that report gateway stats. Called by
 * `GET /gateways` and after an adoption.
 */
export async function ensureGatewayForCollector(collector: Collector): Promise<Gateway | null> {
  const session = gatewaySession(collector.id)
  if (!session && !collector.lastStatus?.gateway) return gatewayForCollector(collector.id)
  return ensureGateway(collector, session?.hello ?? null, session?.capabilities ?? null)
}

export async function ensureGatewayRows(): Promise<void> {
  const { default: CollectorModel } = await import('#models/collector')
  const rows = await Gateway.query().whereNotNull('collector_id').select('collector_id')
  const bound = new Set(rows.map((g) => g.collectorId))
  const collectors = await CollectorModel.query().where('lifecycle', 'adopted')
  for (const collector of collectors) {
    if (bound.has(collector.id)) continue
    const session = gatewaySession(collector.id)
    const capabilities = session?.capabilities ?? null
    if (!session && !collector.lastStatus?.gateway) continue
    await ensureGateway(collector, session?.hello ?? null, capabilities)
  }
}

// ── write access ─────────────────────────────────────────────────────────

export type WriteBlockReason =
  | 'router_access'
  | 'insecure_transport'
  | 'offline'
  | 'no_capability'
  | 'sign_key_unknown'
  | 'not_paired'

export type WriteAccess =
  | { writable: true; signed: false; secure: true }
  | {
      writable: true
      signed: true
      secure: false
      challenge: string
      /** Which key signs: the pairing's derived key, or the router's config_sign_key. */
      key: 'paired' | 'config_sign_key'
    }
  | { writable: false; reason: WriteBlockReason }

/**
 * Whether the controller may write this gateway now (README 7.1). Secure =
 * the session came in over TLS (`transport_security.ts`) and the agent
 * verifies the certificate (`transportOk`). Otherwise both opt-ins are
 * needed and the write RPCs are signed with the collector's api_key; a
 * router that signs with its own `config_sign_key` cannot be written.
 */
export function writeAccess(
  gateway: Pick<
    Gateway,
    'collectorId' | 'agentAccess' | 'capabilities' | 'configSignKey' | 'pairing' | 'pairingKey'
  >,
  settings: Pick<GatewayConfigSettings, 'allowInsecureTransport'>
): WriteAccess {
  const session = gatewaySession(gateway.collectorId)
  if (!session) return { writable: false, reason: 'offline' }
  if (gateway.capabilities?.capable === false) return { writable: false, reason: 'no_capability' }
  const routerAccess = session.hello.access ?? gateway.agentAccess
  if (routerAccess !== 'write') return { writable: false, reason: 'router_access' }
  const transportOk = session.hello.transportOk ?? gateway.capabilities?.transportOk ?? null
  const signing = session.hello.signing
  if (session.secure === true && transportOk === true && !signing?.required) {
    return { writable: true, signed: false, secure: true }
  }
  // The router's `config_allow_insecure`, from `gateway.capabilities`.
  const routerOptIn = gateway.capabilities?.allowInsecure === true
  if (!settings.allowInsecureTransport || !routerOptIn) {
    return { writable: false, reason: 'insecure_transport' }
  }
  if (!signing || !signing.challenge) return { writable: false, reason: 'insecure_transport' }
  if (signing.key === 'config_sign_key') {
    // The router signs with a key only it and the admin know: the admin
    // enters it (`PUT /gateways/:id/sign-key`).
    if (!gateway.configSignKey) return { writable: false, reason: 'sign_key_unknown' }
    return {
      writable: true,
      signed: true,
      secure: false,
      challenge: signing.challenge,
      key: 'config_sign_key',
    }
  }
  // Owner decision 29: the api_key is never a signing key (it is the
  // bearer token a plain-HTTP listener sees). Writes need a pairing.
  const pairing = gateway.pairing
  const paired =
    pairing?.state === 'paired' &&
    gateway.pairingKey !== null &&
    signing.key === 'paired' &&
    signing.keyId === pairing.keyId
  if (!paired) return { writable: false, reason: 'not_paired' }
  return {
    writable: true,
    signed: true,
    secure: false,
    challenge: signing.challenge,
    key: 'paired',
  }
}
