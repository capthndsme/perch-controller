import vine from '@vinejs/vine'

/**
 * Request bodies of gateway sync Phase C (docs/design/gateway-sync/rest.md
 * 4, 5, 8, 9): DDNS, UPnP, WireGuard and IPv6. Only the input's shape here;
 * refusals that need the gateway's state are the services'.
 */

const ddnsFields = {
  enabled: vine.boolean().optional(),
  provider: vine.string().trim().maxLength(128).nullable().optional(),
  updateUrl: vine.string().trim().maxLength(1024).nullable().optional(),
  lookupHost: vine.string().trim().maxLength(253).nullable().optional(),
  username: vine.string().maxLength(256).nullable().optional(),
  password: vine.string().maxLength(512).nullable().optional(),
  ipSource: vine.enum(['network', 'web'] as const).optional(),
  ipNetwork: vine.string().trim().maxLength(32).nullable().optional(),
  useIpv6: vine.boolean().optional(),
  useHttps: vine.boolean().optional(),
  checkIntervalMinutes: vine.number().withoutDecimals().min(1).max(10_080).optional(),
  forceIntervalHours: vine.number().withoutDecimals().min(0).max(8760).optional(),
}

/** `POST /gateways/:id/ddns/services` (rest.md 9). */
export const ddnsServiceCreateValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(32),
    domain: vine.string().trim().minLength(1).maxLength(253),
    ...ddnsFields,
  })
)

/** `PATCH /gateways/:id/ddns/services/:perchId` (rest.md 9; no `name`). */
export const ddnsServicePatchValidator = vine.compile(
  vine.object({
    domain: vine.string().trim().minLength(1).maxLength(253).optional(),
    ...ddnsFields,
  })
)

/** `PATCH /gateways/:id/upnp/config` (rest.md 8). */
export const upnpConfigPatchValidator = vine.compile(
  vine.object({
    enabled: vine.boolean().optional(),
    upnp: vine.boolean().optional(),
    natpmp: vine.boolean().optional(),
    secureMode: vine.boolean().optional(),
    internalInterfaces: vine
      .array(vine.string().trim().minLength(1).maxLength(32))
      .maxLength(16)
      .optional(),
  })
)

/** Fresh schema nodes per use (one node is never shared by two compiled validators). */
const upnpRuleFields = {
  extPorts: () => vine.string().trim().maxLength(11),
  intAddr: () => vine.string().trim().maxLength(18),
  deviceMac: () => vine.string().trim().maxLength(17),
  intPorts: () => vine.string().trim().maxLength(11),
  comment: () => vine.string().trim().maxLength(128).nullable(),
}

/** `POST /gateways/:id/upnp/acl` (rest.md 8): `intAddr` or `deviceMac`. */
export const upnpAclCreateValidator = vine.compile(
  vine.object({
    action: vine.enum(['allow', 'deny'] as const),
    extPorts: upnpRuleFields.extPorts(),
    intAddr: upnpRuleFields.intAddr().optional().requiredIfMissing('deviceMac'),
    deviceMac: upnpRuleFields.deviceMac().optional(),
    intPorts: upnpRuleFields.intPorts(),
    comment: upnpRuleFields.comment().optional(),
    placement: vine.enum(['top', 'bottom'] as const).optional(),
  })
)

/** `PATCH /gateways/:id/upnp/acl/:perchId` (rest.md 8). */
export const upnpAclPatchValidator = vine.compile(
  vine.object({
    action: vine.enum(['allow', 'deny'] as const).optional(),
    extPorts: upnpRuleFields.extPorts().optional(),
    intAddr: upnpRuleFields.intAddr().optional(),
    deviceMac: upnpRuleFields.deviceMac().optional(),
    intPorts: upnpRuleFields.intPorts().optional(),
    comment: upnpRuleFields.comment().optional(),
  })
)

/** `PUT /gateways/:id/upnp/acl/order` (rest.md 8). */
export const upnpAclOrderValidator = vine.compile(
  vine.object({ ids: vine.array(vine.string().trim().minLength(1).maxLength(24)).maxLength(256) })
)

/** `POST /gateways/:id/upnp/mappings/delete` (rest.md 8): 1–64 mappings. */
export const upnpMappingsDeleteValidator = vine.compile(
  vine.object({
    mappings: vine
      .array(
        vine.object({
          proto: vine.enum(['TCP', 'UDP'] as const),
          externalPort: vine.number().withoutDecimals().min(1).max(65535),
        })
      )
      .minLength(1)
      .maxLength(64),
  })
)

