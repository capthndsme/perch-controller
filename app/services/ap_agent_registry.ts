import ApJoinToken, { type ApJoinTokenStatus } from '#models/ap_join_token'
import WifiAccessPoint, { type ApAgentInfo } from '#models/wifi_access_point'
import hub, { CLOSE_CODES } from '#services/ap_agent_hub'
import { generateAgentCredentials, sha256Hex } from '#services/ap_agent_credentials'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'

/**
 * Everything that changes an AP's agent identity: joining with a token,
 * what the agent reports about itself, connect/disconnect bookkeeping and
 * "forget agent" (docs/ap-controller.md sections 2 and 4.3).
 */

/** Poll interval of a row created by a join (the column default). */
const DEFAULT_POLL_INTERVAL_SECONDS = 15

const MAC_REGEX = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/

export type JoinInput = {
  token: string
  hostname: string
  model?: string
  boardName?: string
  release?: string
  revision?: string
  target?: string
  arch?: string
  kernel?: string
  agentVersion: string
  macs: string[]
}

export type JoinOutcome = 'created' | 'linked' | 'rejoined'

export type JoinResult =
  | {
      status: 'joined'
      agentId: string
      agentSecret: string
      ap: WifiAccessPoint
      outcome: JoinOutcome
    }
  | { status: 'invalid_token'; reason: 'unknown' | Exclude<ApJoinTokenStatus, 'active'> }

/**
 * Trades a join token for agent credentials. Matching, in order:
 *
 *   1. a row that already has an agent whose recorded MACs overlap → `rejoined`
 *      (credentials rotated; most recently connected wins);
 *   2. a row whose latest wifi networks have one of the MACs as BSSID →
 *      `linked` (most recently seen wins; `rejoined` if it happens to have
 *      an agent whose recorded MACs were stale);
 *   3. otherwise a new row → `created`.
 *
 * Token use is counted under a row lock, so a single-use token cannot be
 * spent twice by two APs joining at the same moment.
 */
export async function joinAgent(
  input: JoinInput,
  options: { now?: DateTime } = {}
): Promise<JoinResult> {
  const now = options.now ?? DateTime.utc()
  const tokenHash = sha256Hex(input.token)
  const macs = normalizeMacs(input.macs)
  const credentials = generateAgentCredentials()

  const trx = await db.transaction()
  let ap: WifiAccessPoint
  let outcome: JoinOutcome
  let existed: boolean
  try {
    const token = await ApJoinToken.query({ client: trx })
      .where('token_hash', tokenHash)
      .forUpdate()
      .first()
    if (!token) {
      await trx.rollback()
      return { status: 'invalid_token', reason: 'unknown' }
    }
    const status = token.statusAt(now)
    if (status !== 'active') {
      await trx.rollback()
      return { status: 'invalid_token', reason: status }
    }

    const rejoin = await findRejoinCandidate(macs, trx)
    const linked = rejoin ? null : await findLinkCandidate(macs, trx)
    if (rejoin) {
      ap = rejoin
      outcome = 'rejoined'
      existed = true
    } else if (linked) {
      ap = linked
      outcome = linked.agentId ? 'rejoined' : 'linked'
      existed = true
    } else {
      ap = new WifiAccessPoint()
      ap.name = truncate(input.hostname, 120)!
      ap.friendlyName = null
      ap.metricsUrl = null
      ap.pollIntervalSeconds = DEFAULT_POLL_INTERVAL_SECONDS
      ap.enabled = true
      ap.enableTwoWayCommands = false
      ap.sshHost = null
      ap.sshPort = 22
      ap.sshUsername = null
      ap.sshPrivateKey = null
      ap.lastSeenAt = null
      ap.lastStatus = null
      outcome = 'created'
      existed = false
    }

    ap.transport = 'agent'
    ap.agentId = credentials.agentId
    ap.agentSecretHash = credentials.secretHash
    ap.agentVersion = truncate(input.agentVersion, 32)
    ap.agentInfo = {
      ...(ap.agentInfo ?? {}),
      hostname: truncate(input.hostname, 120),
      model: truncate(input.model, 120),
      boardName: truncate(input.boardName, 120),
      release: truncate(input.release, 50),
      revision: truncate(input.revision, 64),
      target: truncate(input.target, 64),
      arch: truncate(input.arch, 32),
      kernel: truncate(input.kernel, 64),
      macs,
      // Filled by the first `system.info` after the agent connects.
      capabilities: [],
    }
    ap.agentJoinedAt = now
    ap.joinTokenId = token.id
    ap.nodename = truncate(input.hostname, 120)
    if (input.model) ap.model = truncate(input.model, 120)
    if (input.release) ap.openwrtRelease = truncate(input.release, 50)
    ap.useTransaction(trx)
    await ap.save()

    token.useCount = (token.useCount ?? 0) + 1
    token.lastUsedAt = now
    token.useTransaction(trx)
    await token.save()

    await trx.commit()
  } catch (error) {
    if (!trx.isCompleted) await trx.rollback()
    throw error
  }

  // Old credentials are dead now; a session still using them must go.
  if (existed) hub.disconnect(ap.id, CLOSE_CODES.REVOKED, 'credentials rotated by a new join')

  return {
    status: 'joined',
    agentId: credentials.agentId,
    agentSecret: credentials.agentSecret,
    ap,
    outcome,
  }
}

