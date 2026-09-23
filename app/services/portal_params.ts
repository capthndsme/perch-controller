import { PortalError } from '#services/portal_errors'

/** An ISO 8601 time from a body or query string, or 422 `invalid_date`. */
export function parseIsoTime(value: string | null | undefined, field: string): Date | undefined {
  if (value === null || value === undefined || value === '') return undefined
  if (
    !/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value)
  ) {
    throw invalid(field, value)
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw invalid(field, value)
  return date
}

function invalid(field: string, value: string) {
  return new PortalError(422, 'invalid_date', `\`${field}\` is not an ISO 8601 time: "${value}".`, {
    field,
  })
}

/** `limit` (default 200, at most 1000) and `offset` (default 0). */
export function page(qs: { limit?: number; offset?: number }) {
  return { limit: qs.limit ?? 200, offset: qs.offset ?? 0 }
}

/** The first item a promise of a list resolves to. */
export async function firstOf<T>(items: Promise<T[]>): Promise<T> {
  const [first] = await items
  return first
}
