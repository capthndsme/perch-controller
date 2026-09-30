import { perchVersions } from '#services/perch_version'

/**
 * The webhook HTTP client (docs/design/alerts/delivery.md §2.1): Node's
 * fetch, no redirects (a 3xx is a failure: "use the final URL"), a 10 s
 * timeout, TLS always verified, the first 4 KB of the answer kept.
 */

const TIMEOUT_MS = 10_000
const READ_LIMIT = 4096
const RETRY_AFTER_MAX_SECONDS = 3600

export type HttpAnswer = {
  status: number
  headers: Headers
  /** The first 4 KB of the body, as text. */
  text: string
  durationMs: number
}

async function readSome(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < READ_LIMIT) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks).subarray(0, READ_LIMIT).toString('utf8')
}

/** POSTs JSON; throws on network errors, DNS failures and the timeout. */
export async function postJson(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs = TIMEOUT_MS
): Promise<HttpAnswer> {
  const started = performance.now()
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': `Perch-Controller/${perchVersions().version}`,
      ...headers,
    },
    body,
  })
  const text = await readSome(response)
  return {
    status: response.status,
    headers: response.headers,
    text,
    durationMs: performance.now() - started,
  }
}

/** `Retry-After` in seconds (a number or an HTTP date), capped at an hour. */
export function retryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value || !value.trim()) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds))
    return Math.min(Math.max(Math.ceil(seconds), 1), RETRY_AFTER_MAX_SECONDS)
  const at = Date.parse(value)
  if (Number.isNaN(at)) return undefined
  return Math.min(Math.max(Math.ceil((at - now) / 1000), 1), RETRY_AFTER_MAX_SECONDS)
}

/** Why a request never got an answer, in words for the delivery log. */
export function networkError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timed out after 10 s'
    const cause = (error as { cause?: { code?: string; message?: string } }).cause
    if (cause?.code)
      return `${cause.code}${cause.message ? `: ${cause.message}` : ''}`.slice(0, 300)
    if (cause?.message) return `${error.message}: ${cause.message}`.slice(0, 300)
    return error.message.slice(0, 300)
  }
  return String(error).slice(0, 300)
}
