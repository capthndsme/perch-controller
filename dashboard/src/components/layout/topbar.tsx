import { useState } from 'react'
import { Link } from 'react-router-dom'
import { List, Moon, SignOut, Sun, Monitor as MonitorIcon, UserCircle } from '@phosphor-icons/react'
import { GlobalSearch } from '@/components/layout/global-search'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useLogout, useProfile } from '@/hooks/use-auth'
import { useAppStore, type Theme } from '@/stores/app-store'
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
      className="size-8 p-0"
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
        <Button type="button" variant="ghost" size="sm" className="h-8 gap-2 px-2">
          <UserCircle className="size-5 text-muted-foreground" />
          <span className="hidden max-w-[10rem] truncate text-[13px] md:inline">{displayName}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1">
        <div className="px-2 py-2">
          <p className="truncate text-[13px] font-medium">{displayName}</p>
          {profile?.role ? (
            <p className="text-[11px] capitalize text-muted-foreground">{profile.role}</p>
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

type TopbarProps = {
  onOpenMobileNav: () => void
  className?: string
}

/** Sticky top bar: mobile nav trigger, global search, theme, user menu. */
export function Topbar({ onOpenMobileNav, className }: TopbarProps) {
  return (
    <header
      className={cn(
        'sticky top-0 z-30 flex h-[var(--topbar-height)] items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur',
        className,
      )}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="size-8 p-0 lg:hidden"
        onClick={onOpenMobileNav}
        aria-label="Open navigation"
      >
        <List className="size-5" />
      </Button>
      <GlobalSearch className="w-full max-w-md" />
      <div className="ml-auto flex items-center gap-1">
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  )
}
