import GatewayBackup from '#models/gateway_backup'
import collectorHub, {
  AgentOfflineError,
  AgentRpcError,
  AgentTimeoutError,
} from '#services/collector_agent_hub'
import { getGatewayObservationSettings } from '#services/gateway_observation_settings'
import { isObject, rawRows, text } from '#services/gateway_observation_common'
import { ObserveRequestError } from '#services/gateway_observe'
import encryption from '@adonisjs/core/services/encryption'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import { createHash } from 'node:crypto'

/**
 * Router backups (`sysupgrade -b`), pulled over the collector socket with
 * `gateway.backup` (docs/gateway/observation.md section 8; plan-2 section
 * 4.5: manage = pull, restore never). The archive holds every secret of the
 * router, so it is encrypted with the app key at rest, only an admin can
 * download it, and it is never logged or listed. The newest `backupsKept`
 * per gateway stay.
 */

/** Largest archive accepted (a router's /etc is a few hundred KB). */
export const MAX_BACKUP_BYTES = 8 * 1024 * 1024
/** `sysupgrade -b` on a slow router, plus the transfer. */
export const BACKUP_REQUEST_TIMEOUT_MS = 60_000
export const BACKUP_CAPABILITY = 'gateway.backup'

export type BackupRedaction = { file: string; option: string | null; removed: boolean }

export type BackupSummary = {
  id: number
  createdAt: string
  size: number
  sha256: string
  release: string | null
  filename: string | null
  /** The agent replaced the router's secrets (the default); restoring it would reset them. */
  redacted: boolean
  redactions: BackupRedaction[]
  note: string | null
  requestedByUserId: number | null
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * The agent's answer (perch-collector `gateway.backup`): `{ filename,
 * createdAt, release, size, sha256, redacted, redactions, contentBase64 }`
 * (`archive` is accepted for `contentBase64`). Returns the archive or throws
 * `ObserveRequestError` (502 `backup_failed`, 413 `backup_too_large`).
 */
export function decodeBackupAnswer(answer: unknown): {
  archive: Buffer
  sha256: string
  release: string | null
  filename: string | null
  redacted: boolean
  redactions: BackupRedaction[]
} {
  const content = isObject(answer) ? (answer.contentBase64 ?? answer.archive) : undefined
  if (!isObject(answer) || typeof content !== 'string') {
    throw new ObserveRequestError(502, 'backup_failed', 'The gateway sent no archive.')
  }
  const encoded = content.replace(/\s+/g, '')
  // Base64 of 8 MiB is ~11.2 MB: refuse before decoding anything bigger.
  if (encoded.length > Math.ceil((MAX_BACKUP_BYTES * 4) / 3) + 4) {
    throw new ObserveRequestError(413, 'backup_too_large', 'The archive is larger than 8 MiB.')
  }
  if (!BASE64.test(encoded)) {
    throw new ObserveRequestError(502, 'backup_failed', 'The archive is not base64.')
  }
  const archive = Buffer.from(encoded, 'base64')
  if (archive.length === 0) {
    throw new ObserveRequestError(502, 'backup_failed', 'The archive is empty.')
  }
  if (archive.length > MAX_BACKUP_BYTES) {
    throw new ObserveRequestError(413, 'backup_too_large', 'The archive is larger than 8 MiB.')
  }
  // gzip magic: sysupgrade -b writes a .tar.gz.
  if (archive[0] !== 0x1f || archive[1] !== 0x8b) {
    throw new ObserveRequestError(502, 'backup_failed', 'The archive is not gzip data.')
  }
  const sha256 = createHash('sha256').update(archive).digest('hex')
  if (typeof answer.sha256 === 'string' && answer.sha256.toLowerCase() !== sha256) {
    throw new ObserveRequestError(502, 'backup_failed', 'The archive checksum does not match.')
  }
  const redactions: BackupRedaction[] = []
  if (Array.isArray(answer.redactions)) {
    for (const entry of answer.redactions.slice(0, 256)) {
      if (!isObject(entry)) continue
      const file = text(entry.file, 253)
      if (!file) continue
      redactions.push({ file, option: text(entry.option, 64), removed: entry.removed === true })
    }
  }
  const filename = text(answer.filename, 128)
  return {
    archive,
    sha256,
    release: text(answer.release, 128),
    filename: filename && /^[A-Za-z0-9._-]+$/.test(filename) ? filename : null,
    // Unsaid = assume secrets are in it (the safe reading for the UI).
    redacted: answer.redacted === true,
    redactions,
  }
}

/**
 * Asks the gateway for a backup and stores it. Throws `ObserveRequestError`
 * (409 `gateway_offline`, 409 `gateway_capability_missing`, 504
 * `agent_timeout`, 502 `backup_failed`, 413 `backup_too_large`).
 */
export async function createGatewayBackup(
  collectorId: number,
  capabilities: string[] | null,
  options: { userId: number | null; note?: string | null; redact?: boolean }
): Promise<BackupSummary> {
  if (!collectorHub.isOnline(collectorId) || capabilities === null) {
    throw new ObserveRequestError(409, 'gateway_offline', 'The gateway agent is not connected.')
  }
  if (!capabilities.includes(BACKUP_CAPABILITY)) {
    throw new ObserveRequestError(
      409,
      'gateway_capability_missing',
      'The gateway agent cannot take backups.',
      { capability: BACKUP_CAPABILITY }
    )
  }
  let answer: unknown
  try {
    answer = await collectorHub.request(
      collectorId,
      'gateway.backup',
      { redact: options.redact ?? true },
      {
        timeoutMs: BACKUP_REQUEST_TIMEOUT_MS,
      }
    )
  } catch (error) {
    if (error instanceof AgentOfflineError) {
      throw new ObserveRequestError(409, 'gateway_offline', 'The gateway agent is not connected.')
    }
    if (error instanceof AgentTimeoutError) {
      throw new ObserveRequestError(
        504,
        'agent_timeout',
        'The gateway agent did not answer in time.'
      )
    }
    if (error instanceof AgentRpcError) {
      const code = isObject(error.data) ? error.data.error : undefined
      if (code === 'backup_too_large') {
        throw new ObserveRequestError(413, 'backup_too_large', error.message)
      }
      if (code === 'backup_redaction_required') {
        throw new ObserveRequestError(409, 'backup_redaction_required', error.message)
      }
      throw new ObserveRequestError(502, 'backup_failed', error.message)
    }
    throw error
  }
  const { archive, sha256, release, filename, redacted, redactions } = decodeBackupAnswer(answer)

  const backup = await GatewayBackup.create({
    collectorId,
    createdAt: DateTime.utc().startOf('second'),
    size: archive.length,
    sha256,
    release,
    filename,
    redacted,
    redactions: JSON.stringify(redactions),
    content: Buffer.from(encryption.encrypt(archive.toString('base64')), 'utf8'),
    requestedByUserId: options.userId,
    note: options.note ?? null,
  })
  // Newest `backupsKept` stay (the retention task sweeps again daily).
  await pruneBackups(collectorId)
  logger.info(
    { collectorId, backupId: backup.id, size: archive.length, userId: options.userId },
    'gateway_backups: backup stored'
  )
  return summaryOf(backup)
}

async function pruneBackups(collectorId: number): Promise<void> {
  const { backupsKept } = await getGatewayObservationSettings()
  const keep = rawRows<{ id: number }>(
    await db.rawQuery(
      `SELECT id FROM gateway_backups WHERE collector_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ?`,
      [collectorId, backupsKept]
    )
  ).map((r) => Number(r.id))
  if (keep.length === 0) return
  await db.rawQuery(
    `DELETE FROM gateway_backups WHERE collector_id = ? AND id NOT IN (${keep.map(() => '?').join(',')})`,
    [collectorId, ...keep]
  )
}

function summaryOf(backup: GatewayBackup): BackupSummary {
  return {
    id: backup.id,
    createdAt: backup.createdAt.toUTC().toISO({ suppressMilliseconds: true })!,
    size: backup.size,
    sha256: backup.sha256,
    release: backup.release,
    filename: backup.filename,
    redacted: Boolean(backup.redacted),
    redactions: parseRedactions(backup.redactions),
    note: backup.note,
    requestedByUserId: backup.requestedByUserId,
  }
}

function parseRedactions(raw: string | null): BackupRedaction[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as BackupRedaction[]) : []
  } catch {
    return []
  }
}

type BackupRow = {
  id: number
  createdAt: string
  size: number
  sha256: string
  release: string | null
  filename: string | null
  redacted: number | boolean
  redactions: string | null
  note: string | null
  requestedByUserId: number | null
}

const SUMMARY_COLUMNS = `id, DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS createdAt, size, sha256,
  \`release\`, filename, redacted, redactions, note, requested_by_user_id AS requestedByUserId`