async function findRejoinCandidate(
  macs: string[],
  trx: TransactionClientContract
): Promise<WifiAccessPoint | null> {
  if (macs.length === 0) return null
  const wanted = new Set(macs)
  const rows = await WifiAccessPoint.query({ client: trx }).whereNotNull('agent_id').forUpdate()
  const matches = rows.filter((row) => (row.agentInfo?.macs ?? []).some((mac) => wanted.has(mac)))
  matches.sort(
    (left, right) =>
      millis(right.agentConnectedAt) - millis(left.agentConnectedAt) || right.id - left.id
  )
  return matches[0] ?? null
}

async function findLinkCandidate(
  macs: string[],
  trx: TransactionClientContract
): Promise<WifiAccessPoint | null> {
  if (macs.length === 0) return null
  // The poller stores BSSIDs lowercased and the column collation is
  // case-insensitive anyway, so a plain IN matches either way.
  const hits = await trx.from('wifi_network_latest').whereIn('bssid', macs).distinct('ap_id')
  const ids = hits.map((row: { ap_id: number }) => Number(row.ap_id))
  if (ids.length === 0) return null
  const rows = await WifiAccessPoint.query({ client: trx }).whereIn('id', ids).forUpdate()
  rows.sort(
    (left, right) => millis(right.lastSeenAt) - millis(left.lastSeenAt) || right.id - left.id
  )
  return rows[0] ?? null
}

/** Shape of a `system.info` result we are willing to persist. */
export type SystemInfoResult = Record<string, unknown>

/**
 * Stores what the agent reports about itself: identity columns the rest of
 * the app already reads (`nodename`, `model`, `openwrt_release`), the agent
 * version, and the rest merged into `agent_info`. Everything is type-checked
 * and length-capped — the agent is trusted to be itself, not to be well
 * formed.
 */
export async function recordSystemInfo(
  apId: number,
  info: SystemInfoResult,
  expectedAgentId?: string | null
): Promise<WifiAccessPoint | null> {
  const ap = await WifiAccessPoint.find(apId)
  if (!ap) return null
  // An answer from a session whose credentials have since been rotated or
  // forgotten no longer speaks for this row.
  if (expectedAgentId !== undefined && ap.agentId !== expectedAgentId) return null

  const patch = sanitizeSystemInfo(info)
  const merged: ApAgentInfo = { ...(ap.agentInfo ?? {}), ...patch }
  if (JSON.stringify(merged).length > 60_000) {
    // A pathological device list must not overflow the TEXT column.
    delete merged.radios
    delete merged.interfaces
  }
  ap.agentInfo = merged

  const version = str(info.agentVersion, 32)
  if (version) ap.agentVersion = version
  if (patch.hostname) ap.nodename = patch.hostname
  if (patch.model) ap.model = patch.model
  if (patch.release) ap.openwrtRelease = patch.release
  await ap.save()
  return ap
}

