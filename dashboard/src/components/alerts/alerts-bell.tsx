import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Bell } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { useAlertSummary, useMarkAlertsRead } from '@/hooks/use-alert-summary'
import { useMediaQuery } from '@/hooks/use-media-query'
import { ApiError } from '@/lib/api'
import { bellBadge } from '@/lib/alert-badge'
import { canUseServiceWorker } from '@/lib/push'
import { cn } from '@/lib/utils'

/**
 * The panel's rows and the phone's sheet load on first use (a hover, a press, or idle time on a phone):
 * the entry only carries the button and its badge.
 */
const loadPanel = () => import('@/components/alerts/bell-panel')
const BellPanel = lazy(() => loadPanel().then((module) => ({ default: module.BellPanel })))
const loadBottomSheet = () => import('@/components/ui/bottom-sheet')
const BottomSheet = lazy(() => loadBottomSheet().then((module) => ({ default: module.BottomSheet })))

function preload() {
  void loadPanel()
}

/**
 * Once per load, when this browser already receives pushes: re-post the subscription if the controller's
 * key changed or a day has passed (lib/push-subscribe.ts). Nothing is fetched otherwise.
 */
function useDailyPushSync() {
  useEffect(() => {
    if (!canUseServiceWorker() || !('Notification' in window) || Notification.permission !== 'granted') return
    void import('@/lib/push-subscribe').then((module) => module.syncPushSubscription()).catch(() => {
      // Next load tries again.
    })
  }, [])
}

/**
 * The bell in the top bar, left of the theme switch (design README §5). Badge: active warning + critical
 * alerts, red when any is critical; a dot when there is only unread news. Desktop: a popover with the
 * latest six; phone: a bottom sheet. Opening it marks what it shows as read. Polls the summary every 30 s
 * and on focus; a push that arrives while the dashboard is open refreshes it at once (lib/push.ts). An
 * older controller without alerts answers 404: then there is no bell.
 */
export function AlertsBell() {
  const summary = useAlertSummary()
  const markRead = useMarkAlertsRead()
  const phone = useMediaQuery('(width < 40rem)')
  const [open, setOpen] = useState(false)
  const [sheetUsed, setSheetUsed] = useState(false)
  if (open && phone && !sheetUsed) setSheetUsed(true)
  const buttonRef = useRef<HTMLButtonElement>(null)
  useDailyPushSync()

  const badge = bellBadge(summary.data)
  const unread = summary.data?.unread ?? 0

  // An installed app's icon shows the same number (Chrome, iOS Home Screen apps).
  const appBadge = summary.data ? badge.count : null
  useEffect(() => {
    if (appBadge === null || !('setAppBadge' in navigator)) return
    const request = appBadge > 0 ? navigator.setAppBadge(appBadge) : navigator.clearAppBadge()
    request.catch(() => {
      // Not installed, or not allowed: nothing to show it on.
    })
  }, [appBadge])

  // A phone with a sheet waiting: fetch its code while the browser is idle.
  useEffect(() => {
    if (!phone) return
    const load = () => {
      void loadBottomSheet()
      void loadPanel()
    }
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(load, { timeout: 6000 })
      return () => window.cancelIdleCallback(id)
    }
    const id = setTimeout(load, 4000)
    return () => clearTimeout(id)
  }, [phone])

  if (summary.error instanceof ApiError && summary.error.status === 404) return null

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (next && summary.data && unread > 0) {
      // Through what the bell had fetched: anything newer stays unread.
      markRead.mutate(new Date(summary.dataUpdatedAt).toISOString())
    }
  }

  const label = [
    'Alerts',
    badge.count > 0 ? `${badge.count} active${badge.critical ? ', critical among them' : ''}` : null,
    unread > 0 ? `${unread} unread` : null,
  ]
    .filter(Boolean)
    .join(', ')

  const button = (
    <Button
      ref={buttonRef}
      type="button"
      variant="ghost"
      size="sm"
      className="relative size-9 p-0 lg:size-8"
      aria-label={label}
      title={label}
      onPointerEnter={preload}
      onPointerDown={() => {
        preload()
        if (phone) void loadBottomSheet()
      }}
      onFocus={preload}
      onClick={phone ? () => onOpenChange(true) : undefined}
    >
      <Bell className="size-[18px]" weight={open ? 'fill' : 'regular'} />
      {badge.count > 0 ? (
        <span
          aria-hidden
          className={cn(
            'absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold tabular-nums ring-2 ring-background lg:-top-0.5 lg:-right-0.5',
            badge.critical ? 'bg-status-critical text-white' : 'bg-status-warning text-neutral-950',
          )}
        >
          {badge.count > 99 ? '99+' : badge.count}
        </span>
      ) : badge.dot ? (
        <span aria-hidden className="absolute top-1.5 right-1.5 size-2 rounded-full bg-brand ring-2 ring-background lg:top-1 lg:right-1" />
      ) : null}
    </Button>
  )

  if (phone) {
    return (
      <>
        {button}
        {sheetUsed ? (
          <Suspense fallback={null}>
            <BottomSheet
              open={open}
              onOpenChange={onOpenChange}
              returnFocusRef={buttonRef}
              aria-label="Alerts"
              className="mx-auto max-w-xl pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
            >
              <Suspense fallback={<PanelFallback />}>
                <BellPanel summary={summary.data} sheet onNavigate={() => onOpenChange(false)} />
              </Suspense>
            </BottomSheet>
          </Suspense>
        ) : null}
      </>
    )
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{button}</PopoverTrigger>
      <PopoverContent align="end" className="w-[22rem] p-0">
        <Suspense fallback={<PanelFallback />}>
          <BellPanel summary={summary.data} onNavigate={() => onOpenChange(false)} />
        </Suspense>
      </PopoverContent>
    </Popover>
  )
}

function PanelFallback() {
  return (
    <div className="flex h-40 items-center justify-center">
      <Spinner />
    </div>
  )
}