/** `PUT /gateways/:id/upnp/devices/:mac` (rest.md 8). */
export const upnpDeviceBlockValidator = vine.compile(vine.object({ blocked: vine.boolean() }))

const wgAddresses = () =>
  vine.array(vine.string().trim().minLength(3).maxLength(49)).minLength(1).maxLength(8)
const wgEndpoint = () =>
  vine.object({
    host: vine.string().trim().minLength(1).maxLength(253),
    port: vine.number().withoutDecimals().min(1).max(65535),
  })

/** `POST /gateways/:id/wireguard/interfaces` (rest.md 4). */
export const wgInterfaceCreateValidator = vine.compile(
  vine.object({
    network: vine.string().trim().minLength(1).maxLength(15),
    role: vine.enum(['server', 'client'] as const),
    listenPort: vine.number().withoutDecimals().min(1).max(65535).optional(),
    addresses: wgAddresses(),
    mtu: vine.number().withoutDecimals().min(1280).max(9000).optional(),
    zone: vine.string().trim().minLength(1).maxLength(32).nullable().optional(),
    createZone: vine.boolean().optional(),
    openPort: vine.boolean().optional(),
    privateKey: vine.string().trim().maxLength(64).optional(),
    currentPassword: vine.string().maxLength(256).optional(),
  })
)

/** `PATCH /gateways/:id/wireguard/interfaces/:perchId` (rest.md 4). */
export const wgInterfacePatchValidator = vine.compile(
  vine.object({
    enabled: vine.boolean().optional(),
    listenPort: vine.number().withoutDecimals().min(1).max(65535).nullable().optional(),
    addresses: wgAddresses().optional(),
    mtu: vine.number().withoutDecimals().min(1280).max(9000).nullable().optional(),
    openPort: vine.boolean().optional(),
  })
)

/** `DELETE /gateways/:id/wireguard/interfaces/:perchId` (the network's name). */
export const wgConfirmValidator = vine.compile(
  vine.object({ confirm: vine.string().trim().minLength(1).maxLength(32) })
)

/** `POST /gateways/:id/wireguard/interfaces/:perchId/rotate-key` (rest.md 4). */
export const wgRotateValidator = vine.compile(
  vine.object({
    confirm: vine.string().trim().minLength(1).maxLength(32),
    currentPassword: vine.string().maxLength(256).optional(),
  })
)

/** `POST /gateways/:id/wireguard/interfaces/:perchId/peers` (rest.md 4). */
export const wgPeerCreateValidator = vine.compile(
  vine.object({
    label: vine.string().trim().minLength(1).maxLength(64),
    publicKey: vine.string().trim().maxLength(64).optional(),
    generateKeys: vine.boolean().optional(),
    presharedKey: vine.enum(['generate', 'none'] as const).optional(),
    allowedIps: vine
      .array(vine.string().trim().minLength(3).maxLength(49))
      .minLength(1)
      .maxLength(32)
      .optional(),
    endpoint: wgEndpoint().optional(),
    keepalive: vine.number().withoutDecimals().min(1).max(65535).optional(),
    routeAllowedIps: vine.boolean().optional(),
    deviceMac: vine.string().trim().maxLength(17).optional(),
    client: vine
      .object({
        dns: vine.array(vine.string().trim().minLength(2).maxLength(45)).maxLength(4).optional(),
        allowedIps: vine
          .array(vine.string().trim().minLength(3).maxLength(49))
          .maxLength(32)
          .optional(),
        endpointHost: vine.string().trim().minLength(1).maxLength(253).optional(),
      })
      .optional(),
    currentPassword: vine.string().maxLength(256).optional(),
  })
)

/** `PATCH /gateways/:id/wireguard/peers/:perchId` (rest.md 4). */
export const wgPeerPatchValidator = vine.compile(
  vine.object({
    label: vine.string().trim().minLength(1).maxLength(64).optional(),
    allowedIps: vine
      .array(vine.string().trim().minLength(3).maxLength(49))
      .minLength(1)
      .maxLength(32)
      .optional(),
    endpoint: wgEndpoint().nullable().optional(),
    keepalive: vine.number().withoutDecimals().min(1).max(65535).nullable().optional(),
    routeAllowedIps: vine.boolean().optional(),
    deviceMac: vine.string().trim().maxLength(17).nullable().optional(),
  })
)
