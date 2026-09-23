import { InfraPortSchema } from '#database/schema'

/** `agent`: reported by the node's agent; `manual`: added by the operator. */
export const INFRA_PORT_ORIGINS = ['agent', 'manual'] as const
export type InfraPortOrigin = (typeof INFRA_PORT_ORIGINS)[number]

export const INFRA_PORT_ROLES = ['wan', 'lan'] as const
export type InfraPortRole = (typeof INFRA_PORT_ROLES)[number]

export const INFRA_PORT_MEDIA = ['copper', 'sfp', 'virtual', 'wireless'] as const
export type InfraPortMedium = (typeof INFRA_PORT_MEDIA)[number]

/**
 * One Ethernet port of a node (docs/infrastructure-view.md section 3): the
 * latest state its agent reported, or a port the operator added by hand.
 * `label`, `role` and `medium` are the operator's overrides of the agent's
 * `reported_*` values (null = use the agent's).
 */
export default class InfraPort extends InfraPortSchema {}
