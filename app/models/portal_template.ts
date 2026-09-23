import { PortalTemplateSchema } from '#database/schema'

/**
 * A set of portal page files (docs/gateway/portal.md section 9). `builtin`
 * rows are read-only; the seeded one has no files and stands for the pages
 * compiled into the collector.
 */
export default class PortalTemplate extends PortalTemplateSchema {}
