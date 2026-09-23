import type Gateway from '#models/gateway'
import type GatewayApply from '#models/gateway_apply'
import GatewayWanBlock, { type WanBlockFlush } from '#models/gateway_wan_block'
import { recordGatewayEvent } from '#services/gateway_config/events'
import { agentErrorCode, gatewayRequest } from '#services/gateway_config/gateway_agent'
import { gatewaySession } from '#services/gateway_config/gateway_registry'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'

/**
 * Work that runs once an apply is live on the router
 * (`gateway_applies.post_actions`, docs/gateway/firewall.md section 5).
 *
 * The per-device WAN block adds the MAC to the `perch_block_wan` set, but fw4
 * accepts established flows before any zone chain: the device's running
 * connections would go on. So once the job is live (the agent committed,
 * reloaded fw4 and came back on a fresh session), the controller asks the
 * collector to delete the device's conntrack entries (`net.conntrack_flush`,
 * README decision 9; perch-collector `CONFIG.md` "Conntrack flush"). Earlier
 * would be useless: a flow flushed before the rule exists is simply tracked
 * again.
 */

export const CONNTRACK_FLUSH_TIMEOUT_MS = 10_000
/** The agent refuses more than 64 addresses per call. */
export const CONNTRACK_MAX_IPS = 64

/**
 * `net.conntrack_flush {ips}` on the gateway's collector. Never throws:
 * `flushed: null` = not attempted (offline, no capability, no address),
 * `false` = the agent could not (its `reason`), `true` = done.
 */
export async function flushConntrack(gateway: Gateway, ipsIn: string[]): Promise<WanBlockFlush> {
  const ips = [...new Set(ipsIn)].slice(0, CONNTRACK_MAX_IPS)
  const base = { at: DateTime.utc().toISO()!, ips }
  const session = gatewaySession(gateway.collectorId)
  if (!session) return { ...base, flushed: null, reason: 'offline' }
  if (!session.capabilities.includes('net.conntrack_flush')) {
    return { ...base, flushed: null, reason: 'capability_missing' }
  }
  if (ips.length === 0) return { ...base, flushed: null, reason: 'no_address' }
  try {
    const result = await gatewayRequest<Record<string, unknown>>(
      gateway,
      'net.conntrack_flush',
      { ips },
      { timeoutMs: CONNTRACK_FLUSH_TIMEOUT_MS }
    )
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
    return {
      ...base,
      flushed: result?.flushed === true,
      matched: num(result?.matched),
      deleted: num(result?.deleted),
      skipped: num(result?.skipped),
      ...(typeof result?.reason === 'string' ? { reason: result.reason.slice(0, 120) } : {}),
    }
  } catch (error) {
    return {
      ...base,
      flushed: false,
      reason: agentErrorCode(error) ?? ((error as Error).message ?? 'error').slice(0, 120),
    }
  }
}

/**
 * Runs the job's post actions when the job carries their sections and they
 * have not run yet. Called on the agent half of a confirm (fresh session +
 * first push) and when a job is confirmed without a window.
 */
export async function runPostActions(gateway: Gateway, apply: GatewayApply): Promise<void> {
  const flush = apply.postActions?.conntrackFlush
  if (!flush || flush.done) return
  if (!apply.perchIds.some((id) => flush.perchIds.includes(id))) return
  const result = await flushConntrack(gateway, flush.ips)
  apply.postActions = {
    ...apply.postActions,
    conntrackFlush: { ...flush, done: true, result: { ...result } },
  }
  await apply.save()
  const block = await GatewayWanBlock.query()
    .where('gateway_id', gateway.id)
    .where('mac', flush.mac)
    .first()
  if (block) {
    block.lastFlush = { ...result, applyId: apply.applyKey }
    await block.save()
  }
  await recordGatewayEvent(gateway.id, 'conntrack_flushed', {
    applyId: Number(apply.id),
    detail: {
      mac: flush.mac,
      flushed: result.flushed,
      ips: result.ips,
      ...(result.deleted !== undefined ? { deleted: result.deleted } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
    },
  })
  if (result.flushed === false) {
    logger.info(
      { gatewayId: gateway.id, mac: flush.mac, reason: result.reason },
      'post_actions: conntrack flush failed; existing connections continue'
    )
  }
}