function summaryOfRow(r: BackupRow): BackupSummary {
  return {
    id: Number(r.id),
    createdAt: r.createdAt,
    size: Number(r.size),
    sha256: r.sha256,
    release: r.release,
    filename: r.filename,
    redacted: Boolean(Number(r.redacted)),
    redactions: parseRedactions(r.redactions),
    note: r.note,
    requestedByUserId: r.requestedByUserId === null ? null : Number(r.requestedByUserId),
  }
}

/** Newest first; never the content. */
export async function listGatewayBackups(collectorId: number): Promise<BackupSummary[]> {
  const rows = rawRows<BackupRow>(
    await db.rawQuery(
      `SELECT ${SUMMARY_COLUMNS} FROM gateway_backups
        WHERE collector_id = ? ORDER BY created_at DESC, id DESC`,
      [collectorId]
    )
  )
  return rows.map(summaryOfRow)
}

/** The decrypted archive, or null when the backup does not exist (or cannot be decrypted). */
export async function readGatewayBackupArchive(
  collectorId: number,
  backupId: number
): Promise<{ archive: Buffer; summary: BackupSummary } | null> {
  const rows = rawRows<BackupRow & { content: Buffer | string }>(
    await db.rawQuery(
      `SELECT ${SUMMARY_COLUMNS}, content FROM gateway_backups WHERE collector_id = ? AND id = ?`,
      [collectorId, backupId]
    )
  )
  const row = rows[0]
  if (!row) return null
  let decrypted: string | null = null
  try {
    decrypted = encryption.decrypt<string>(Buffer.from(row.content).toString('utf8'))
  } catch {
    decrypted = null
  }
  if (typeof decrypted !== 'string') return null
  return { archive: Buffer.from(decrypted, 'base64'), summary: summaryOfRow(row) }
}
