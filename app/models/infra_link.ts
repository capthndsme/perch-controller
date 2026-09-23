import { InfraLinkSchema } from '#database/schema'

export const INFRA_LINK_MEDIA = ['ethernet', 'fiber', 'virtual', 'wireless'] as const
export type InfraLinkMedium = (typeof INFRA_LINK_MEDIA)[number]

/**
 * One cable between two ports (docs/infrastructure-view.md section 6.4).
 * `aPortId` is always the smaller id; a port carries at most one link.
 */
export default class InfraLink extends InfraLinkSchema {}
