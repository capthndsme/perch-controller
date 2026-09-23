import { InfraNodeSchema } from '#database/schema'

/**
 * What a device on the network map is (docs/infrastructure-view.md section
 * 6.2). Plain string column, union enforced in the app layer (house style,
 * like `users.role`). Append-only: stored rows keep their kind.
 */
export const INFRA_NODE_KINDS = [
  'gateway',
  'access_point',
  'switch',
  'router',
  'modem',
  'isp',
  'host',
  'device',
] as const
export type InfraNodeKind = (typeof INFRA_NODE_KINDS)[number]

/** Every kind but `gateway`: the root is the Gateway agent's, a second router is a `router`. */
export const MANUAL_INFRA_NODE_KINDS = INFRA_NODE_KINDS.filter(
  (kind): kind is Exclude<InfraNodeKind, 'gateway'> => kind !== 'gateway'
)

/** `agent` once the node has ever been bound to an agent row (amendment A2). */
export const INFRA_NODE_ORIGINS = ['agent', 'manual'] as const
export type InfraNodeOrigin = (typeof INFRA_NODE_ORIGINS)[number]

/**
 * One device on the network map: bound to the agent row it stands for
 * (`collectorId`: the Gateway agent, `apId`: an access point), or drawn by
 * the operator. The services in `app/services/infra_topology.ts` and
 * `infra_ports.ts` read and write these rows with explicit UTC times.
 */
export default class InfraNode extends InfraNodeSchema {}
