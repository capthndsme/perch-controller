import { useEffect, useRef } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { Globe } from '@phosphor-icons/react'
import { GATEWAY_SECTION, sectionItemActive } from '@/lib/nav'
import { cn } from '@/lib/utils'

/** Pages that read `?gateway=N` (the others list every gateway). */
const TAKES_GATEWAY_PARAM = new Set(['/gateway', '/shaping'])

/**
 * The Gateway section's sub-nav, above each of its pages (the sidebar has one
 * Gateway entry): Overview (the router's observed state), Configuration,
 * Networks, Shaping and Guest portal. A `?gateway=N` choice travels between
 * the pages that take one. Scrolls sideways on a phone.
 */
export function GatewaySectionNav() {
  const { pathname } = useLocation()
  const [params] = useSearchParams()
  const gateway = params.get('gateway')
  const navRef = useRef<HTMLElement>(null)

  // On a phone the strip scrolls: keep the current page's entry in view.
  useEffect(() => {
    const nav = navRef.current
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!nav || !active) return
    const left = active.offsetLeft - nav.offsetLeft
    if (left < nav.scrollLeft || left + active.offsetWidth > nav.scrollLeft + nav.clientWidth) {
      nav.scrollLeft = Math.max(0, left - 16)
    }
  }, [pathname])

  return (
    <nav
      ref={navRef}
      aria-label="Gateway"
      className="-mx-4 -mb-1 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden"
    >
      <div className="flex w-max items-center gap-1 rounded-lg border border-border bg-card p-1">
        <span className="flex items-center gap-1.5 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Globe className="size-3.5" aria-hidden />
          Gateway
        </span>
        {GATEWAY_SECTION.map((item) => {
          const active = sectionItemActive(item, pathname)
          const to = gateway && TAKES_GATEWAY_PARAM.has(item.to) ? `${item.to}?gateway=${encodeURIComponent(gateway)}` : item.to
          return (
            <Link
              key={item.to}
              to={to}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium whitespace-nowrap transition-colors',
                active ? 'bg-brand/10 text-brand' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <item.icon className="size-3.5 shrink-0" aria-hidden />
              {item.label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
