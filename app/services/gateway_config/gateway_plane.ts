import type Collector from '#models/collector'
import Gateway from '#models/gateway'
import GatewayApply from '#models/gateway_apply'
import {
  applyResult,
  onAgentReconnected,
  onChecksNotification,
  onPushAccepted,
} from '#services/gateway_config/apply_lifecycle'
import {
  fetchCapabilities,
  GatewayOfflineError,
  readAndReconcile,
} from '#services/gateway_config/gateway_agent'
import {
  ensureGateway,
  forgetGatewaySession,
  gatewayForCollector,
  gatewaySession,
  normalizeMode,
  parseApplyResult,
  parseHelloGatewayConfig,
  rememberGatewaySession,
  type HelloGatewayConfig,
} from '#services/gateway_config/gateway_registry'
import { refreshCaptureExclusions } from '#services/gateway_network_accounting'
import { reconcilePairingWithHello } from '#services/gateway_config/pairing'
import { gatewayQueue } from '#services/gateway_config/serial_queue'
import type { RouterAuthor } from '#services/gateway_config/types'
import logger from '@adonisjs/core/services/logger'
import type { DateTime } from 'luxon'

/**
 * The config plane's hooks into the collector socket
 * (docs/gateway/config-plane.md sections 4 and 6), called by
 * `collector_agent_gateway.ts`:
 *
 * - `prepareGatewayHello` right after the session is registered and before
 *   `agent.configure` goes out (so the configure carries `gatewayConfig`);
 * - `afterGatewayHello` in the background: unacked results, the fresh
 *   session of a pending apply, capabilities, and a read when the router's
 *   hashes moved while the controller was not looking;
 * - `gateway.config.changed`, `gateway.config.result` and (gateway sync)
 *   `gateway.config.checks` notifications;
 * - every accepted `collector.push` (the agent half of a confirm);
 * - the session's end.
 *
 * Nothing here throws into the socket code: failures are logged.
 */

/** Handles the hello's gateway part; returns the gateway when the collector has one. */
export async function prepareGatewayHello(
  collector: Collector,
  params: { gatewayConfig?: unknown; capabilities?: string[] },
  session: { connectedAt: DateTime; secure: boolean | null }
): Promise<Gateway | null> {
  try {
    const hello = parseHelloGatewayConfig(params.gatewayConfig)
    // Remembered for every session, so a collector adopted after its hello
    // still gets its row (`ensureGatewayRows`).
    rememberGatewaySession(collector.id, hello ?? emptyHello(), {
      ...session,
      capabilities: params.capabilities ?? [],
    })
    const gateway = await ensureGateway(collector, hello, params.capabilities ?? null)
    // The per-network capture flags ride in agent.configure (networks.md 5).
    if (gateway) await refreshCaptureExclusions(collector.id)
    return gateway
  } catch (error) {
    logger.error({ collectorId: collector.id, err: error }, 'gateway_plane: hello failed')
    return null
  }
}

function emptyHello(): HelloGatewayConfig {
  return {
    protocol: null,
    access: null,
    accessConfigured: null,
    transportOk: null,
    hashes: {},
    apply: { state: 'idle' },
    results: [],
    signing: null,
    management: null,
  }
}

/** The background half of the hello (in the gateway's queue). */
export async function afterGatewayHello(gatewayId: number): Promise<void> {
  try {
    await gatewayQueue.run(gatewayId, async () => {
      const gateway = await Gateway.findOrFail(gatewayId)
      const session = gatewaySession(gateway.collectorId)
      if (!session) return
      // Is the router still holding the pairing's key (a reset loses it)?
      await reconcilePairingWithHello(gateway)
      // Outcomes that happened while the controller was unreachable.
      for (const result of session.hello.results) await applyResult(gateway, result)
      await onAgentReconnected(gateway)
      if (gateway.capabilities?.capable !== true) return
      try {
        await fetchCapabilities(gateway)
      } catch (error) {
        logger.debug(
          { gatewayId, error: (error as Error).message },
          'gateway_plane: capabilities unavailable'
        )
      }
      if (normalizeMode(gateway.mode) === 'off') return
      const observed = gateway.observedHashes ?? {}
      const moved =
        !gateway.observedAt ||
        Object.entries(session.hello.hashes).some(([config, hash]) => observed[config] !== hash)
      if (moved) await readAndReconcile(gateway.id, { reason: 'hello' })
    })
  } catch (error) {
    if (!(error instanceof GatewayOfflineError)) {
      logger.warn(
        { gatewayId, error: (error as Error).message },
        'gateway_plane: after-hello work failed'
      )
    }
  }
}

function authorOf(value: unknown): RouterAuthor | null {
  if (typeof value !== 'object' || value === null) return null
  const a = value as Record<string, unknown>
  const kinds = ['luci', 'cli', 'perch', 'unknown']
  if (typeof a.kind !== 'string' || !kinds.includes(a.kind)) return null
  return {
    kind: a.kind as RouterAuthor['kind'],
    ...(typeof a.user === 'string' ? { user: a.user.slice(0, 64) } : {}),
    ...(a.via === 'trigger' || a.via === 'poll' ? { via: a.via } : {}),
    ...(typeof a.applyId === 'string' ? { applyId: a.applyId.slice(0, 64) } : {}),
  }
}

