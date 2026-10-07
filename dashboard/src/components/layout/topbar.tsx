import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { Link, useLocation } from 'react-router-dom'
import { MagnifyingGlass, Moon, SignOut, Sun, Monitor as MonitorIcon, UserCircle } from '@phosphor-icons/react'
import { AlertsBell } from '@/components/alerts/alerts-bell'
import { GlobalSearch } from '@/components/layout/global-search'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useLogout, useProfile } from '@/hooks/use-auth'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useAppStore, type Theme } from '@/stores/app-store'
import { roleLabel } from '@/lib/roles'
import { cn } from '@/lib/utils'

const THEME_ORDER: Theme[] = ['light', 'dark', 'system']

function ThemeToggle() {
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : MonitorIcon
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="size-9 p-0 lg:size-8"
      onClick={() => setTheme(next)}
      title={`Theme: ${theme} (click for ${next})`}
      aria-label={`Theme: ${theme}. Switch to ${next}`}
    >
      <Icon className="size-4" />
    </Button>
  )
}

function UserMenu() {
  const { data: profile } = useProfile()
  const logout = useLogout()
  const [open, setOpen] = useState(false)
  const displayName = profile?.fullName || profile?.email || 'Account'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="h-9 gap-2 px-2 lg:h-8" aria-label="Account">
          <UserCircle className="size-5 text-muted-foreground" />
          <span className="hidden max-w-[10rem] truncate text-[13px] md:inline">{displayName}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1">
        <div className="px-2 py-2">
          <p className="truncate text-[13px] font-medium">{displayName}</p>
          {profile?.role ? (
            <p className="text-[11px] text-muted-foreground">{roleLabel(profile.role)}</p>
          ) : null}
        </div>
        <div className="my-1 h-px bg-border" />
        <Link
          to="/settings"
          onClick={() => setOpen(false)}
          className="block rounded px-2 py-1.5 text-[13px] hover:bg-muted"
        >
          Settings
        </Link>
        <button
          type="button"
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-muted disabled:opacity-50"
        >
          <SignOut className="size-4" />
          {logout.isPending ? 'Signing out…' : 'Log out'}
        </button>
      </PopoverContent>
    </Popover>
  )
}

/**
 * How far (px) the page's heading must come back out from under the bar
 * before the brand returns: a scroll that hovers at the edge never flips the
 * title back and forth on every pixel.
 */
const TITLE_HYSTERESIS_PX = 8

/**
 * The page's title once it has scrolled under the top bar (a phone's
 * collapsing large title), null while it is in view, and `shown`, the last
 * such title, which stays in place while it fades back out. It is the first
 * `main h1` of the page (PageHeader's title).
 */
function useScrolledPageTitle(
  bar: RefObject<HTMLElement | null>,
  enabled: boolean,
  pathname: string,
): { title: string | null; shown: string | null } {
  const [title, setTitle] = useState<string | null>(null)
  const [shown, setShown] = useState<string | null>(null)
  // A new page never shows the previous page's title, not even for a frame.
  const [seenPathname, setSeenPathname] = useState(pathname)
  if (pathname !== seenPathname) {
    setSeenPathname(pathname)
    setTitle(null)
    setShown(null)
  }
  if (title !== null && title !== shown) setShown(title)
  useEffect(() => {
    if (!enabled) return
    let frame = 0
    let under = false
    const update = () => {
      frame = 0
      const heading = document.querySelector('main h1')
      const barBottom = bar.current?.getBoundingClientRect().bottom ?? 0
      under =
        heading !== null &&
        heading.getBoundingClientRect().bottom < barBottom + (under ? TITLE_HYSTERESIS_PX : 0)
      setTitle(under && heading ? heading.textContent?.trim() || null : null)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    schedule()
    window.addEventListener('scroll', schedule, { passive: true })
    return () => {
      window.removeEventListener('scroll', schedule)
      cancelAnimationFrame(frame)
    }
  }, [bar, enabled, pathname])
  return { title: enabled ? title : null, shown }
}

/**
 * Marks the bar `data-scrolled` while content is scrolled under it: its
 * hairline and material show only then (at the top of a page nothing is under
 * the bar). Written on the element, not as React state; before the first paint.
 */
function useScrollEdge(bar: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    let frame = 0
    const update = () => {
      frame = 0
      bar.current?.setAttribute('data-scrolled', String(window.scrollY > 0))
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', schedule, { passive: true })
    return () => {
      window.removeEventListener('scroll', schedule)
      cancelAnimationFrame(frame)
    }
  }, [bar])
}

/** Stacked in one grid cell, the brand word and the page title cross over. */
const BAR_TITLE =
  'col-start-1 row-start-1 truncate transition-[opacity,translate] duration-base ease-out motion-reduce:transition-opacity'

