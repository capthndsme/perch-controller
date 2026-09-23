import db from '@adonisjs/lucid/services/db'

/**
 * Retention of guest data (docs/gateway/portal.md section 5, 12): portal
 * sessions, ended grants and portal events older than
 * `sessionRetentionDays` are deleted. Guest MACs, hostnames and usage are
 * personal data (RA 10173); vouchers, users and API clients are kept, a
 * grant's voucher keeps its totals.
 *
 * Deletes run in batches so the daily sweep never holds a long lock against
 * the socket handlers.
 */

const BATCH = 5000

export type PortalPruneResult = { cutoff: string; sessions: number; grants: number; events: number }

async function deleteInBatches(sql: string, bindings: unknown[]): Promise<number> {
  let total = 0
  for (;;) {
    const [result] = (await db.rawQuery(`${sql} LIMIT ${BATCH}`, bindings)) as unknown as [
      { affectedRows: number },
    ]
    total += result.affectedRows
    if (result.affectedRows < BATCH) return total
  }
}

export async function prunePortalHistory(
  retentionDays: number,
  now: Date = new Date()
): Promise<PortalPruneResult> {
  const cutoffDate = new Date(now.getTime() - retentionDays * 86_400_000)
  const cutoff = cutoffDate.toISOString().slice(0, 19).replace('T', ' ')
  const sessions = await deleteInBatches(
    'DELETE FROM portal_sessions WHERE ended_at IS NOT NULL AND ended_at < ?',
    [cutoff]
  )
  // A grant's remaining sessions go with it (ON DELETE CASCADE); its events
  // keep their row with grant_id NULL until they age out themselves.
  const grants = await deleteInBatches(
    "DELETE FROM portal_grants WHERE state = 'ended' AND ended_at IS NOT NULL AND ended_at < ?",
    [cutoff]
  )
  const events = await deleteInBatches('DELETE FROM portal_events WHERE created_at < ?', [cutoff])
  return { cutoff, sessions, grants, events }
}
