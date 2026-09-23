import { INFRA_LINK_MEDIA } from '#models/infra_link'
import { INFRA_NODE_KINDS } from '#models/infra_node'
import { INFRA_PORT_MEDIA, INFRA_PORT_ROLES } from '#models/infra_port'
import { PORT_KEY_REGEX, PORT_LABEL_MAX_LENGTH } from '#services/infra_ports'
import { FRAME_SIZE, INFRA_LIMITS, MAX_POSITION, MAX_SFP_PORTS } from '#services/infra_topology'
import vine from '@vinejs/vine'

/**
 * `/api/v1/infra/*` bodies (docs/infrastructure-view.md section 7). Shapes,
 * lengths and ranges only: what depends on the node's kind (a field it does
 * not have, its port count range) and on stored state (keys taken, cables,
 * parents) is refused by `app/services/infra_topology.ts` with the codes of
 * Appendix B. Nullable fields follow the device-label PATCH: an omitted key
 * keeps the stored value, `null` clears it.
 */

const MAC_INPUT_REGEX = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/

const id = () => vine.number().withoutDecimals().min(1)
const coordinate = () => vine.number().withoutDecimals().min(-MAX_POSITION).max(MAX_POSITION)
const frameSide = () => vine.number().withoutDecimals().min(FRAME_SIZE.min).max(FRAME_SIZE.max)
const portKey = () => vine.string().trim().regex(PORT_KEY_REGEX)

const position = () => vine.object({ x: coordinate(), y: coordinate() })
const size = () => vine.object({ width: frameSide(), height: frameSide() })

const portInput = () =>
  vine.object({
    key: portKey(),
    label: vine.string().trim().maxLength(PORT_LABEL_MAX_LENGTH).nullable().optional(),
    role: vine.enum(INFRA_PORT_ROLES).nullable().optional(),
    medium: vine.enum(INFRA_PORT_MEDIA).nullable().optional(),
    position: vine.number().withoutDecimals().min(0).max(65535).optional(),
  })

/**
 * `POST /api/v1/infra/nodes` (section 7.4, amendment A4). `name` may be left
 * out when `deviceMac` is set: the node then follows the device's name.
 * `linkTo` cables the new node's `ownPortKey` (default: its first port) to
 * `portId` in the same transaction.
 */
export const createInfraNodeValidator = vine.compile(
  vine.object({
    kind: vine.enum(INFRA_NODE_KINDS),
    name: vine.string().trim().minLength(1).maxLength(80).optional().requiredIfMissing('deviceMac'),
    virtual: vine.boolean().optional(),
    model: vine.string().trim().maxLength(80).nullable().optional(),
    notes: vine.string().trim().maxLength(500).nullable().optional(),
    deviceMac: vine.string().trim().regex(MAC_INPUT_REGEX).nullable().optional(),
    parentId: id().nullable().optional(),
    position: position().nullable().optional(),
    size: size().nullable().optional(),
    portCount: vine.number().withoutDecimals().min(0).max(INFRA_LIMITS.portsPerNode).optional(),
    sfpPorts: vine.number().withoutDecimals().min(0).max(MAX_SFP_PORTS).optional(),
    ports: vine.array(portInput()).maxLength(INFRA_LIMITS.portsPerNode).optional(),
    linkTo: vine
      .object({
        portId: id(),
        ownPortKey: portKey().optional(),
        medium: vine.enum(INFRA_LINK_MEDIA).optional(),
      })
      .optional(),
  })
)

/** `PATCH /api/v1/infra/nodes/:id` (section 7.5). */
export const updateInfraNodeValidator = vine.compile(
  vine.object({
    name: vine.string().trim().maxLength(80).nullable().optional(),
    model: vine.string().trim().maxLength(80).nullable().optional(),
    notes: vine.string().trim().maxLength(500).nullable().optional(),
    virtual: vine.boolean().optional(),
    deviceMac: vine.string().trim().regex(MAC_INPUT_REGEX).nullable().optional(),
    parentId: id().nullable().optional(),
    position: position().nullable().optional(),
    size: size().nullable().optional(),
    hidden: vine.boolean().optional(),
    portCount: vine.number().withoutDecimals().min(0).max(INFRA_LIMITS.portsPerNode).optional(),
  })
)

/** `POST /api/v1/infra/nodes/:id/bind` (section 7.7): exactly one of the two. */
export const bindInfraNodeValidator = vine.compile(
  vine.object({
    apId: id().optional().requiredIfMissing('collectorId'),
    collectorId: id().optional(),
  })
)

/** `POST /api/v1/infra/nodes/:id/ports` (section 7.8). */
export const addInfraPortsValidator = vine.compile(
  vine.object({
    ports: vine.array(portInput()).minLength(1).maxLength(INFRA_LIMITS.portsPerNode),
  })
)

/** `PATCH /api/v1/infra/ports/:id` (section 7.8). */
export const updateInfraPortValidator = vine.compile(
  vine.object({
    key: portKey().optional(),
    label: vine.string().trim().maxLength(PORT_LABEL_MAX_LENGTH).nullable().optional(),
    role: vine.enum(INFRA_PORT_ROLES).nullable().optional(),
    medium: vine.enum(INFRA_PORT_MEDIA).nullable().optional(),
    hidden: vine.boolean().optional(),
    position: vine.number().withoutDecimals().min(0).max(65535).optional(),
  })
)

/** `POST /api/v1/infra/links` (section 7.9). */
export const createInfraLinkValidator = vine.compile(
  vine.object({
    aPortId: id(),
    bPortId: id(),
    medium: vine.enum(INFRA_LINK_MEDIA).optional(),
    label: vine.string().trim().maxLength(48).nullable().optional(),
    notes: vine.string().trim().maxLength(500).nullable().optional(),
  })
)

/** `PATCH /api/v1/infra/links/:id` (section 7.9): move an end, edit the rest. */
export const updateInfraLinkValidator = vine.compile(
  vine.object({
    aPortId: id().optional(),
    bPortId: id().optional(),
    medium: vine.enum(INFRA_LINK_MEDIA).optional(),
    label: vine.string().trim().maxLength(48).nullable().optional(),
    notes: vine.string().trim().maxLength(500).nullable().optional(),
  })
)

/** `PUT /api/v1/infra/positions` (section 7.10): 1–200 entries. */
export const saveInfraPositionsValidator = vine.compile(
  vine.object({
    positions: vine
      .array(
        vine.object({
          nodeId: id(),
          x: coordinate(),
          y: coordinate(),
          parentId: id().nullable().optional(),
        })
      )
      .minLength(1)
      .maxLength(INFRA_LIMITS.nodes),
  })
)
