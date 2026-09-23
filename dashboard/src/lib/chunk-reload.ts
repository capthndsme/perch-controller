/**
 * Recovery from stale chunks after a redeploy. Hashed assets are cached
 * forever and the server answers 404 for ones it no longer has, so a tab that
 * was opened before a deploy fails to import the next page's chunk. The route
 * error element (RouteError) then reloads the page once: the reload lands on
 * the new index.html and its new chunk names.
 *
 * "Once" is per build. Before reloading, the build's id (the entry chunk's
 * URL) goes into sessionStorage; if that same build fails again after its
 * reload, RouteError shows a message with a Reload button instead. A chunk that
 * is really missing therefore costs one reload, never a loop, while a later
 * deploy (a new build id) can recover by itself again.
 */

const GUARD_KEY = 'perch-chunk-reload'

/** Errors Vite's preload helper reported: a failed dynamic import or CSS preload. */
const preloadErrors = new WeakSet<object>()

let currentBuild = ''

/**
 * Call once at startup from the entry module with its `import.meta.url`.
 *
 * Vite dispatches `vite:preloadError` for every failed dynamic import, then
 * rethrows the same error, which reaches the route's error element. The
 * listener only records the error so RouteError can recognise it in any
 * browser; RouteError reloads, because by then the navigation has landed on
 * the page that failed and the reload opens that page. A failed hover or idle
 * prefetch lands here too and deliberately does not reload anything.
 */
export function installChunkErrorTracking(buildId: string) {
  currentBuild = buildId
  window.addEventListener('vite:preloadError', (event) => {
    const error: unknown = event.payload
    if (error && typeof error === 'object') preloadErrors.add(error)
  })
}

// Chromium, Firefox, Safari, Vite's CSS preload, webpack-style names.
const CHUNK_ERROR_MESSAGE =
  /dynamically imported module|importing a module script failed|unable to preload css|loading (css )?chunk .+ failed/i

export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if (preloadErrors.has(error)) return true
  const { name, message } = error as { name?: unknown; message?: unknown }
  return name === 'ChunkLoadError' || (typeof message === 'string' && CHUNK_ERROR_MESSAGE.test(message))
}

/**
 * Whether a chunk failure may reload the page: not while offline (the browser
 * would replace the app with its offline page), not without sessionStorage
 * (nothing would stop a loop), and not twice for the same build.
 */
export function canReloadForChunkError(): boolean {
  if (navigator.onLine === false) return false
  try {
    return sessionStorage.getItem(GUARD_KEY) !== currentBuild
  } catch {
    return false
  }
}

export function reloadForChunkError() {
  try {
    sessionStorage.setItem(GUARD_KEY, currentBuild)
  } catch {
    return
  }
  window.location.reload()
}
