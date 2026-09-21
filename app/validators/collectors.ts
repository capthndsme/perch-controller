import vine from '@vinejs/vine'

/**
 * Daemon-generated identity: 32 hex chars today, but the shape is
 * deliberately loose so a UUID or a longer scheme later needs no server
 * release. Bounded on both ends so the column (varchar 64) always fits.
 */
export const INSTANCE_ID_REGEX = /^[A-Za-z0-9_-]{8,64}$/

/** First 8 hex chars of sha256(api_key). */
const FINGERPRINT_REGEX = /^[0-9a-f]{8}$/

/**
 * `POST /api/v1/collectors/announce` — the one unauthenticated endpoint.
 * Only `instanceId` and `port` are required; everything else is the
 * collector telling us about itself. `baseUrl` is what it *claims*; the
 * address the server will actually poll is derived from the TCP source
 * address of this request (docs/collector-management.md section 2.3).
 */
export const collectorAnnounceValidator = vine.compile(
  vine.object({
    instanceId: vine.string().trim().regex(INSTANCE_ID_REGEX),
    hostname: vine.string().trim().maxLength(255).optional(),
    version: vine.string().trim().maxLength(64).optional(),
    captureInterface: vine.string().trim().maxLength(64).optional(),
    port: vine.number().min(1).max(65535),
    tls: vine.boolean().optional(),
    baseUrl: vine.string().trim().url({ require_protocol: true }).maxLength(500).optional(),
    apiKey: vine.string().trim().minLength(8).maxLength(512).optional(),
    apiKeyFingerprint: vine.string().trim().regex(FINGERPRINT_REGEX).optional(),
  })
)

/**
 * `collector.hello`, the first frame on the collector socket
 * (docs/collector-agent.md section 3.2). The announce body, except that
 * `port`/`tls`/`baseUrl` are only present when the collector's HTTP API
 * answers on a non-loopback address, plus capabilities and a display-only
 * system description.
 */
export const collectorHelloValidator = vine.compile(
  vine.object({
    instanceId: vine.string().trim().regex(INSTANCE_ID_REGEX),
    hostname: vine.string().trim().maxLength(255).optional(),
    version: vine.string().trim().maxLength(64).optional(),
    captureInterface: vine.string().trim().maxLength(64).optional(),
    port: vine.number().min(1).max(65535).optional(),
    tls: vine.boolean().optional(),
    baseUrl: vine.string().trim().url({ require_protocol: true }).maxLength(500).optional(),
    apiKey: vine.string().trim().minLength(8).maxLength(512).optional(),
    apiKeyFingerprint: vine.string().trim().regex(FINGERPRINT_REGEX).optional(),
    capabilities: vine.array(vine.string().trim().maxLength(64)).maxLength(32).optional(),
    system: vine
      .object({
        os: vine.string().trim().maxLength(120).optional(),
        arch: vine.string().trim().maxLength(32).optional(),
        kernel: vine.string().trim().maxLength(120).optional(),
      })
      .allowUnknownProperties()
      .optional(),
  })
)

/**
 * `POST /api/v1/settings/collectors` — manual registration.
 *
 * Poll-interval bounds are the wizard's (`app/validators/setup.ts`): 5 s is
 * the practical minimum, 3600 s an arbitrary cap so a typo like 86400 cannot
 * silently disable collection for a day.
 *
 * The duplicate-address check deliberately does NOT use Vine's `unique`
 * rule: create and update must both answer with the documented
 * `collector_base_url_in_use` code, so `collector_registry.ts` owns it.
 */
export const collectorCreateValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(120),
    baseUrl: vine.string().trim().url({ require_protocol: true }).maxLength(500),
    apiKey: vine.string().trim().minLength(1).maxLength(512).nullable().optional(),
    pollIntervalSeconds: vine.number().min(5).max(3600).optional(),
    enabled: vine.boolean().optional(),
  })
)

/**
 * `PUT /api/v1/settings/collectors/:id` — partial.
 *
 * Every field optional. `apiKey: null` CLEARS the stored key; an omitted
 * `apiKey` keeps it — the same omitted-vs-null contract as
 * `app/validators/device_labels.ts`.
 */
export const collectorUpdateValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(120).optional(),
    baseUrl: vine.string().trim().url({ require_protocol: true }).maxLength(500).optional(),
    apiKey: vine.string().trim().minLength(1).maxLength(512).nullable().optional(),
    pollIntervalSeconds: vine.number().min(5).max(3600).optional(),
    enabled: vine.boolean().optional(),
  })
)

/** `POST /api/v1/settings/collectors/probe` — nothing is persisted. */
export const collectorProbeValidator = vine.compile(
  vine.object({
    baseUrl: vine.string().trim().url({ require_protocol: true }).maxLength(500),
    apiKey: vine.string().trim().minLength(1).maxLength(512).nullable().optional(),
  })
)

/**
 * `POST /api/v1/settings/collectors/:id/adopt`.
 *
 * `acceptKeyChange` overrides the fingerprint guard — a typo-catcher, not a
 * security boundary.
 */
export const collectorAdoptValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(120).optional(),
    apiKey: vine.string().trim().minLength(1).maxLength(512).nullable().optional(),
    pollIntervalSeconds: vine.number().min(5).max(3600).optional(),
    enabled: vine.boolean().optional(),
    acceptKeyChange: vine.boolean().optional(),
  })
)

/**
 * `PATCH /api/v1/settings/collectors/discovery` — the announce feature
 * switch (section 5.4 item 4). Backed by the `collector_announce_enabled`
 * system setting the announce service reads on every request, so a change
 * takes effect on the next announce with no restart.
 */
export const collectorDiscoveryValidator = vine.compile(
  vine.object({
    announceEnabled: vine.boolean(),
  })
)
