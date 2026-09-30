import type { QueryClientContract, TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'

type Client = QueryClientContract | TransactionClientContract

/**
 * `collectors:merge` for the agent-updates tables (controller.md section 2.8),
 * inside the merge transaction and before the removed collector row is
 * deleted:
 *
 * - `agent_update_devices`: the survivor's row wins, the other is deleted;
 *   without one the removed side's row moves over;
 * - `agent_update_jobs`: every job moves (history); when both sides have an
 *   open job, the removed side's is cancelled first (one open job per device);
 * - `agent_update_events`: every row moves;
 * - `agent_update_rollout_devices`: every row moves, except where the
 *   survivor is in the same rollout already (the survivor's row stays).
 */
export async function repointAgentUpdates(
  trx: Client,
  sides: { survivorId: number; removedId: number }
): Promise<void> {
  const { survivorId, removedId } = sides
  const rows = (await trx
    .from('agent_update_devices')
    .where('collector_id', survivorId)
    .select('id')) as Array<{ id: number }>
  if (rows.length > 0) {
    await trx.from('agent_update_devices').where('collector_id', removedId).delete()
  } else {
    await trx
      .from('agent_update_devices')
      .where('collector_id', removedId)
      .update({ collector_id: survivorId })
  }

  const now = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')
  const survivorOpen = await trx
    .from('agent_update_jobs')
    .where('collector_id', survivorId)
    .whereNotNull('active_key')
    .first()
  if (survivorOpen) {
    await trx
      .from('agent_update_jobs')
      .where('collector_id', removedId)
      .whereNotNull('active_key')
      .update({
        state: 'cancelled',
        reason: 'merged',
        active_key: null,
        finished_at: now,
        updated_at: now,
      })
  }
  await trx
    .from('agent_update_jobs')
    .where('collector_id', removedId)
    .whereNotNull('active_key')
    .update({ collector_id: survivorId, active_key: `collector:${survivorId}`, updated_at: now })
  await trx
    .from('agent_update_jobs')
    .where('collector_id', removedId)
    .update({ collector_id: survivorId })
  await trx
    .from('agent_update_events')
    .where('collector_id', removedId)
    .update({ collector_id: survivorId })

  const shared = (await trx
    .from('agent_update_rollout_devices')
    .where('collector_id', survivorId)
    .select('rollout_id')) as Array<{ rollout_id: number }>
  const rollouts = shared.map((row) => row.rollout_id)
  if (rollouts.length > 0) {
    await trx
      .from('agent_update_rollout_devices')
      .where('collector_id', removedId)
      .whereIn('rollout_id', rollouts)
      .delete()
  }
  await trx
    .from('agent_update_rollout_devices')
    .where('collector_id', removedId)
    .update({ collector_id: survivorId })
}
