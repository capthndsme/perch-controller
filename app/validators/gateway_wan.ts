import vine from '@vinejs/vine'

/**
 * WAN request bodies (docs/design/gateway-sync/rest.md 3). Shapes only:
 * addresses, guards (`wan_last_uplink`, the management path) and the refusals
 * that need the router's state are the service's (`wan_service.ts`).
 */

const secretText = vine.string().maxLength(256)

const wanFields = {
  label: vine.string().trim().maxLength(80).optional(),
  enabled: vine.boolean().optional(),
  metric: vine.number().withoutDecimals().min(0).max(2147483647).optional(),
  defaultRoute: vine.boolean().optional(),
  dns: vine
    .object({
      useProvider: vine.boolean(),
      servers: vine.array(vine.string().trim().maxLength(45)).maxLength(8),
    })
    .optional(),
  static: vine
    .object({
      addresses: vine.array(vine.string().trim().maxLength(43)).minLength(1).maxLength(16),
      gateway: vine.string().trim().maxLength(45).nullable(),
      broadcast: vine.string().trim().maxLength(45).nullable().optional(),
    })
    .optional(),
  pppoe: vine
    .object({
      username: vine.string().trim().minLength(1).maxLength(128).optional(),
      password: secretText.nullable().optional(),
      service: vine.string().trim().maxLength(64).nullable().optional(),
      ac: vine.string().trim().maxLength(64).nullable().optional(),
      keepalive: vine.string().trim().maxLength(16).nullable().optional(),
    })
    .optional(),
  dhcp: vine
    .object({
      hostname: vine.string().trim().maxLength(253).nullable().optional(),
      clientId: vine.string().trim().maxLength(128).nullable().optional(),
      vendorId: vine.string().trim().maxLength(128).nullable().optional(),
    })
    .optional(),
  mobile: vine
    .object({
      apn: vine.string().trim().maxLength(64).nullable().optional(),
      pincode: vine.string().trim().maxLength(16).nullable().optional(),
    })
    .optional(),
  mtu: vine.number().withoutDecimals().nullable().optional(),
  mac: vine.string().trim().maxLength(17).nullable().optional(),
  ipv6: vine
    .object({
      mode: vine.enum(['off', 'auto', 'dhcpv6', 'relay'] as const),
      reqAddress: vine.enum(['try', 'force', 'none'] as const).optional(),
      // 'auto', 'no' or a prefix length (48–64): checked by the service.
      reqPrefix: vine.any().optional(),
    })
    .optional(),
  moveSqm: vine.boolean().optional(),
  checkTargets: vine.array(vine.string().trim().maxLength(45)).maxLength(8).nullable().optional(),
  confirm: vine.string().trim().maxLength(128).optional(),
}

/** `PATCH /gateways/:id/wan/:perchId` (rest.md 3 `WanPatch`). */
export const wanPatchValidator = vine.compile(
  vine.object({
    ...wanFields,
    proto: vine.enum(['dhcp', 'static', 'pppoe'] as const).optional(),
  })
)

/** `POST /gateways/:id/wan` (rest.md 3). */
export const wanCreateValidator = vine.compile(
  vine.object({
    ...wanFields,
    network: vine.string().trim().maxLength(15),
    device: vine.string().trim().maxLength(15),
    proto: vine.enum(['dhcp', 'static', 'pppoe'] as const),
    zone: vine.string().trim().maxLength(32).nullable().optional(),
    createZone: vine.boolean().optional(),
  })
)

/** `DELETE /gateways/:id/wan/:perchId`: the WAN's network name. */
export const wanDeleteValidator = vine.compile(
  vine.object({ confirm: vine.string().trim().maxLength(64) })
)

/** `PUT /gateways/:id/wan/order`. */
export const wanOrderValidator = vine.compile(
  vine.object({ ids: vine.array(vine.string().trim().maxLength(24)).minLength(1).maxLength(16) })
)

/** `POST /gateways/:id/wan/:perchId/aliases`. */
export const wanAliasCreateValidator = vine.compile(
  vine.object({
    network: vine.string().trim().maxLength(15),
    addresses: vine.array(vine.string().trim().maxLength(43)).minLength(1).maxLength(16),
    zone: vine.string().trim().maxLength(32).nullable().optional(),
  })
)

/** `PATCH /gateways/:id/wan/aliases/:perchId`. */
export const wanAliasPatchValidator = vine.compile(
  vine.object({
    addresses: vine.array(vine.string().trim().maxLength(43)).minLength(1).maxLength(16).optional(),
    zone: vine.string().trim().maxLength(32).nullable().optional(),
  })
)

/** `GET /gateways/:id/wan/history?range=&network=`. */
export const wanHistoryValidator = vine.compile(
  vine.object({
    range: vine.enum(['24h', '7d', '30d'] as const).optional(),
    network: vine.string().trim().maxLength(32).optional(),
  })
)

/** `PATCH /settings/gateway-sync` (rest.md 11): shapes; ranges are the service's (one limits table). */
export const gatewaySyncSettingsPatchValidator = vine.compile(
  vine.object({
    checkTargets: vine.array(vine.string().trim().maxLength(45)).maxLength(16).optional(),
    checkTcpPort: vine.number().withoutDecimals().optional(),
    checkResolveName: vine.string().trim().maxLength(253).optional(),
    checkTimeoutDhcpSeconds: vine.number().withoutDecimals().optional(),
    checkTimeoutStaticSeconds: vine.number().withoutDecimals().optional(),
    checkTimeoutPppoeSeconds: vine.number().withoutDecimals().optional(),
    checkTimeoutMobileSeconds: vine.number().withoutDecimals().optional(),
    checkTimeoutOtherSeconds: vine.number().withoutDecimals().optional(),
    wanConfirmTimeoutSeconds: vine.number().withoutDecimals().optional(),
    wanConfirmMode: vine.enum(['agent', 'admin_and_agent'] as const).optional(),
    authoritativeWan: vine.enum(['import', 'enforce'] as const).optional(),
    transitionRetentionDays: vine.number().withoutDecimals().optional(),
    wgPeerStaleMinutes: vine.number().withoutDecimals().optional(),
    wgStepUp: vine.boolean().optional(),
    upnpOpenedEvents: vine.boolean().optional(),
    multiWanWrites: vine.boolean().optional(),
    currentPassword: vine.string().maxLength(512).optional(),
  })
)
