import vine from '@vinejs/vine'

/**
 * Request bodies of the firewall REST API (docs/gateway/firewall.md
 * section 6; plan 2 section 5). Values end up in UCI options, so text is
 * bounded and free of control characters; the service re-checks zones,
 * ports and the management path against the gateway's configuration.
 */

const ZONE = /^(\*|[A-Za-z0-9_]{1,32})$/
const PORT = /^\d{1,5}([-:]\d{1,5})?$/
const PORTS = /^\d{1,5}([-:]\d{1,5})?(\s+\d{1,5}([-:]\d{1,5})?){0,15}$/
// eslint-disable-next-line no-control-regex -- the point: no control characters in UCI values
const TEXT = /^[^\u0000-\u001f\u007f]*$/
const MAC = /^[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}$/
const ADDRESS = /^!?[0-9A-Fa-f:.]{2,45}(\/\d{1,3}|\/[0-9.]{7,15})?$/
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

const name = () => vine.string().trim().minLength(1).maxLength(64).regex(TEXT)
const zone = () => vine.string().trim().regex(ZONE)
const addresses = () => vine.array(vine.string().trim().regex(ADDRESS)).maxLength(32)
const macs = () => vine.array(vine.string().trim().regex(MAC)).maxLength(32)
const RULE_PROTOS = [
  'tcp',
  'udp',
  'icmp',
  'icmpv6',
  'all',
  'esp',
  'ah',
  'gre',
  'sctp',
  'udplite',
] as const

const portForwardFields = {
  proto: vine
    .array(vine.enum(['tcp', 'udp'] as const))
    .minLength(1)
    .maxLength(2),
  externalPort: vine.string().trim().regex(PORT),
  destIp: vine.string().trim().regex(IPV4),
  deviceMac: vine.string().trim().regex(MAC),
  destPort: vine.string().trim().regex(PORT).nullable(),
  reflection: vine.boolean(),
  enabled: vine.boolean(),
  srcZone: zone(),
  destZone: zone(),
  allowUnreserved: vine.boolean(),
}

/** `POST /gateways/:id/firewall/port-forwards` */
export const portForwardValidator = vine.compile(
  vine.object({
    name: name(),
    proto: portForwardFields.proto,
    externalPort: portForwardFields.externalPort,
    destIp: portForwardFields.destIp.optional(),
    deviceMac: portForwardFields.deviceMac.optional(),
    destPort: portForwardFields.destPort.optional(),
    reflection: portForwardFields.reflection.optional(),
    enabled: portForwardFields.enabled.optional(),
    srcZone: portForwardFields.srcZone.optional(),
    destZone: portForwardFields.destZone.optional(),
    allowUnreserved: portForwardFields.allowUnreserved.optional(),
  })
)

/** `PATCH /gateways/:id/firewall/port-forwards/:perchId` (every field optional). */
export const portForwardPatchValidator = vine.compile(
  vine.object({
    name: name().optional(),
    proto: vine
      .array(vine.enum(['tcp', 'udp'] as const))
      .minLength(1)
      .maxLength(2)
      .optional(),
    externalPort: vine.string().trim().regex(PORT).optional(),
    destIp: vine.string().trim().regex(IPV4).optional(),
    deviceMac: vine.string().trim().regex(MAC).optional(),
    destPort: vine.string().trim().regex(PORT).nullable().optional(),
    reflection: vine.boolean().optional(),
    enabled: vine.boolean().optional(),
    srcZone: zone().optional(),
    destZone: zone().optional(),
    allowUnreserved: vine.boolean().optional(),
  })
)

/**
 * `POST /gateways/:id/firewall/rules`. `src` is optional here so that an
 * output rule reaches the service's guard (422 `firewall_controller_path`
 * when it would cut the controller path, else `firewall_rule_unsupported`).
 */
export const firewallRuleValidator = vine.compile(
  vine.object({
    name: name(),
    src: zone().optional(),
    dest: zone().nullable().optional(),
    proto: vine.array(vine.enum(RULE_PROTOS)).maxLength(8).nullable().optional(),
    srcMac: macs().nullable().optional(),
    srcIp: addresses().nullable().optional(),
    destIp: addresses().nullable().optional(),
    destPort: vine.string().trim().regex(PORTS).nullable().optional(),
    target: vine.enum(['ACCEPT', 'REJECT', 'DROP'] as const),
    family: vine
      .enum(['ipv4', 'ipv6', 'any'] as const)
      .nullable()
      .optional(),
    enabled: vine.boolean().optional(),
    placement: vine.enum(['top', 'bottom'] as const).optional(),
  })
)

/** `PATCH /gateways/:id/firewall/rules/:perchId` */
export const firewallRulePatchValidator = vine.compile(
  vine.object({
    name: name().optional(),
    src: zone().optional(),
    dest: zone().nullable().optional(),
    proto: vine.array(vine.enum(RULE_PROTOS)).maxLength(8).nullable().optional(),
    srcMac: macs().nullable().optional(),
    srcIp: addresses().nullable().optional(),
    destIp: addresses().nullable().optional(),
    destPort: vine.string().trim().regex(PORTS).nullable().optional(),
    target: vine.enum(['ACCEPT', 'REJECT', 'DROP'] as const).optional(),
    family: vine
      .enum(['ipv4', 'ipv6', 'any'] as const)
      .nullable()
      .optional(),
    enabled: vine.boolean().optional(),
  })
)

/** `PUT /gateways/:id/firewall/rules/order`, `…/port-forwards/order` */
export const firewallOrderValidator = vine.compile(
  vine.object({
    ids: vine
      .array(
        vine
          .string()
          .trim()
          .regex(/^[a-z0-9_]{1,24}$/)
      )
      .minLength(1)
      .maxLength(2000),
  })
)

/** `POST /gateways/:id/firewall/order/resolve` */
export const firewallOrderResolveValidator = vine.compile(
  vine.object({
    type: vine.enum(['rule', 'redirect'] as const),
    take: vine.enum(['router', 'controller'] as const),
  })
)

/** `PUT /devices/:mac/wan-access` */
export const wanAccessValidator = vine.compile(
  vine.object({
    gatewayId: vine.number().withoutDecimals().min(1).optional(),
    blocked: vine.boolean(),
    note: vine.string().trim().maxLength(200).regex(TEXT).nullable().optional(),
  })
)
