import type { WanQueueRecord } from '#services/qos_wan_queues'
import { BaseTransformer } from '@adonisjs/core/transformers'

/**
 * `QosWanQueue` (docs/gateway/qos.md section 5): the typed view of a queue
 * (`sqm_mapping.ts`), its full UCI option map, where it came from, flags,
 * the sync state and live counters (null until the live ingest, WP-D).
 *
 * Readable by every signed-in user (owner decision 16: operators see every
 * cap); the options carry no secrets (sqm has none).
 *
 * `pausedByRouter` (owner decision 15) is set while the router holds the
 * queue off (`sqm enabled=0` on the router after it was on): a safety
 * pause Authoritative Mode never reverts; the dashboard shows it loudly.
 */
export default class QosWanQueueTransformer extends BaseTransformer<WanQueueRecord> {
  toObject() {
    const { queue, view, sync } = this.resource
    return {
      id: queue.id,
      gatewayId: this.resource.gatewayId,
      collectorId: this.resource.collectorId,
      device: view.device,
      enabled: view.enabled,
      downloadKbit: view.downloadKbit,
      uploadKbit: view.uploadKbit,
      qdisc: view.qdisc,
      script: view.script,
      diffserv: view.diffserv,
      fairness: view.fairness,
      nat: view.nat,
      linkLayer: view.linkLayer,
      overhead: view.overhead,
      mpu: view.mpu,
      ingressEcn: view.ingressEcn,
      egressEcn: view.egressEcn,
      squashDscp: view.squashDscp,
      squashIngress: view.squashIngress,
      options: queue.options,
      uciSection: queue.uciSection,
      perchId: queue.perchId,
      origin: queue.origin === 'controller' ? 'controller' : 'router',
      flags: view.flags,
      pausedByRouter: queue.routerPausedAt ? { at: queue.routerPausedAt.toUTC().toISO() } : null,
      sync,
      live: null,
      routerUpdatedAt: queue.routerUpdatedAt ? queue.routerUpdatedAt.toUTC().toISO() : null,
      updatedAt: (queue.updatedAt ?? queue.createdAt).toUTC().toISO(),
    }
  }
}
