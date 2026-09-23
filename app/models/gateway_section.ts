import { GatewaySectionSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'
import type {
  RouterAuthor,
  SectionConflict,
  SectionContent,
  SectionOwnership,
} from '#services/gateway_config/types'

/**
 * One UCI section on a gateway (docs/gateway/config-plane.md sections 2, 5
 * and 9). For synced sections: B (`baseContent`), R (`routerContent`) and C
 * (`desiredContent`), canonical `SectionContent` or null for "absent". The
 * pure merge over them is `app/services/gateway_config/sync_engine.ts`;
 * `toSectionState` there turns a row into the engine's input.
 */
export default class GatewaySection extends GatewaySectionSchema {
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
