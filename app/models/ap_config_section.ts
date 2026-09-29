import { ApConfigSectionSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'
import type {
  RouterAuthor,
  SectionConflict,
  SectionContent,
  SectionOwnership,
} from '#services/gateway_config/types'

/**
 * One UCI section of an AP's `wireless` or `network` config (docs/design/wifi
 * controller.md section 2; the `GatewaySection` model with `apId`). For
 * synced sections B (`baseContent`), R (`routerContent`) and C
 * (`desiredContent`); the merge over them is the gateway core's
 * `sync_engine.ts`.
 */
export default class ApConfigSection extends ApConfigSectionSchema {
  /** Null = Perch owns the whole section. */
  @jsonColumn('ownership')
  declare ownership: SectionOwnership | null

  @jsonColumn('base_content')
  declare baseContent: SectionContent | null

  @jsonColumn('router_content')
  declare routerContent: SectionContent | null

  @jsonColumn('router_author')
  declare routerAuthor: RouterAuthor | null

  @jsonColumn('desired_content')
  declare desiredContent: SectionContent | null

  @jsonColumn('conflict')
  declare conflict: SectionConflict | null
}