type TopbarProps = {
  className?: string
}

/**
 * Sticky top bar: global search, the alerts bell, theme, user menu. Below lg, where the
 * sidebar is hidden, it also carries the brand mark; on a phone the name
 * "Perch" next to it gives way to the page's title once that has scrolled
 * away, and the search sits behind an icon: tapped, the field grows out of it
 * across the bar (index.css `.topbar-search`) and shrinks back into it.
 */
export function Topbar({ className }: TopbarProps) {
  const { pathname } = useLocation()
  const headerRef = useRef<HTMLElement>(null)
  const searchRef = useRef<HTMLDivElement>(null)
  const searchButtonRef = useRef<HTMLButtonElement>(null)
  const phone = useMediaQuery('(width < 40rem)')
  const { title: pageTitle, shown: shownTitle } = useScrolledPageTitle(headerRef, phone, pathname)
  useScrollEdge(headerRef)
  // Phone only (below sm): the search field takes over the bar.
  const [searching, setSearching] = useState(false)
  const searchOpen = phone && searching

  const openSearch = () => {
    const layer = searchRef.current
    const from = searchButtonRef.current
    if (layer && from) {
      // The field grows out of the magnifier's box: its insets inside the layer.
      const a = layer.getBoundingClientRect()
      const b = from.getBoundingClientRect()
      // Settle the closed shape there first, without a transition of its own,
      // so the open transitions from it.
      layer.style.transition = 'none'
      layer.style.setProperty('--search-from-top', `${b.top - a.top}px`)
      layer.style.setProperty('--search-from-right', `${a.right - b.right}px`)
      layer.style.setProperty('--search-from-bottom', `${a.bottom - b.bottom}px`)
      layer.style.setProperty('--search-from-left', `${b.left - a.left}px`)
      void window.getComputedStyle(layer).clipPath
      layer.style.transition = ''
    }
    // Shown and focused in the same tap, so a phone raises its keyboard.
    flushSync(() => setSearching(true))
    layer?.querySelector<HTMLInputElement>('input[type="search"]')?.focus()
  }
  const closeSearch = () => setSearching(false)

  return (
    <header
      ref={headerRef}
      className={cn(
        'bar-material sticky top-0 z-30 flex h-[var(--topbar-height)] items-center gap-3 border-b border-border px-4 print:hidden',
        'transition-[background-color,border-color] duration-base ease-out data-[scrolled=false]:border-transparent data-[scrolled=false]:bg-transparent',
        className,
      )}
    >
      <Link
        to="/"
        className={cn(
          'flex min-w-0 items-center gap-2.5 transition-opacity duration-fast ease-out lg:hidden',
          searchOpen && 'opacity-0',
        )}
        aria-label="Perch home"
        inert={searchOpen}
      >
        <span
          aria-hidden
          className="flex size-7 shrink-0 items-center justify-center rounded-md bg-brand text-[11px] font-bold text-brand-foreground"
        >
          P
        </span>
        <span className="grid min-w-0 text-[15px] font-semibold tracking-tight sm:hidden">
          <span
            aria-hidden={pageTitle !== null}
            className={cn(BAR_TITLE, pageTitle !== null && '-translate-y-1.5 opacity-0 motion-reduce:translate-y-0')}
          >
            Perch
          </span>
          <span
            aria-hidden={pageTitle === null}
            className={cn(BAR_TITLE, pageTitle === null && 'translate-y-1.5 opacity-0 motion-reduce:translate-y-0')}
          >
            {shownTitle}
          </span>
        </span>
      </Link>
      <div
        ref={searchRef}
        data-open={searchOpen}
        className="topbar-search max-sm:absolute max-sm:inset-x-4 max-sm:inset-y-0 max-sm:z-10 max-sm:flex max-sm:items-center max-sm:gap-2 sm:w-full sm:max-w-md"
        inert={phone && !searching}
      >
        <GlobalSearch className="min-w-0 flex-1" onDone={closeSearch} />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="topbar-search-cancel h-9 shrink-0 px-2 sm:hidden"
          onClick={closeSearch}
        >
          Cancel
        </Button>
      </div>
      <div
        className={cn('ml-auto flex shrink-0 items-center gap-1 transition-opacity duration-fast ease-out', searchOpen && 'opacity-0')}
        inert={searchOpen}
      >
        <Button
          ref={searchButtonRef}
          type="button"
          variant="ghost"
          size="sm"
          className="size-9 p-0 sm:hidden"
          onClick={openSearch}
          aria-label="Search devices, IPs, MACs, SSIDs"
        >
          <MagnifyingGlass className="size-5" />
        </Button>
        <AlertsBell />
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  )
}
