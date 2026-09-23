import vine from '@vinejs/vine'

/**
 * Request bodies of the native-sync REST API (docs/gateway/native-sync.md;
 * plan 2 section 5): DHCP pools, tags and reservations, DNS settings,
 * static routes and the system section. Values end up in UCI options, so
 * text is bounded and free of control characters and separators UCI or
 * dnsmasq would split on; the services re-check addresses, names and the
 * management path against the gateway's configuration.
 */

// eslint-disable-next-line no-control-regex -- the point: no control characters in UCI values
const TEXT = /^[^\u0000-\u001f\u007f']*$/
const ADDRESS = /^[0-9A-Fa-f:.]{2,45}$/
const HOSTISH = /^[A-Za-z0-9_.:-]{1,253}$/
const DOMAIN = /^[A-Za-z0-9_*.#/-]{0,253}$/
const LEASE = /^(\d{1,9}[smhdwSMHDW]?|infinite)$/
const IFACE = /^[A-Za-z0-9_.-]{1,32}$/
const TAG = /^[A-Za-z0-9_]{1,32}$/

const address = () => vine.string().trim().regex(ADDRESS)

const dhcpOptions = () =>
  vine.object({
    gateway: address().nullable().optional(),
    dnsServers: vine.array(address()).maxLength(8).nullable().optional(),
    ntpServers: vine.array(address()).maxLength(8).nullable().optional(),
    domain: vine.string().trim().maxLength(253).regex(DOMAIN).nullable().optional(),
    other: vine
      .array(
        vine.object({
          code: vine.number().withoutDecimals().min(1).max(254),
          value: vine.string().trim().minLength(1).maxLength(255).regex(TEXT),
        })
      )
      .maxLength(32)
      .nullable()
      .optional(),
  })

/** `PATCH /gateways/:id/dhcp/pools/:network` */
export const dhcpPoolPatchValidator = vine.compile(
  vine.object({
    enabled: vine.boolean().optional(),
    start: vine.number().withoutDecimals().min(1).max(65534).optional(),
    limit: vine.number().withoutDecimals().min(1).max(65534).optional(),
    leaseTime: vine.string().trim().regex(LEASE).optional(),
    force: vine.boolean().optional(),
    options: dhcpOptions().optional(),
    confirm: vine.string().trim().maxLength(32).optional(),
  })
)

/** `POST /gateways/:id/dhcp/tags` */
export const dhcpTagValidator = vine.compile(
  vine.object({
    name: vine.string().trim().regex(TAG),
    options: dhcpOptions().optional(),
    force: vine.boolean().optional(),
  })
)

/** `PATCH /gateways/:id/dhcp/tags/:perchId` */
export const dhcpTagPatchValidator = vine.compile(
  vine.object({
    options: dhcpOptions().optional(),
    force: vine.boolean().optional(),
  })
)

/** `PATCH /gateways/:id/dhcp/reservations/:perchId` */
export const dhcpReservationPatchValidator = vine.compile(
  vine.object({
    ip: address().nullable().optional(),
    hostname: vine.string().trim().maxLength(253).regex(HOSTISH).nullable().optional(),
    leaseTime: vine.string().trim().regex(LEASE).nullable().optional(),
    publishDns: vine.boolean().optional(),
    tags: vine.array(vine.string().trim().regex(TAG)).maxLength(16).optional(),
  })
)

const serverish = () =>
  vine
    .string()
    .trim()
    .maxLength(300)
    .regex(/^[A-Za-z0-9_.:#@/*-]*$/)

/** `PATCH /gateways/:id/dns`: the label-name policy and/or the resolver settings. */
export const dnsSettingsPatchValidator = vine.compile(
  vine.object({
    labelNames: vine.enum(['off', 'review'] as const).optional(),
    instance: vine
      .string()
      .trim()
      .regex(/^[a-z0-9]{1,32}$/)
      .optional(),
    domain: vine.string().trim().maxLength(253).regex(DOMAIN).nullable().optional(),
    local: vine.string().trim().maxLength(253).regex(DOMAIN).nullable().optional(),
    rebindProtection: vine.boolean().optional(),
    noresolv: vine.boolean().optional(),
    upstreams: vine.array(serverish()).maxLength(16).optional(),
    forwards: vine
      .array(
        vine.object({
          domain: vine.string().trim().minLength(1).maxLength(253).regex(DOMAIN),
          server: serverish().nullable(),
        })
      )
      .maxLength(64)
      .optional(),
    addresses: vine
      .array(
        vine.object({
          domain: vine.string().trim().minLength(1).maxLength(253).regex(DOMAIN),
          address: serverish().nullable(),
        })
      )
      .maxLength(64)
      .optional(),
    rebindDomains: vine
      .array(vine.string().trim().minLength(1).maxLength(253).regex(DOMAIN))
      .maxLength(64)
      .optional(),
  })
)

const routeFields = {
  interface: vine.string().trim().regex(IFACE).nullable(),
  target: vine
    .string()
    .trim()
    .maxLength(50)
    .regex(/^[0-9A-Fa-f:.]+(\/\d{1,3})?$/),
  gateway: address().nullable(),
  metric: vine.number().withoutDecimals().min(0).max(4294967295).nullable(),
  table: vine
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,32}$/)
    .nullable(),
  type: vine.enum([
    'unicast',
    'local',
    'broadcast',
    'multicast',
    'unreachable',
    'prohibit',
    'blackhole',
    'anycast',
    'throw',
  ] as const),
  enabled: vine.boolean(),
}

/** `POST /gateways/:id/routing/routes` */
export const routeValidator = vine.compile(
  vine.object({
    family: vine.enum([4, 6] as const).optional(),
    interface: routeFields.interface.optional(),
    target: routeFields.target,
    gateway: routeFields.gateway.optional(),
    metric: routeFields.metric.optional(),
    table: routeFields.table.optional(),
    type: routeFields.type.optional(),
    enabled: routeFields.enabled.optional(),
  })
)

/** `PATCH /gateways/:id/routing/routes/:perchId` */
export const routePatchValidator = vine.compile(
  vine.object({
    interface: routeFields.interface.optional(),
    target: routeFields.target.optional(),
    gateway: routeFields.gateway.optional(),
    metric: routeFields.metric.optional(),
    table: routeFields.table.optional(),
    type: routeFields.type.optional(),
    enabled: routeFields.enabled.optional(),
  })
)

/** `PATCH /gateways/:id/system` */
export const systemPatchValidator = vine.compile(
  vine.object({
    hostname: vine.string().trim().minLength(1).maxLength(63).optional(),
    timezone: vine
      .string()
      .trim()
      .maxLength(64)
      .regex(/^[A-Za-z0-9_+/-]{1,64}$/)
      .optional(),
    ntpEnabled: vine.boolean().optional(),
    ntpServe: vine.boolean().optional(),
    ntpServers: vine.array(vine.string().trim().regex(HOSTISH)).maxLength(8).optional(),
  })
)
