import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

/**
 * Marks API reads as revalidatable. With `http.etag` enabled in
 * `config/app.ts` every response carries an ETag and a matching
 * `If-None-Match` gets a 304 — but browsers only *send* `If-None-Match` for
 * responses they were allowed to store. `private, no-cache` lets the browser
 * keep the body and revalidate on every poll, so the dashboard's 5 s refresh
 * loop moves no bytes when nothing changed. Responses that already set their
 * own policy are left alone.
 */
export default class ApiCacheHeadersMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const output = await next()
    if (
      ctx.request.method() === 'GET' &&
      ctx.request.url().startsWith('/api/v1/') &&
      !ctx.response.getHeader('cache-control')
    ) {
      ctx.response.header('Cache-Control', 'private, no-cache')
    }
    return output
  }
}
