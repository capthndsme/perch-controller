import Gateway from '#models/gateway'
import QosAssignment from '#models/qos_assignment'
import type { PortalShaping, PortalShapingEntry } from '#services/portal_shaping'
import { QosError } from '#services/qos_gateway'
import { onQuotaExhausted } from '#services/qos_live'
import { releaseDevice, shapeDevice } from '#services/qos_shaping'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * The portal's shaping seam wired to traffic shaping (docs/gateway/portal.md
 * section 13.7; docs/gateway/qos.md section 8): every capped portal device
 * becomes a `source: 'portal'` device assignment keyed by the portal's
 * `sourceRef` (`portal-grant:<id>`, `portal-local:<portalId>:<localRef>`),
 * through `shapeDevice` / `releaseDevice`.
 *
 * - Only a gateway in managed mode is shaped (QoS writes need it); otherwise
 *   every call is a no-op and the router's portal tick (and its nft quota)
 *   stays the only enforcement.
 * - A device an administrator already caps keeps the admin's cap
 *   (`qos_mac_assigned`): logged, never overridden.
 * - A quota is set once, when the assignment gets it: the QoS side counts the
 *   bytes from then on, so later "bytes left" figures from the portal (which
 *   shrink as the same bytes are used) never replace it (that would count
 *   the usage twice). A grant that gains a quota later gets it then.
 * - Per-device rates, no tier policies: a portal group's `downKbps` /
 *   `upKbps` cap each device, which is exactly a device assignment's own
 *   rate (`ensureTierPolicy` stays for integrations that want named tiers).
 * - `quota_exhausted` for a portal assignment is written to the portal's
 *   event log (`shaping_quota_exhausted`) of that gateway.
 *
 * Nothing here throws: the portal calls it best effort.
 */

const PORTAL_REF = /^portal-(grant|local):/
const SOURCE_REF = /^[A-Za-z0-9_.:-]{1,64}$/

async function managedGateway(gatewayId: number): Promise<boolean> {
  const gateway = await Gateway.find(gatewayId)
  return gateway !== null && gateway.mode === 'managed'
}

function refusalCode(error: unknown): string | null {
  if (error instanceof QosError && typeof error.body.error === 'string') return error.body.error
  return null
}

export class QosPortalShaping implements PortalShaping {
  async sync(gatewayId: number, entries: PortalShapingEntry[]): Promise<void> {
    if (!(await managedGateway(gatewayId))) return
    const wanted = new Set(entries.map((e) => e.sourceRef))
    const held = await QosAssignment.query()
      .where('gatewayId', gatewayId)
      .where('source', 'portal')
      .select('sourceRef')
    const stale = held
      .map((row) => row.sourceRef)
      .filter((ref): ref is string => ref !== null && PORTAL_REF.test(ref) && !wanted.has(ref))
    await this.#apply(gatewayId, entries, stale)
  }

  async apply(gatewayId: number, upserts: PortalShapingEntry[], releases: string[]): Promise<void> {
    if (!(await managedGateway(gatewayId))) return
    await this.#apply(gatewayId, upserts, releases)
  }

  async #apply(gatewayId: number, upserts: PortalShapingEntry[], releases: string[]) {
    for (const sourceRef of releases) {
      try {
        await releaseDevice(sourceRef)
      } catch (error) {
        logger.warn({ gatewayId, sourceRef, err: error }, 'portal_qos_shaping: release failed')
      }
    }
    for (const entry of upserts) {
      try {
        await this.#shape(gatewayId, entry)
      } catch (error) {
        const code = refusalCode(error)
        const level = code === 'qos_mac_assigned' ? 'info' : 'warn'
        logger[level](
          { gatewayId, sourceRef: entry.sourceRef, mac: entry.mac, error: code ?? String(error) },
          'portal_qos_shaping: device not shaped'
        )
      }
    }
  }

  async #shape(gatewayId: number, entry: PortalShapingEntry): Promise<void> {
    if (!SOURCE_REF.test(entry.sourceRef)) {
      logger.warn(
        { gatewayId, sourceRef: entry.sourceRef },
        'portal_qos_shaping: sourceRef unusable'
      )
      return
    }
    const expiresAt = entry.expiresAt !== null ? DateTime.fromMillis(entry.expiresAt) : null
    if (expiresAt && expiresAt.toMillis() <= Date.now()) {
      await releaseDevice(entry.sourceRef)
      return
    }
    const existing = await QosAssignment.query()
      .where('source', 'portal')
      .where('sourceRef', entry.sourceRef)
      .first()
    let quota: { limitBytes: number; onExhausted: 'block' } | undefined
    if (existing && existing.quotaBytes !== null && existing.gatewayId === gatewayId) {
      // Keep the quota the assignment counts against (see above).
      quota = { limitBytes: Number(existing.quotaBytes), onExhausted: 'block' }
    } else if (entry.quotaBytes !== null && entry.quotaBytes > 0) {
      quota = { limitBytes: entry.quotaBytes, onExhausted: 'block' }
    }
    const hasRate = entry.downKbps !== null || entry.upKbps !== null
    if (!hasRate && !quota) {
      // Nothing left to shape (e.g. a quota already used up: the router ends it).
      await releaseDevice(entry.sourceRef)
      return
    }
    await shapeDevice({
      gatewayId,
      mac: entry.mac,
      rate: hasRate ? { downloadKbit: entry.downKbps, uploadKbit: entry.upKbps } : undefined,
      quota,
      expiresAt: expiresAt ?? undefined,
      source: 'portal',
      sourceRef: entry.sourceRef,
    })
  }
}

/** `portal-grant:<id>` → id. */
function grantIdOf(sourceRef: string | null): number | null {
  const m = sourceRef ? /^portal-grant:(\d+)$/.exec(sourceRef) : null
  return m ? Number(m[1]) : null
}

/**
 * One listener for the whole process: qos_live's listener set ignores a
 * second add of the same function (so this subscribes on qos_live directly,
 * not through qos_shaping's wrapper).
 */
function onPortalQuotaExhausted(event: {
  collectorId: number
  mac: string
  sourceRef: string | null
  at: string
}): void {
  if (!event.sourceRef || !PORTAL_REF.test(event.sourceRef)) return
  const sourceRef = event.sourceRef
  void (async () => {
    const gateway = await Gateway.findBy('collectorId', event.collectorId)
    if (!gateway) return
    await db.table('portal_events').insert({
      gateway_id: gateway.id,
      portal_id: null,
      grant_id: grantIdOf(sourceRef),
      mac: event.mac,
      type: 'shaping_quota_exhausted',
      detail: JSON.stringify({ sourceRef, at: event.at }),
      created_at: DateTime.utc().toSQL({ includeOffset: false }),
    })
  })().catch((error) =>
    logger.warn({ err: error, sourceRef }, 'portal_qos_shaping: event not kept')
  )
}

/**
 * Records the shaper's quota exhaustion of portal devices in the portal's
 * event log. Idempotent; returns the unsubscribe.
 */
export function watchPortalQuotaExhaustion(): () => void {
  return onQuotaExhausted(onPortalQuotaExhausted)
}
