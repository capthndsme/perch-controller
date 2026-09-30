import type { Category, Severity } from '#services/alerts/model'
import { CATEGORIES, SEVERITIES, SEVERITY_RANK } from '#services/alerts/model'

/**
 * Destination filters (docs/design/alerts/api.md §2 `Filters`): which alerts a
 * push device or a webhook receives. Stored as JSON on the destination row;
 * normalised on read like the settings (invalid fields read as the default).
 */
export type Filters = {
  minSeverity: Severity
  /** null = all */
  categories: Category[] | null
  /** null = all */
  types: string[] | null
  quietHours: 'inherit' | 'ignore'
}

/** Push devices: warning and critical, quiet hours apply (owner decision A3). */
export const PUSH_FILTER_DEFAULTS: Readonly<Filters> = Object.freeze({
  minSeverity: 'warning',
  categories: null,
  types: null,
  quietHours: 'inherit',
})

/** Webhooks: everything; automations (standard, Home Assistant) ignore quiet hours. */
export function webhookFilterDefaults(format: string, preset?: string | null): Filters {
  const automation = format === 'standard' || preset === 'homeassistant'
  return {
    minSeverity: 'info',
    categories: null,
    types: null,
    quietHours: automation ? 'ignore' : 'inherit',
  }
}

export function normalizeFilters(value: unknown, defaults: Readonly<Filters>): Filters {
  const v =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const minSeverity = (SEVERITIES as readonly string[]).includes(v.minSeverity as string)
    ? (v.minSeverity as Severity)
    : defaults.minSeverity
  let categories = defaults.categories
  if (v.categories === null) categories = null
  else if (Array.isArray(v.categories)) {
    categories = v.categories.filter((c): c is Category =>
      (CATEGORIES as readonly string[]).includes(c as string)
    )
  }
  let types = defaults.types
  if (v.types === null) types = null
  else if (Array.isArray(v.types)) {
    types = v.types
      .filter((t): t is string => typeof t === 'string' && t.length > 0 && t.length <= 64)
      .slice(0, 100)
  }
  const quietHours =
    v.quietHours === 'inherit' || v.quietHours === 'ignore' ? v.quietHours : defaults.quietHours
  return { minSeverity, categories, types, quietHours }
}

/** Partial update of stored filters (PATCH bodies). */
export function mergeFilters(
  current: unknown,
  patch: Partial<Filters> | undefined,
  defaults: Readonly<Filters>
): Filters {
  return normalizeFilters({ ...normalizeFilters(current, defaults), ...(patch ?? {}) }, defaults)
}

export function filterMatches(
  filters: Filters,
  alert: { severity: Severity; category: string; type: string }
): boolean {
  if (SEVERITY_RANK[alert.severity] < SEVERITY_RANK[filters.minSeverity]) return false
  if (filters.categories && !filters.categories.includes(alert.category as Category)) return false
  if (filters.types && !filters.types.includes(alert.type)) return false
  return true
}
