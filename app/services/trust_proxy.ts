import { defineConfig } from '@adonisjs/core/http'

/**
 * Compiles a `proxy-addr` trust list into the predicate `request.ip()` uses.
 *
 * Deliberately free of app/env imports so `config/app.ts` can call it while
 * the configuration is still being assembled — and so a unit test can
 * import it without booting anything.
 *
 * Why not `proxyAddr.compile()` directly, as one might expect:
 *
 *   - `proxy-addr` ships no TypeScript declarations and is a transitive
 *     dependency of `@adonisjs/http-server` rather than one we declare, so
 *     importing it breaks `npm run typecheck` (TS7016) and declaring it
 *     would desync `package-lock.json`.
 *   - its `compile()` takes ONE token or an ARRAY of tokens; a
 *     comma-separated string throws `TypeError: invalid IP address`. Adonis
 *     hands a string straight to it, so `TRUST_PROXY=loopback,10.0.0.0/8`
 *     would abort the process at boot.
 *
 * `defineConfig` already runs a single token through `proxyAddr.compile()`,
 * so each token is compiled that way and the results OR-ed, which is what
 * compiling the whole list in one call produces.
 *
 * A token is an address, a CIDR range, or one of the `loopback`,
 * `linklocal` and `uniquelocal` presets. An unparseable token throws, which
 * at boot is the right moment to find out.
 */
export const DEFAULT_TRUST_PROXY = 'loopback'

export type TrustProxyPredicate = (address: string, distance: number) => boolean

export function compileTrustProxy(list: string): TrustProxyPredicate {
  const matchers = list
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map(compileToken)

  if (matchers.length === 0) return compileToken(DEFAULT_TRUST_PROXY)
  if (matchers.length === 1) return matchers[0]
  return (address, distance) => matchers.some((matches) => matches(address, distance))
}

function compileToken(token: string): TrustProxyPredicate {
  return defineConfig({ trustProxy: token }).trustProxy
}
