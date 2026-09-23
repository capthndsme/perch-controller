import { matchRoutes, type RouteObject } from 'react-router-dom'
import type { LazyPage } from '@/app/lazy-page'
import { pages, type PageName } from '@/app/pages'
import { useAuthStore } from '@/stores/auth-store'

/** Route `handle` of a page route: the page whose chunk a link to it should fetch. */
export type PageRouteHandle = { page: LazyPage }

/** Pages most visits go through; fetched in idle time after the first page has rendered. */
const COMMON_PAGES: PageName[] = ['dashboard', 'devices', 'traffic', 'wifi']

function preload(page: LazyPage) {
  // A failure surfaces again, and is recovered from, when the page is actually opened.
  page.preload().catch(() => {})
}

/** Fetches the chunk of the page that `pathname` routes to; other paths are a no-op. */
export function preloadPath(routes: RouteObject[], pathname: string) {
  const matches = matchRoutes(routes, pathname) ?? []
  for (let i = matches.length - 1; i >= 0; i--) {
    const handle = matches[i].route.handle as Partial<PageRouteHandle> | undefined
    if (handle?.page) {
      preload(handle.page)
      return
    }
  }
}

/**
 * Starts the first page's chunk at startup, alongside the setup and session
 * checks, instead of after them. It fetches the page the gates will show: the
 * sign-in page for a visitor without a session, the dashboard for one who has
 * a session and opened the sign-in page.
 */
export function preloadInitialPage(routes: RouteObject[]) {
  const { pathname } = window.location
  const signedIn = Boolean(useAuthStore.getState().token)
  let target = pathname
  if (!signedIn && pathname !== '/setup') target = '/login'
  else if (signedIn && pathname === '/login') target = '/'
  preloadPath(routes, target)
}

/**
 * Fetches a page's chunk as soon as the pointer rests on, a finger touches, or
 * the keyboard focuses a same-origin link to it: sidebar entries, in-page links,
 * and elements that navigate from a click handler and name their target with
 * `data-prefetch-href` (table rows, search results). One delegated listener set
 * covers the whole app.
 */
export function installLinkPrefetch(routes: RouteObject[]) {
  const onIntent = (event: Event) => {
    if (!(event.target instanceof Element)) return
    const target = event.target.closest('a[href], [data-prefetch-href]')
    const href = target?.getAttribute('data-prefetch-href') ?? target?.getAttribute('href')
    if (!href) return
    let url: URL
    try {
      url = new URL(href, window.location.href)
    } catch {
      return
    }
    if (url.origin === window.location.origin) preloadPath(routes, url.pathname)
  }
  document.addEventListener('pointerover', onIntent, { passive: true })
  document.addEventListener('focusin', onIntent)
  document.addEventListener('touchstart', onIntent, { passive: true })
}

let commonPagesScheduled = false

/**
 * After the first page has rendered, fetch the most-used pages while the
 * browser is idle, so moving between them stays instant. Skipped when the
 * browser asks to save data.
 */
export function prefetchCommonPagesWhenIdle() {
  if (commonPagesScheduled) return
  commonPagesScheduled = true
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
  if (connection?.saveData) return
  const run = () => COMMON_PAGES.forEach((name) => preload(pages[name]))
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 4000 })
  } else {
    window.setTimeout(run, 1000)
  }
}