function sanitizeSystemInfo(info: SystemInfoResult): ApAgentInfo {
  const patch: ApAgentInfo = {}
  const hostname = str(info.hostname, 120)
  if (hostname) patch.hostname = hostname
  const model = str(info.model, 120)
  if (model) patch.model = model
  const boardName = str(info.boardName, 120)
  if (boardName) patch.boardName = boardName
  const system = str(info.system, 120)
  if (system) patch.system = system
  const release = str(info.release, 50)
  if (release) patch.release = release
  const revision = str(info.revision, 64)
  if (revision) patch.revision = revision
  const target = str(info.target, 64)
  if (target) patch.target = target
  const arch = str(info.arch, 32)
  if (arch) patch.arch = arch
  const kernel = str(info.kernel, 64)
  if (kernel) patch.kernel = kernel
  if (typeof info.protocol === 'number' && Number.isFinite(info.protocol)) {
    patch.protocol = info.protocol
  }
  if (typeof info.uptimeSeconds === 'number' && Number.isFinite(info.uptimeSeconds)) {
    patch.uptimeSeconds = Math.max(0, Math.trunc(info.uptimeSeconds))
  }
  if (Array.isArray(info.macs)) {
    patch.macs = normalizeMacs(info.macs.filter((mac): mac is string => typeof mac === 'string'))
  }
  if (Array.isArray(info.capabilities)) {
    patch.capabilities = [
      ...new Set(
        info.capabilities
          .filter((cap): cap is string => typeof cap === 'string' && cap.length > 0)
          .map((cap) => cap.slice(0, 32))
      ),
    ].slice(0, 32)
  }
  if (Array.isArray(info.radios)) {
    patch.radios = info.radios.filter(isPlainObject).slice(0, 16)
  }
  if (Array.isArray(info.interfaces)) {
    patch.interfaces = info.interfaces.filter(isPlainObject).slice(0, 64)
  }
  return patch
}

/**
 * Session bookkeeping written by the gateway. Scoped to the agent id the
 * session authenticated with, so a session whose credentials were rotated
 * or forgotten meanwhile cannot touch the row.
 */
export async function markAgentConnected(
  apId: number,
  agentId: string,
  address: string | null,
  now: DateTime = DateTime.utc()
): Promise<void> {
  await db
    .from('wifi_access_points')
    .where('id', apId)
    .where('agent_id', agentId)
    .update({
      agent_connected_at: now.toFormat('yyyy-MM-dd HH:mm:ss'),
      agent_last_address: address ? address.slice(0, 64) : null,
    })
}

/**
 * The session is gone: record when, and say so in `last_status` so the
 * dashboard shows the AP as offline rather than its last good push.
 */
export async function markAgentDisconnected(
  apId: number,
  agentId: string,
  now: DateTime = DateTime.utc()
): Promise<void> {
  await db
    .from('wifi_access_points')
    .where('id', apId)
    .where('agent_id', agentId)
    .update({
      agent_disconnected_at: now.toFormat('yyyy-MM-dd HH:mm:ss'),
      last_status: JSON.stringify({ ok: false, checkedAt: now.toISO(), error: 'agent offline' }),
    })
}

/**
 * "Forget agent": the credentials stop working at once (live session closed
 * with 4001), the row goes back to HTTP scraping, and one without a metrics
 * URL is disabled rather than left polling nothing.
 */
export async function forgetAgent(ap: WifiAccessPoint): Promise<WifiAccessPoint> {
  hub.disconnect(ap.id, CLOSE_CODES.REVOKED, 'agent forgotten')
  ap.agentId = null
  ap.agentSecretHash = null
  ap.transport = 'scrape'
  if (!ap.metricsUrl) ap.enabled = false
  await ap.save()
  return ap
}

function normalizeMacs(values: string[]): string[] {
  const out = new Set<string>()
  for (const value of values) {
    const mac = value.trim().toLowerCase().replace(/-/g, ':')
    if (MAC_REGEX.test(mac)) out.add(mac)
    if (out.size >= 64) break
  }
  return [...out]
}

function truncate(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed.slice(0, max) : null
}

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' ? truncate(value, max) : null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function millis(value: DateTime | null | undefined): number {
  return value ? value.toMillis() : 0
}
