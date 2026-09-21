import type Collector from '#models/collector'
import type { CollectorLifecycle, CollectorSource, CollectorTransport } from '#models/collector'
import collectorHub from '#services/collector_agent_hub'
import { BaseTransformer } from '@adonisjs/core/transformers'

/**
 * Serialiser for a `Collector` row that:
 *   - exposes everything except the encrypted api_key
 *   - replaces it with a boolean `hasApiKey` so a UI can show "key set" /
 *     "key unset" without ever shipping the secret across the wire
 *   - ships the key's fingerprint (first 8 hex chars of its sha256) so an
 *     admin can compare a pending collector against `uci get …api_key`
 *   - says how the collector reaches the server (`transport`), whether a
 *     socket collector is connected right now (`connection`, from the hub)
 *     and what it last reported about the gateway (`gateway`)
 *
 * Admin-only shape: it carries the pollable address. The non-admin selector
 * list uses `CollectorSummaryTransformer` instead.
 */
export default class CollectorTransformer extends BaseTransformer<Collector> {
  toObject() {
    const transport: CollectorTransport = this.resource.transport === 'agent' ? 'agent' : 'poll'
    const session = transport === 'agent' ? collectorHub.session(this.resource.id) : null
    const gateway = this.resource.lastStatus?.gateway ?? null
    return {
      id: this.resource.id,
      name: this.resource.name,
      baseUrl: this.resource.baseUrl ?? null,
      transport,
      hasApiKey: this.resource.apiKey !== null,
      apiKeyFingerprint: this.resource.apiKeyFingerprint,
      pollIntervalSeconds: this.resource.pollIntervalSeconds,
      // mysql2 hands tinyint(1) back as 0/1; the documented wire shape is a
      // real boolean, so coerce it here rather than in every consumer.
      enabled: Boolean(this.resource.enabled),
      source: this.resource.source as CollectorSource,
      lifecycle: this.resource.lifecycle as CollectorLifecycle,
      instanceId: this.resource.instanceId,
      hostname: this.resource.hostname,
      version: this.resource.version,
      captureInterface: this.resource.captureInterface,
      announcedBaseUrl: this.resource.announcedBaseUrl,
      lastAnnounceAt: this.resource.lastAnnounceAt,
      lastSeenAt: this.resource.lastSeenAt,
      lastStatus: this.resource.lastStatus,
      connection:
        transport === 'agent'
          ? {
              online: session !== null,
              connectedAt: session ? session.connectedAt.toISO() : null,
              address: session?.address ?? null,
            }
          : null,
      gateway: gateway
        ? {
            reportedAt: gateway.reportedAt,
            wanInterfaces: gateway.wanInterfaces ?? [],
            wanSource: gateway.wanSource,
          }
        : null,
      createdAt: this.resource.createdAt,
      updatedAt: this.resource.updatedAt,
    }
  }
}
