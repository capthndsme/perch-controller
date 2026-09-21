import env from '#start/env'
import app from '@adonisjs/core/services/app'
import { defineConfig } from '@adonisjs/core/http'
import { DEFAULT_TRUST_PROXY, compileTrustProxy } from '#services/trust_proxy'

/**
 * The app key is used for encrypting cookies, generating signed URLs,
 * and by the "encryption" module.
 *
 * The encryption module will fail to decrypt data if the key is lost or
 * changed. Therefore it is recommended to keep the app key secure.
 */
export const appKey = env.get('APP_KEY')

/**
 * The app URL can be used in various places where you want to create absolute
 * URLs to your application. For example, when sending emails, images should
 * use absolute URLs.
 */
export const appUrl = env.get('APP_URL')

/**
 * The configuration settings used by the HTTP server
 */
export const http = defineConfig({
  /**
   * Which upstream addresses are allowed to speak for their client, i.e.
   * whose `X-Forwarded-For` / `-Proto` / `-Host` we believe. Default
   * `loopback` is today's behaviour (a reverse proxy on the same box).
   *
   * This is load-bearing for `POST /api/v1/collectors/announce`: the address
   * the server will poll is derived from `request.ip()`, so a proxy that is
   * not on this list makes every announce compute the proxy's address
   * instead of the collector's. The Docker stack additionally trusts the
   * stack GATEWAY (not the whole subnet — every sibling container sits on
   * that subnet and could otherwise forge the header) because that is the
   * address a published port forwards from. See docker-compose.yml.
   */
  trustProxy: compileTrustProxy(env.get('TRUST_PROXY', DEFAULT_TRUST_PROXY)),

  /**
   * Generate a unique request id for each incoming request.
   * Useful to correlate logs and debug a request flow.
   */
  generateRequestId: true,

  /**
   * Attach an ETag to every response and answer a matching If-None-Match
   * with 304. Paired with `api_cache_headers_middleware`, which makes the
   * API responses revalidatable in the browser.
   */
  etag: true,

  /**
   * Allow HTTP method spoofing via the "_method" form/query parameter.
   * This lets HTML forms target PUT/PATCH/DELETE routes while still
   * submitting with POST.
   */
  allowMethodSpoofing: false,

  /**
   * Enabling async local storage will let you access HTTP context
   * from anywhere inside your application.
   */
  useAsyncLocalStorage: false,

  /**
   * Redirect configuration controls the behavior of
   * response.redirect().back() and query string forwarding.
   */
  redirect: {
    /**
     * When enabled, all redirects automatically carry over the current
     * request's query string parameters to the redirect destination.
     * Use withQs(false) to opt out for a specific redirect.
     */
    forwardQueryString: true,
  },

  /**
   * Manage cookies configuration. The settings for the session id cookie are
   * defined inside the "config/session.ts" file.
   */
  cookie: {
    /**
     * Restrict the cookie to a specific domain.
     * Keep empty to use the current host.
     */
    domain: '',

    /**
     * Restrict the cookie to a URL path. '/' means all routes.
     */
    path: '/',

    /**
     * Default lifetime for cookies managed by the HTTP layer.
     */
    maxAge: '2h',

    /**
     * Prevent JavaScript access to the cookie in the browser.
     */
    httpOnly: true,

    /**
     * Send cookies only over HTTPS in production.
     */
    secure: app.inProduction,

    /**
     * Cross-site policy for cookie sending.
     */
    sameSite: 'lax',
  },
})
