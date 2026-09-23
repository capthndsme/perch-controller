import type { WireGrant, WireGroup } from '#services/portal/crypto'
import { QosPortalShaping } from '#services/portal_qos_shaping'
import logger from '@adonisjs/core/services/logger'

/**
 * The portal's hook into traffic shaping (docs/gateway/portal.md section
 * 13.7; plan 3 section 7): voucher and grant speed caps (`downKbps` /
 * `upKbps`) and data quotas handed to the QoS engine as per-device
 * assignments, so the router caps them in the kernel.
 *
 * The default is `QosPortalShaping` (`portal_qos_shaping.ts`), the adapter
 * onto the QoS side's portal API (`qos_shaping.ts`: `shapeDevice` /
 * `releaseDevice` keyed by a `sourceRef`): `sync` diffs the gateway's portal
 * assignments by `sourceRef`, `apply` shapes and releases. Tests may install
 * another one (`setPortalShaping`, e.g. `NoopPortalShaping`).
 *
 * The portal never depends on shaping: every call is best effort, errors are
 * logged and swallowed (the router's own tick still ends a group at its
 * quota), and nothing waits for it inside a delivery.
 */

export type PortalShapingEntry = {
  /** `portal-grant:<id>`, or `portal-local:<portalId>:<localRef>` before the id is known. */
  sourceRef: string
  portalId: number
  mac: string
  downKbps: number | null
  upKbps: number | null
  /**
   * Bytes left for the device, as a hard in-kernel backstop. Only for
   * single-device groups: a shared quota cannot be split per device, so the
   * router's tick stays the only enforcement there.
   */
  quotaBytes: number | null
  /** Epoch ms deadline, or null. */
  expiresAt: number | null
}

export interface PortalShaping {
  /** The complete set of capped portal devices of the gateway (idempotent). */
  sync(gatewayId: number, entries: PortalShapingEntry[]): Promise<void>
  /** Changes after a delta: entries to create or update, sourceRefs to lift. */
  apply(gatewayId: number, upserts: PortalShapingEntry[], releases: string[]): Promise<void>
}

export class NoopPortalShaping implements PortalShaping {
  async sync(): Promise<void> {}
  async apply(): Promise<void> {}
}

let current: PortalShaping = new QosPortalShaping()

export function portalShaping(): PortalShaping {
  return current
}

/** Installs another implementation (the QoS adapter; tests). Returns the previous one. */
export function setPortalShaping(shaping: PortalShaping): PortalShaping {
  const previous = current
  current = shaping
  return previous
}

export function shapingSourceRef(grant: Pick<WireGrant, 'grantId' | 'localRef' | 'portalId'>) {
  return grant.grantId !== null
    ? `portal-grant:${grant.grantId}`
    : `portal-local:${grant.portalId}:${grant.localRef ?? ''}`
}

/**
 * Shaping entries of a set of wire grants and their groups: the grants whose
 * group has a speed cap or a quota. A single-device group's quota left is
 * `quotaBytes − base − the grant's own counters` (`liveBytes`, by sourceRef,
 * from the router's last report).
 */
export function shapingEntries(
  grants: readonly WireGrant[],
  groups: readonly WireGroup[],
  liveBytes: ReadonlyMap<string, number> = new Map()
): PortalShapingEntry[] {
  const byKey = new Map(groups.map((g) => [g.groupKey, g]))
  const out: PortalShapingEntry[] = []
  for (const g of grants) {
    const group = byKey.get(g.groupKey)
    if (!group) continue
    const quota =
      group.quotaBytes !== null && group.maxDevices === 1
        ? Math.max(
            0,
            group.quotaBytes - group.baseBytesUsed - (liveBytes.get(shapingSourceRef(g)) ?? 0)
          )
        : null
    if (group.downKbps === null && group.upKbps === null && quota === null) continue
    const deadlines = [group.expiresAt, g.expiresAt].filter((x): x is number => x !== null)
    out.push({
      sourceRef: shapingSourceRef(g),
      portalId: g.portalId,
      mac: g.mac,
      downKbps: group.downKbps,
      upKbps: group.upKbps,
      quotaBytes: quota,
      expiresAt: deadlines.length ? Math.min(...deadlines) : null,
    })
  }
  return out
}

/** Runs a shaping call without letting it fail the caller. */
export async function bestEffortShaping(
  gatewayId: number,
  run: (shaping: PortalShaping) => Promise<void>
): Promise<void> {
  try {
    await run(current)
  } catch (error) {
    logger.warn({ gatewayId, err: error }, 'portal_shaping: shaping update failed')
  }
}
