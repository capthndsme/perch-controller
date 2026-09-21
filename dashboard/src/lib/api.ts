/**
 * Empty (the default) means same-origin: the API serves the dashboard and
 * `/api/v1/...` resolves against the page origin. Set VITE_API_URL only for a
 * split deployment where the dashboard is hosted elsewhere.
 */
export const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '')

export class ApiError extends Error {
  status: number
  body: unknown

  constructor(status: number, message: string, body: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

type ApiEnvelope<T> = {
  data: T
}

type TokenReader = () => string | null

let readToken: TokenReader = () => {
  try {
    const raw = localStorage.getItem('metricsfe-auth')
    if (!raw) return null
    const parsed = JSON.parse(raw) as { state?: { token?: string | null } }
    return parsed.state?.token ?? null
  } catch {
    return null
  }
}

/** Lets auth store register a token reader without circular imports. */
export function setTokenReader(reader: TokenReader) {
  readToken = reader
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit & { auth?: boolean },
): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')

  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  if (init?.auth !== false) {
    const token = readToken()
    if (token) {
      headers.set('Authorization', `Bearer ${token}`)
    }
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
  })

  const contentType = response.headers.get('content-type') ?? ''
  const isJson = contentType.includes('application/json')
  const body = isJson ? await response.json() : await response.text()

  if (!response.ok) {
    const message =
      typeof body === 'object' &&
      body !== null &&
      'message' in body &&
      typeof body.message === 'string'
        ? body.message
        : `API ${response.status}: ${response.statusText}`

    throw new ApiError(response.status, message, body)
  }

  if (
    typeof body === 'object' &&
    body !== null &&
    'data' in body &&
    (body as ApiEnvelope<T>).data !== undefined
  ) {
    return (body as ApiEnvelope<T>).data
  }

  return body as T
}

/** The `{ "error": "code" }` the API returns for domain failures, or `null`. */
export function apiErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null
  const body = error.body
  if (typeof body !== 'object' || body === null || !('error' in body)) return null
  const code = (body as { error: unknown }).error
  return typeof code === 'string' ? code : null
}

export function fieldErrorsFromApi(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {}

  const body = error.body
  if (typeof body !== 'object' || body === null || !('errors' in body)) {
    return {}
  }

  const errors = (body as { errors: Array<{ field?: string; message: string }> })
    .errors

  return errors.reduce<Record<string, string>>((acc, item) => {
    if (item.field) {
      acc[item.field] = item.message
    }
    return acc
  }, {})
}
