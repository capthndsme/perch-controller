import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { CashRegister, DotsThreeOutline, X } from '@phosphor-icons/react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useCanEnterSellMode } from '@/hooks/use-sell-mode'
import { MOBILE_TAB_PATHS, NAV_ITEMS, navItemActive, type NavItem } from '@/lib/nav'
import { prefersReducedMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'

const TABS = MOBILE_TAB_PATHS.map((to) => NAV_ITEMS.find((item) => item.to === to)).filter(
  (item): item is NavItem => item !== undefined,
)
const MORE = NAV_ITEMS.filter((item) => !MOBILE_TAB_PATHS.includes(item.to))

/**
 * The sheet's module carries react-spring and use-gesture: it loads when the
 * browser is idle (or on the press of More), never with the entry.
 */
const loadBottomSheet = () => import('@/components/ui/bottom-sheet')
const BottomSheet = lazy(() => loadBottomSheet().then((module) => ({ default: module.BottomSheet })))

/** The glide back to the top: ζ 1, response ~0.3 s over 440 ms, whatever the distance. */
const GLIDE_MS = 440
const GLIDE_W = 9.23

/**
 * Tapping the tab of the page already open glides back to the top, like a
 * status-bar tap: fast and the same length from any depth, stopped by any
 * touch, wheel or key. Reduced motion: it jumps.
 */
function glideToTop() {
  let from = window.scrollY
  if (from <= 0) return
  if (prefersReducedMotion()) {
    window.scrollTo(0, 0)
    return
  }
  // Thousands of rows would strobe past: start the glide two screens up.
  if (from > 3 * window.innerHeight) {
    from = 2 * window.innerHeight
    window.scrollTo(0, from)
  }
  const start = performance.now()
  let frame = 0
  const stops = ['touchstart', 'wheel', 'keydown', 'pointerdown'] as const
  const stop = () => {
    cancelAnimationFrame(frame)
    for (const type of stops) window.removeEventListener(type, stop)
  }
  for (const type of stops) window.addEventListener(type, stop, { passive: true })
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / GLIDE_MS)
    window.scrollTo(0, t === 1 ? 0 : from * (1 + GLIDE_W * t) * Math.exp(-GLIDE_W * t))
    if (t < 1) frame = requestAnimationFrame(step)
    else stop()
  }
  frame = requestAnimationFrame(step)
}

// Tabs are controls, not links to preview: no iOS link preview or text selection on a long press.
const TAB_CLASS =
  'group relative flex min-w-0 select-none flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium transition-colors [-webkit-touch-callout:none]'

/**
 * The phone and tablet navigation (below lg, where the sidebar is hidden): a
 * bar docked to the bottom with the main sections as tabs and "More", a sheet
 * with every other section. Its height, safe area included, is
 * `--bottom-nav-height` (index.css; 0 on lg+ and in print), which the shell
 * pads the content with and full-height pages can subtract.
 *
 * One pill marks the current tab and slides to the tapped one on the tap
 * frame (360 ms, the snappy spring; a CSS transition, so quick taps retarget
 * it from wherever it is). While the More sheet is open it sits on More.
 * Reduced motion: each tab's own pill cross-fades instead.
 */
