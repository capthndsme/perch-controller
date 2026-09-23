import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'

/**
 * How the REST layer reaches a gateway's router (docs/gateway/portal.md
 * section 11.2). Everything the dashboard or an integration changes that the
 * router must learn (a grant to authorize or remove, a portal's settings, its
 * template, the offline voucher list) is handed to the `PortalAgentSender`
 * after the database change is committed, inside the gateway's portal queue.
 *
 * The REST layer never builds wire messages: signed `portal.*` params carry a
 * nonce and `serverNow` and must be built at send time from the current rows
 * (`messages.ts`). A push names **what** changed; the socket side (WP3) reads
 * the rows and sends. Losing a push is safe: every grant row keeps
 * `delivery = 'pending'` until the router acknowledges its revision, and the
 * next full reconciliation sends the complete desired set anyway.
 *
 * The default sender is `OutboxPortalAgentSender`: it queues the push in
 * `portal_outbox` and answers `pending`. WP3 installs its own sender with
 * `setPortalAgentSender` (enqueue, then deliver at once when the gateway is
 * online and answer `applied` only when the router acknowledged).
 */

export const PORTAL_PUSH_KINDS = [
  'authorize',
  'deauthorize',
  'configure',
  'template',
  'vouchers',
  'sync',
] as const
export type PortalPushKind = (typeof PORTAL_PUSH_KINDS)[number]

/**
 * - `authorize`: these grants are new or changed (created, extended,
 *   promoted); send `portal.authorize` (delta) with their groups.
 * - `deauthorize`: these grants must leave the router (ended by the server,
 *   or queued behind another entitlement); the reason is each grant's
 *   `end_reason`, or `queued` for a grant that is not ended.
 * - `configure`: the portal's settings changed (created, edited, deleted:
 *   a deleted portal is configured as disabled).
 * - `template`: the portal's template files changed; send `portal.template`
 *   when the router's sha differs.
 * - `vouchers`: the gateway's offline voucher list changed (created, revoked,
 *   deleted vouchers); resend `portal.vouchers`.
 * - `sync`: run a full reconciliation (settings that change every grant).
 */
export type PortalPush =
  | { kind: 'authorize'; grantIds: number[] }
  | { kind: 'deauthorize'; grantIds: number[] }
  | { kind: 'configure'; portalId: number }
  | { kind: 'template'; portalId: number }
  | { kind: 'vouchers' }
  | { kind: 'sync' }

/**
 * `applied`: the router acknowledged it. `pending`: queued, delivered when
 * the gateway is (back) online; the REST answer says so and the change is
 * never lost (a paid authorization survives an outage).
 */
export type PortalDelivery = 'applied' | 'pending'

export interface PortalAgentSender {
  /**
   * Called inside `runInPortalQueue(gatewayId)`, after the change committed.
   * Must not throw for an offline gateway (answer `pending`); may throw on a
   * database error, which the REST layer reports as a 500 after the change
   * itself was kept.
   */
  send(gatewayId: number, push: PortalPush): Promise<PortalDelivery>
}

/** The `portal_outbox` merge key: one undelivered row per gateway and key. */
export function outboxDedupeKey(push: PortalPush): string {
  switch (push.kind) {
    case 'configure':
    case 'template':
      return `${push.kind}:${push.portalId}`
    default:
      return push.kind
  }
}

/**
 * Queues the push in `portal_outbox`, merging into the gateway's undelivered
 * row with the same key (grant ids are united), and answers `pending`.
 */
export async function enqueuePortalPush(
  gatewayId: number,
  push: PortalPush,
  client?: TransactionClientContract
): Promise<void> {
  const run = async (trx: TransactionClientContract) => {
    const key = outboxDedupeKey(push)
    const now = DateTime.utc().toSQL({ includeOffset: false })
    const existing = await trx
      .from('portal_outbox')
      .where('gateway_id', gatewayId)
      .where('dedupe_key', key)
      .forUpdate()
      .first()
    const incoming = 'grantIds' in push ? push.grantIds : null
    if (existing) {
      if (!incoming) {
        await trx.from('portal_outbox').where('id', existing.id).update({ updated_at: now })
        return
      }
      const merged = new Set<number>(parseIds(existing.grant_ids))
      for (const id of incoming) merged.add(id)
      await trx
        .from('portal_outbox')
        .where('id', existing.id)
        .update({
          grant_ids: JSON.stringify([...merged].sort((a, b) => a - b)),
          updated_at: now,
        })
      return
    }
    await trx.table('portal_outbox').insert({
      gateway_id: gatewayId,
      kind: push.kind,
      dedupe_key: key,
      portal_id: 'portalId' in push ? push.portalId : null,
      grant_ids: incoming ? JSON.stringify([...new Set(incoming)].sort((a, b) => a - b)) : null,
      attempts: 0,
      created_at: now,
      updated_at: now,
    })
  }
  if (client) return run(client)
  return db.transaction(run)
}

function parseIds(value: unknown): number[] {
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((x) => Number.isSafeInteger(x)) : []
  } catch {
    return []
  }
}

/** The stub until the collector socket (WP3) exists: queue, answer `pending`. */
export class OutboxPortalAgentSender implements PortalAgentSender {
  async send(gatewayId: number, push: PortalPush): Promise<PortalDelivery> {
    if ('grantIds' in push && push.grantIds.length === 0) return 'applied'
    await enqueuePortalPush(gatewayId, push)
    return 'pending'
  }
}

let current: PortalAgentSender = new OutboxPortalAgentSender()

export function portalAgentSender(): PortalAgentSender {
  return current
}

/** Installs another sender (WP3's socket sender; tests). Returns the previous one. */
export function setPortalAgentSender(sender: PortalAgentSender): PortalAgentSender {
  const previous = current
  current = sender
  return previous
}

/**
 * Sends several pushes for one gateway; the result is `applied` only when
 * every push was. Pushes without work (no grant ids) are skipped.
 */
export async function sendPortalPushes(
  gatewayId: number,
  pushes: PortalPush[]
): Promise<PortalDelivery> {
  let delivery: PortalDelivery = 'applied'
  for (const push of pushes) {
    if ('grantIds' in push && push.grantIds.length === 0) continue
    const result = await current.send(gatewayId, push)
    if (result === 'pending') delivery = 'pending'
  }
  return delivery
}
