import type { ConditionInput, DetectorContext } from '#services/alerts/model'
import { registerDetector } from '#services/alerts/registry'
import {
  liveAlerts,
  liveCollectorIds,
  loadCollectorLiveness,
} from '#services/alerts/detectors/liveness'
import { ddnsOverview, type DdnsServiceView } from '#services/gateway_config/ddns_service'
import {
  wireguardOverview,
  type WgInterfaceView,
  type WgPeerView,
} from '#services/gateway_config/wireguard_service'
import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'

/**
 * Detector `gateway_sync` (design gateway-sync README 14), every 60 s, per
 * gateway whose collector is adopted, enabled and not silent (a silent one
 * says nothing about its services; its live alerts are left as they are).
 * Reads the same views the Internet and VPN pages show:
 *
 * - `gateway.ddns.update_failed`: an enabled DDNS service whose last run
 *   left an error.
 * - `gateway.ddns.ip_mismatch`: the address the name has is not the WAN's
 *   (the catalogue's 20-minute hold makes that "longer than two checks").
 * - `gateway.wireguard.peer_stale`: a peer that has shaken hands before and
 *   not within `wgPeerStaleMinutes` (Settings → Gateway sync). A disabled
 *   interface's peers clear.
 *
 * Unknown (no report for the service or peer) leaves a live alert as it is.
 */

export const DDNS_FAILED_TYPE = 'gateway.ddns.update_failed'
export const DDNS_MISMATCH_TYPE = 'gateway.ddns.ip_mismatch'
export const WG_STALE_TYPE = 'gateway.wireguard.peer_stale'
const TYPES = [DDNS_FAILED_TYPE, DDNS_MISMATCH_TYPE, WG_STALE_TYPE]
const SOURCE = 'detector:gateway_sync'

/** true = holds, false = clears, null = unknown. */
export type Verdict = boolean | null

export function ddnsVerdicts(service: DdnsServiceView): { failing: Verdict; mismatch: Verdict } {
  if (!service.enabled) return { failing: false, mismatch: false }
  if (!service.live) return { failing: null, mismatch: null }
  return {
    failing: Boolean(service.live.lastError?.trim()),
    mismatch: service.live.matches === null ? null : !service.live.matches,
  }
}

export function peerSilent(iface: Pick<WgInterfaceView, 'enabled'>, peer: WgPeerView): Verdict {
  if (!iface.enabled) return false
  // No report, or no handshake since the router (re)started: nothing to compare.
  if (!peer.live?.latestHandshakeAt) return null
  return !peer.live.online
}

type Live = ReadonlyMap<string, unknown>

function condition(
  type: string,
  gatewayId: number,
  ref: string,
  verdict: Verdict,
  live: Live,
  payload: () => Record<string, unknown>
): ConditionInput | null {
  const dedupeKey = `${type}:${gatewayId}:${ref}`
  if (verdict === false || (verdict === null && !live.has(dedupeKey))) return null
  return {
    type,
    subject: { kind: 'gateway', id: gatewayId },
    dedupeKey,
    source: SOURCE,
    ...(verdict === true && { payload: payload() }),
  }
}

export function ddnsConditions(
  gatewayId: number,
  services: DdnsServiceView[],
  live: Live
): { failing: ConditionInput[]; mismatch: ConditionInput[] } {
  const failing: ConditionInput[] = []
  const mismatch: ConditionInput[] = []
  for (const s of services) {
    const verdict = ddnsVerdicts(s)
    const base = { gatewayId, service: s.name, domain: s.domain }
    const f = condition(DDNS_FAILED_TYPE, gatewayId, s.id, verdict.failing, live, () => ({
      ...base,
      error: (s.live?.lastError ?? '').slice(0, 200),
      lastUpdateAt: s.live?.lastUpdateAt ?? null,
    }))
    if (f) failing.push(f)
    const m = condition(DDNS_MISMATCH_TYPE, gatewayId, s.id, verdict.mismatch, live, () => ({
      ...base,
      registered: s.live?.registeredIp ?? null,
      wanIp: s.live?.wanIp ?? null,
    }))
    if (m) mismatch.push(m)
  }
  return { failing, mismatch }
}

export function wireguardConditions(
  gatewayId: number,
  interfaces: WgInterfaceView[],
  live: Live
): ConditionInput[] {
  const out: ConditionInput[] = []
  for (const iface of interfaces) {
    for (const peer of iface.peers) {
      const c = condition(WG_STALE_TYPE, gatewayId, peer.id, peerSilent(iface, peer), live, () => ({
        gatewayId,
        interface: iface.network,
        peerId: peer.id,
        label: peer.label ?? `${peer.publicKey.slice(0, 8)}…`,
        lastHandshakeAt: peer.live?.latestHandshakeAt ?? null,
      }))
      if (c) out.push(c)
    }
  }
  return out
}

export async function runGatewaySyncDetector(ctx: DetectorContext): Promise<void> {
  const [gateways, collectors, live] = await Promise.all([
    db.from('gateways').select('id', 'collector_id') as Promise<
      Array<{ id: number; collector_id: number | null }>
    >,
    loadCollectorLiveness(),
    liveAlerts(TYPES),
  ])
  const liveCollectors = liveCollectorIds(collectors)
  for (const g of gateways) {
    const gatewayId = Number(g.id)
    if (g.collector_id === null || !liveCollectors.has(Number(g.collector_id))) continue
    try {
      const [ddns, wireguard] = await Promise.all([
        ddnsOverview(gatewayId),
        wireguardOverview(gatewayId),
      ])
      const d = ddnsConditions(gatewayId, ddns.services, live)
      const w = wireguardConditions(gatewayId, wireguard.interfaces, live)
      await ctx.reconcile([DDNS_FAILED_TYPE], d.failing, {
        scope: `${DDNS_FAILED_TYPE}:${gatewayId}:`,
      })
      await ctx.reconcile([DDNS_MISMATCH_TYPE], d.mismatch, {
        scope: `${DDNS_MISMATCH_TYPE}:${gatewayId}:`,
      })
      await ctx.reconcile([WG_STALE_TYPE], w, { scope: `${WG_STALE_TYPE}:${gatewayId}:` })
    } catch (error) {
      // An unreadable gateway leaves its alerts as they are.
      logger.warn({ gatewayId, err: error }, 'alerts: gateway_sync detector skipped a gateway')
    }
  }
}

registerDetector({
  id: 'gateway_sync',
  everySeconds: 60,
  types: TYPES,
  run: runGatewaySyncDetector,
})