/**
 * `gateway.config.changed` (section 3.3): a router edit is read and merged
 * with its author; the agent's own echo (`origin: "perch"`) only moves the
 * observed hashes (its sections are settled by the apply's confirm).
 */
export async function onConfigChanged(collectorId: number, params: unknown): Promise<void> {
  const gateway = await gatewayForCollector(collectorId)
  if (!gateway || normalizeMode(gateway.mode) === 'off') return
  const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>
  try {
    if (p.origin === 'perch') {
      const echo = await gatewayQueue.run(gateway.id, async () => {
        await gateway.refresh()
        const hashes = p.hashes as Record<string, unknown> | undefined
        const trusted = await ownEchoMatches(gateway.id, p)
        if (trusted && hashes && typeof hashes === 'object') {
          const next: Record<string, string> = { ...(gateway.observedHashes ?? {}) }
          for (const [k, v] of Object.entries(hashes)) if (typeof v === 'string') next[k] = v
          gateway.observedHashes = next
          await gateway.save()
        }
        return trusted
      })
      // Not what that apply wrote (a collector that mistook a router edit
      // for its own echo, as perch-collector before 1.0.0-rc.3 could): read.
      if (!echo) await readAndReconcile(gateway.id, { reason: 'changed' })
      return
    }
    const author = authorOf(p.author) ?? { kind: 'unknown' as const }
    await readAndReconcile(gateway.id, { author, reason: 'changed' })
  } catch (error) {
    logger.warn(
      { gatewayId: gateway.id, error: (error as Error).message },
      'gateway_plane: change notification not merged'
    )
  }
}

/**
 * Is an `origin: "perch"` change what the named apply wrote? True while the
 * apply is open (its rows are deferred anyway), or when every changed
 * config's hash is the one the apply's outcome recorded.
 */
async function ownEchoMatches(gatewayId: number, p: Record<string, unknown>): Promise<boolean> {
  if (typeof p.applyId !== 'string') return false
  const apply = await GatewayApply.query()
    .where('gateway_id', gatewayId)
    .where('apply_key', p.applyId)
    .first()
  if (!apply) return false
  if (apply.state === 'sending' || apply.state === 'pending_confirm') return true
  const recorded = (apply.outcome?.hashes ?? {}) as Record<string, string>
  const hashes = (p.hashes ?? {}) as Record<string, unknown>
  const changed = Array.isArray(p.changed)
    ? p.changed.filter((c): c is string => typeof c === 'string')
    : Object.keys(hashes)
  return (
    changed.length > 0 &&
    changed.every((c) => recorded[c] !== undefined && recorded[c] === hashes[c])
  )
}

/** `gateway.config.result` (section 4): an apply's outcome, acked afterwards. */
export async function onConfigResult(collectorId: number, params: unknown): Promise<void> {
  const result = parseApplyResult(params)
  if (!result) return
  const gateway = await gatewayForCollector(collectorId)
  if (!gateway) return
  try {
    await gatewayQueue.run(gateway.id, async () => {
      await gateway.refresh()
      await applyResult(gateway, result)
    })
    // The router restored or changed its files: read them.
    if (normalizeMode(gateway.mode) !== 'off') {
      await readAndReconcile(gateway.id, { reason: 'result' }).catch(() => undefined)
    }
  } catch (error) {
    logger.warn(
      { gatewayId: gateway.id, error: (error as Error).message },
      'gateway_plane: result not handled'
    )
  }
}

/**
 * `gateway.config.checks` (gateway sync protocol.md 1.5): the router's checks
 * of a pending apply moved; passing ones may release the confirm.
 */
export async function onConfigChecks(collectorId: number, params: unknown): Promise<void> {
  if (typeof params !== 'object' || params === null) return
  const gateway = await gatewayForCollector(collectorId)
  if (!gateway || normalizeMode(gateway.mode) !== 'managed') return
  try {
    await gatewayQueue.run(gateway.id, async () => {
      await gateway.refresh()
      await onChecksNotification(gateway, params as Record<string, unknown>)
    })
  } catch (error) {
    logger.warn(
      { gatewayId: gateway.id, error: (error as Error).message },
      'gateway_plane: checks notification not handled'
    )
  }
}

/** Every accepted `collector.push`. Cheap when nothing is pending. */
export async function onCollectorPushAccepted(collectorId: number): Promise<void> {
  const gateway = await gatewayForCollector(collectorId)
  if (!gateway || normalizeMode(gateway.mode) !== 'managed') return
  try {
    const confirmed = await gatewayQueue.run(gateway.id, async () => {
      await gateway.refresh()
      const before = gateway.headRevision
      await onPushAccepted(gateway)
      await gateway.refresh()
      return gateway.headRevision !== before
    })
    if (confirmed) {
      // The router's files now hold the confirmed state (and maybe router
      // edits the apply deferred): read them.
      await readAndReconcile(gateway.id, { reason: 'confirmed' }).catch(() => undefined)
    }
  } catch (error) {
    logger.warn(
      { gatewayId: gateway.id, error: (error as Error).message },
      'gateway_plane: push hook failed'
    )
  }
}

export function onGatewaySessionClosed(collectorId: number): void {
  forgetGatewaySession(collectorId)
}
