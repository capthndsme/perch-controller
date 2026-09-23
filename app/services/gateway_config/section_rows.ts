import type GatewaySection from '#models/gateway_section'
import type { SectionState } from '#services/gateway_config/sync_engine'
import {
  SECTION_ISSUES,
  SECTION_SCOPES,
  SECTION_STATUSES,
  type SectionIssue,
  type SectionScope,
  type SectionStatus,
} from '#services/gateway_config/types'
import { DateTime } from 'luxon'

/**
 * The bridge between `gateway_sections` rows and the pure engine's
 * `SectionState`. Unknown union values (a row written by a newer build)
 * read as the safest value: scope `unmodeled`, status `in_sync`, no issue.
 */

export function toSectionState(row: GatewaySection): SectionState {
  const scope = (SECTION_SCOPES as readonly string[]).includes(row.scope)
    ? (row.scope as SectionScope)
    : 'unmodeled'
  const status = (SECTION_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as SectionStatus)
    : 'in_sync'
  const issue =
    row.issue && (SECTION_ISSUES as readonly string[]).includes(row.issue)
      ? (row.issue as SectionIssue)
      : null
  return {
    perchId: row.perchId,
    config: row.config,
    name: row.sectionName,
    type: row.sectionType,
    anonymous: Boolean(row.anonymous),
    scope,
    domain: row.domain,
    ownership: row.ownership && row.ownership.kind === 'options' ? row.ownership : null,
    issue,
    base: row.baseContent,
    baseRevision: row.baseRevision ?? null,
    router: row.routerContent,
    desired: row.desiredContent,
    status,
    conflict: row.conflict,
    driftSince: row.driftSince ? row.driftSince.toUTC().toISO() : null,
    position: row.position ?? null,
  }
}

/**
 * Copies a state onto a row (new or loaded) for saving; the caller sets
 * `gatewayId`, `routerAuthor`, `routerChangedAt` and
 * `updatedByUserId` as the occasion needs.
 */
export function applyStateToRow(row: GatewaySection, state: SectionState): GatewaySection {
  row.perchId = state.perchId
  row.config = state.config
  row.sectionName = state.name
  row.sectionType = state.desired?.type ?? state.router?.type ?? state.base?.type ?? state.type
  row.anonymous = state.anonymous
  row.scope = state.scope
  row.domain = state.domain
  row.ownership = state.ownership
  row.issue = state.issue
  row.baseContent = state.base
  row.baseRevision = state.baseRevision
  row.routerContent = state.router
  row.desiredContent = state.desired
  row.status = state.status
  row.conflict = state.conflict
  row.driftSince = state.driftSince ? DateTime.fromISO(state.driftSince, { zone: 'utc' }) : null
  row.position = state.position
  return row
}
