import { canSell } from '@/lib/roles'
import type { User } from '@/types/api'

/**
 * The page this browser opens on (Settings → This device): a front-desk
 * phone can open straight into Sell Mode while the owner's opens the
 * dashboard. Per browser (localStorage), a convenience only.
 *
 * It applies only when the app *opens* at `/`: a page load or home-screen
 * launch at `/`, or the first `/` right after signing in. Moving around inside
 * Perch never redirects, so Sell Mode's back button (to `/`) lands on the
 * dashboard instead of bouncing back.
 */

export type StartPageId = 'dashboard' | 'traffic' | 'devices' | 'wifi' | 'infrastructure' | 'sell'

export type StartPage = {
  id: StartPageId
  label: string
  path: string
  /** Only for accounts that may sell (admins). */
  sellOnly?: boolean
}

export const START_PAGES: readonly StartPage[] = [
  { id: 'dashboard', label: 'Dashboard', path: '/' },
  { id: 'traffic', label: 'Traffic', path: '/traffic' },
  { id: 'devices', label: 'Devices', path: '/devices' },
  { id: 'wifi', label: 'Wi-Fi', path: '/wifi' },
  { id: 'infrastructure', label: 'Infrastructure', path: '/infrastructure' },
  { id: 'sell', label: 'Sell Mode', path: '/sell', sellOnly: true },
]

const STORAGE_KEY = 'perch-start-page'

export function readStartPage(): StartPageId {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return START_PAGES.some((page) => page.id === value) ? (value as StartPageId) : 'dashboard'
  } catch {
    return 'dashboard'
  }
}

export function writeStartPage(id: StartPageId) {
  try {
    if (id === 'dashboard') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // per-browser convenience only
  }
}

/** The choices for this account (Sell Mode only for those who may sell). */
export function startPagesFor(user: Pick<User, 'role'> | null | undefined): StartPage[] {
  return START_PAGES.filter((page) => !page.sellOnly || canSell(user))
}

// Armed while the app has not shown a page yet and opened at `/`.
let armed = typeof window !== 'undefined' && window.location.pathname === '/'

/** Sign-in is about to land on `/`: the start page applies once more. */
export function armStartPage() {
  armed = true
}

/** A page has been shown: from now on `/` is just the dashboard. */
export function disarmStartPage() {
  armed = false
}

/**
 * Where `/` should go right now, or null for the dashboard itself. Pure: the
 * shell and Sell Mode disarm once they are on screen.
 */
export function startPageRedirect(user: Pick<User, 'role'> | null | undefined): string | null {
  if (!armed) return null
  const page = startPagesFor(user).find((p) => p.id === readStartPage())
  return page && page.path !== '/' ? page.path : null
}

/** The start page's path for the startup chunk prefetch (no role check: a prefetch only). */
export function startPagePathForPrefetch(): string {
  return START_PAGES.find((p) => p.id === readStartPage())?.path ?? '/'
}
