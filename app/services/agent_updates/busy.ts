import type { DeviceKind } from '#services/agent_updates/state'
import db from '@adonisjs/lucid/services/db'

/**
 * Whether a config apply on the device waits for its confirm
 * (agent-updates controller.md section 5.2): an update does not start then
 * (the agent's own busy hooks refuse the install too, `busy_pending_apply`).
 *
 * - AP: a device-groups apply in `sending` / `pending_confirm`
 *   (`ap_group_states`, `ap_groups.ts`), or a Wi-Fi config plane apply in the
 *   same states (`ap_config_applies`).
 * - Collector: a managed gateway's config apply in `sending` /
 *   `pending_confirm` (`gateway_applies`; BUILD-PLAN agreement 3).
 *
 * Returns what waits, or null.
 */
export async function applyPending(kind: DeviceKind, id: number): Promise<string | null> {
  if (kind === 'ap') {
    const row = await db
      .from('ap_group_states')
      .where('ap_id', id)
      .whereIn('state', ['sending', 'pending_confirm'])
      .first()
    if (row) return 'device_groups'
    const wifi = await db
      .from('ap_config_applies')
      .where('ap_id', id)
      .whereIn('state', ['sending', 'pending_confirm'])
      .first()
    return wifi ? 'wifi_config' : null
  }
  const row = await db
    .from('gateway_applies')
    .join('gateways', 'gateways.id', 'gateway_applies.gateway_id')
    .where('gateways.collector_id', id)
    .whereIn('gateway_applies.state', ['sending', 'pending_confirm'])
    .first()
  return row ? 'gateway_config' : null
}
