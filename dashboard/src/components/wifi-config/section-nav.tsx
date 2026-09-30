import { useRef } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Broadcast } from '@phosphor-icons/react'
import { useActiveIntoView } from '@/hooks/use-active-into-view'
import { sectionItemActive, WIFI_SECTION } from '@/lib/nav'
import { cn } from '@/lib/utils'

/**
 * The WiFi section's sub-nav, above each of its pages (the sidebar and the
 * phone tab bar keep one WiFi entry): Overview (the monitoring page),
 * Networks, Radios and Sync. The GatewaySectionNav pattern; scrolls sideways
 * on a phone with the current page's entry kept in view.
 */
export function WifiSectionNav() {
  const { pathname } = useLocation()
  const navRef = useRef<HTMLElement>(null)
  useActiveIntoView(navRef, pathname)

  return (
    <nav
      ref={navRef}
      aria-label="WiFi"
      className="-mx-4 -mb-1 overflow-x-auto overscroll-x-contain px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden"
    >
      <div className="flex w-max items-center gap-1 rounded-lg border border-border bg-card p-1">
        <span className="flex items-center gap-1.5 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Broadcast className="size-3.5" aria-hidden />
          WiFi
        </span>
        {WIFI_SECTION.map((item) => {
          const active = sectionItemActive(item, pathname)
          return (
            <Link
              key={item.to}
              to={item.to}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs font-medium whitespace-nowrap select-none transition-colors duration-base [-webkit-touch-callout:none] active:duration-0 lg:py-1.5',
                active
                  ? 'bg-brand/10 text-brand'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted active:text-foreground',
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
