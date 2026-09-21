import type Collector from '#models/collector'
import { BaseTransformer } from '@adonisjs/core/transformers'

/**
 * Deliberately thin wire shape for `GET /api/v1/collectors`, the endpoint any
 * signed-in user (not just an admin) may call to populate a collector
 * selector.
 *
 * No `baseUrl`, no fingerprint, no `hasApiKey`, no status detail: an
 * operator-role user has no business knowing the collector's address or
 * anything about its key. `ok` is the single bit of health they need to grey
 * out a dead collector in a dropdown.
 */
export default class CollectorSummaryTransformer extends BaseTransformer<Collector> {
  toObject() {
    return {
      id: this.resource.id,
      name: this.resource.name,
      hostname: this.resource.hostname,
      captureInterface: this.resource.captureInterface,
      enabled: Boolean(this.resource.enabled),
      lastSeenAt: this.resource.lastSeenAt,
      ok: this.resource.lastStatus?.ok ?? null,
    }
  }
}
