import ApJoinToken, { type ApJoinTokenStatus } from '#models/ap_join_token'
import User from '#models/user'
import {
  generateJoinToken,
  joinTokenDisplayPrefix,
  sha256Hex,
} from '#services/ap_agent_credentials'
import { DateTime } from 'luxon'

/**
 * Admin side of join tokens (docs/ap-controller.md section 4.1): create,
 * list, show again, revoke. The wire shape is `ApJoinTokenView`; the token
 * itself only ever leaves in `create` and `reveal` responses.
 */

export type ApJoinTokenView = {
  id: number
  label: string | null
  prefix: string
  status: ApJoinTokenStatus
  createdAt: string
  expiresAt: string | null
  revokedAt: string | null
  lastUsedAt: string | null
  useCount: number
  maxUses: number | null
  createdBy: { id: number; email: string } | null
}

export type CreateJoinTokenInput = {
  label?: string | null
  expiresInHours?: number | null
  maxUses?: number | null
}

export async function listJoinTokens(now: DateTime = DateTime.utc()): Promise<ApJoinTokenView[]> {
  const rows = await ApJoinToken.query().orderBy('created_at', 'desc').orderBy('id', 'desc')
  const users = await usersById(rows)
  return rows.map((row) => toView(row, users, now))
}

export async function createJoinToken(
  input: CreateJoinTokenInput,
  createdBy: { id: number } | null,
  now: DateTime = DateTime.utc()
): Promise<{ token: string; joinToken: ApJoinTokenView }> {
  const token = generateJoinToken()
  const label = input.label?.trim() ? input.label.trim().slice(0, 80) : null
  const row = await ApJoinToken.create({
    label,
    tokenHash: sha256Hex(token),
    tokenPrefix: joinTokenDisplayPrefix(token),
    token,
    createdByUserId: createdBy?.id ?? null,
    expiresAt: input.expiresInHours ? now.plus({ hours: input.expiresInHours }) : null,
    maxUses: input.maxUses ?? null,
    useCount: 0,
    lastUsedAt: null,
    revokedAt: null,
  })
  const users = await usersById([row])
  return { token, joinToken: toView(row, users, now) }
}

export type RevealResult =
  | { status: 'ok'; token: string }
  | { status: 'not_found' }
  | { status: 'inactive'; reason: Exclude<ApJoinTokenStatus, 'active'> | 'unrecoverable' }

export async function revealJoinToken(
  id: number,
  now: DateTime = DateTime.utc()
): Promise<RevealResult> {
  const row = isRowId(id) ? await ApJoinToken.find(id) : null
  if (!row) return { status: 'not_found' }
  const status = row.statusAt(now)
  if (status !== 'active') return { status: 'inactive', reason: status }
  if (!row.token) return { status: 'inactive', reason: 'unrecoverable' }
  return { status: 'ok', token: row.token }
}

/** Idempotent: a token revoked twice keeps its first `revoked_at`. */
export async function revokeJoinToken(
  id: number,
  now: DateTime = DateTime.utc()
): Promise<boolean> {
  const row = isRowId(id) ? await ApJoinToken.find(id) : null
  if (!row) return false
  if (!row.revokedAt) {
    row.revokedAt = now
    await row.save()
  }
  return true
}

function isRowId(id: number): boolean {
  return Number.isSafeInteger(id) && id > 0
}

async function usersById(rows: ApJoinToken[]): Promise<Map<number, { id: number; email: string }>> {
  const ids = [
    ...new Set(rows.map((row) => row.createdByUserId).filter((id): id is number => !!id)),
  ]
  const map = new Map<number, { id: number; email: string }>()
  if (ids.length === 0) return map
  const users = await User.query().whereIn('id', ids).select('id', 'email')
  for (const user of users) map.set(user.id, { id: user.id, email: user.email })
  return map
}

function toView(
  row: ApJoinToken,
  users: Map<number, { id: number; email: string }>,
  now: DateTime
): ApJoinTokenView {
  return {
    id: row.id,
    label: row.label ?? null,
    prefix: row.tokenPrefix,
    status: row.statusAt(now),
    createdAt: row.createdAt.toUTC().toISO()!,
    expiresAt: row.expiresAt?.toUTC().toISO() ?? null,
    revokedAt: row.revokedAt?.toUTC().toISO() ?? null,
    lastUsedAt: row.lastUsedAt?.toUTC().toISO() ?? null,
    useCount: row.useCount ?? 0,
    maxUses: row.maxUses ?? null,
    createdBy: row.createdByUserId ? (users.get(row.createdByUserId) ?? null) : null,
  }
}