export function BottomNav() {
  const { pathname } = useLocation()
  const [moreOpen, setMoreOpen] = useState(false)
  // The bar goes away at lg: an open sheet (hidden with it) must not keep the page modal.
  const hasSidebar = useMediaQuery('(width >= 64rem)')
  if (hasSidebar && moreOpen) setMoreOpen(false)
  const [moreUsed, setMoreUsed] = useState(false)
  if (moreOpen && !moreUsed) setMoreUsed(true)
  const moreButton = useRef<HTMLButtonElement>(null)
  const moreActive = MORE.some((item) => navItemActive(item, pathname))

  // A tapped tab takes the pill on the tap frame, before its page has loaded and the route committed.
  const [tapped, setTapped] = useState<{ slot: number; from: string } | null>(null)
  const [seenPath, setSeenPath] = useState(pathname)
  if (pathname !== seenPath) {
    // The route caught up (or went elsewhere, Back included): it decides again.
    setSeenPath(pathname)
    setTapped(null)
  }
  const routeSlot = moreActive ? TABS.length : TABS.findIndex((item) => navItemActive(item, pathname))
  const slot = moreOpen ? TABS.length : tapped && tapped.from === pathname ? tapped.slot : routeSlot
  // Where the pill last was: on a page without a tab it fades out there, and comes back from there.
  const [pillSlot, setPillSlot] = useState(Math.max(slot, 0))
  if (slot >= 0 && slot !== pillSlot) setPillSlot(slot)

  useEffect(() => {
    if (!window.matchMedia('(width < 64rem)').matches) return
    // Safari has no requestIdleCallback.
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(() => void loadBottomSheet(), { timeout: 5000 })
      return () => window.cancelIdleCallback(id)
    }
    const id = setTimeout(() => void loadBottomSheet(), 3000)
    return () => clearTimeout(id)
  }, [])

  return (
    <nav
      aria-label="Sections"
      className={cn(
        'bar-material fixed inset-x-0 bottom-0 z-40 border-t border-border lg:hidden print:hidden',
        'pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]',
      )}
    >
      <div className="relative mx-auto grid h-14 max-w-xl grid-cols-5">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 flex w-1/5 flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium transition-[transform,opacity] duration-[360ms] ease-spring-snappy motion-reduce:hidden"
          style={{ transform: `translateX(${pillSlot * 100}%)`, opacity: slot < 0 ? 0 : 1 }}
        >
          <span className="h-7 w-12 rounded-full bg-brand/12" />
          {/* Stands in for the label, so the pill sits exactly behind the icon. */}
          <span className="invisible">·</span>
        </span>
        {TABS.map((item, index) => {
          const active = navItemActive(item, pathname)
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              aria-current={active ? 'page' : undefined}
              onClick={(event) => {
                if (pathname !== item.to) {
                  setTapped({ slot: index, from: pathname })
                  return
                }
                // The tab's own page: back to the top instead of a same-URL navigation.
                event.preventDefault()
                glideToTop()
              }}
              className={cn(TAB_CLASS, active ? 'text-brand' : 'text-foreground/70')}
            >
              <TabIcon icon={item.icon} active={active} />
              <span className="max-w-full truncate px-1">{item.label}</span>
            </NavLink>
          )
        })}
        <button
          ref={moreButton}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          aria-label={moreActive ? 'More sections (current page is here)' : 'More sections'}
          onPointerDown={() => void loadBottomSheet()}
          onClick={() => setMoreOpen(true)}
          className={cn(TAB_CLASS, moreActive || moreOpen ? 'text-brand' : 'text-foreground/70')}
        >
          <TabIcon icon={DotsThreeOutline} active={moreActive || moreOpen} filled={moreActive} />
          <span>More</span>
        </button>
      </div>
      {moreUsed ? (
        <Suspense fallback={null}>
          <BottomSheet
            open={moreOpen}
            onOpenChange={setMoreOpen}
            returnFocusRef={moreButton}
            className={cn(
              'mx-auto max-w-xl lg:hidden',
              'pb-[calc(env(safe-area-inset-bottom)+1rem)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]',
            )}
            overlayClassName="lg:hidden"
          >
            <MoreSheetBody pathname={pathname} onNavigate={() => setMoreOpen(false)} />
          </BottomSheet>
        </Suspense>
      ) : null}
    </nav>
  )
}

/**
 * The icon over a tab's label. A press shrinks it to 0.9 in 75 ms and it
 * springs back on release (the snappy spring, 360 ms); an inactive tab also
 * tints under the thumb. Reduced motion: no scale, the tint stays, and the
 * current tab carries its own pill (the sliding one is hidden).
 */
function TabIcon({ icon: Icon, active, filled = active }: { icon: NavItem['icon']; active: boolean; filled?: boolean }) {
  return (
    <span
      className={cn(
        'flex h-7 w-12 items-center justify-center rounded-full',
        'transition-[scale,background-color] duration-[360ms] ease-spring-snappy group-active:scale-90 group-active:duration-75 motion-reduce:group-active:scale-100',
        active ? 'motion-reduce:bg-brand/12' : 'group-active:bg-foreground/[0.07]',
      )}
    >
      <Icon className="size-[22px]" weight={filled ? 'fill' : 'regular'} />
    </span>
  )
}

/** The sections that are not tabs, as a grid of tiles; Sell Mode (an admin's, once a portal sells at the desk) under them. */
function MoreSheetBody({ pathname, onNavigate }: { pathname: string; onNavigate: () => void }) {
  const canSell = useCanEnterSellMode()
  return (
    <>
      <div className="flex items-center justify-between px-4 pb-3">
        <DialogPrimitive.Title className="text-[15px] font-semibold">More</DialogPrimitive.Title>
        <DialogPrimitive.Close
          className="-mr-1 flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors duration-base hover:bg-muted hover:text-foreground active:bg-muted active:duration-0"
          aria-label="Close"
        >
          <X className="size-5" />
        </DialogPrimitive.Close>
      </div>
      <div className="grid grid-cols-3 gap-2 px-4">
        {MORE.map((item) => {
          const active = navItemActive(item, pathname)
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              aria-current={active ? 'page' : undefined}
              onClick={onNavigate}
              className={cn(
                // The press tint lands with the finger and fades on release.
                'flex min-h-20 select-none flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-3 text-center text-[12px] font-medium transition-colors duration-base active:duration-0 [-webkit-touch-callout:none]',
                active
                  ? 'border-brand/40 bg-brand/10 text-brand'
                  : 'border-border bg-background text-foreground hover:bg-muted active:bg-muted',
              )}
            >
              <item.icon className="size-6" weight={active ? 'fill' : 'regular'} />
              <span className="max-w-full truncate">{item.label}</span>
            </NavLink>
          )
        })}
      </div>
      {canSell ? (
        <div className="px-4 pt-3">
          <NavLink
            to="/sell"
            onClick={onNavigate}
            className="flex min-h-12 select-none items-center justify-center gap-2 rounded-xl border border-brand/40 bg-brand/10 px-3 text-[13px] font-medium text-brand transition-colors duration-base active:bg-brand/20 active:duration-0 [-webkit-touch-callout:none]"
          >
            <CashRegister className="size-5" />
            Enter Sell Mode
          </NavLink>
        </div>
      ) : null}
    </>
  )
}
