import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, CashRegister, CloudSlash, Info, SignOut, Storefront, X } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PageSpinner } from '@/components/ui/spinner'
import { ErrorNote } from '@/components/portal/portal-ui'
import { SaleSheet, type SaleAttempt } from '@/components/sell/sale-sheet'
import { SalesPanel } from '@/components/sell/sales-panel'
import { useLogout, useProfile } from '@/hooks/use-auth'
import { useSellMenu } from '@/hooks/use-sell'
import { selectClassName } from '@/lib/portal'
import { isVendor } from '@/lib/roles'
import { newClientRef, readLastPortal, writeLastPortal } from '@/lib/sell'
import { disarmStartPage } from '@/lib/start-page'
import { cn } from '@/lib/utils'
import type { SellItem, SellPortal } from '@/types/sell'

/**
 * `/sell`, Sell Mode (docs/gateway/portal.md §15): front-desk staff sell
 * Wi-Fi codes for cash, phone first, outside the app shell. Tap a price,
 * confirm, hand over the code. Admins get a back button to the dashboard; a
 * Wi-Fi vendor has only this page, and Sign out.
 */
export function SellPage() {
  // On screen: from now on `/` is the dashboard (Sell Mode's back button must not bounce back here).
  useEffect(() => disarmStartPage(), [])

  const profile = useProfile()
  const vendor = isVendor(profile.data)
  const logout = useLogout()
  const menu = useSellMenu()
  const [chosenPortal, setChosenPortal] = useState<number | null>(readLastPortal)
  const [attempt, setAttempt] = useState<SaleAttempt | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const portals = menu.data?.portals ?? []
  const portal = portals.find((p) => p.id === chosenPortal) ?? portals[0] ?? null
  const seller = menu.data?.seller ?? profile.data
  const sellerName = seller ? seller.fullName || seller.email : ''

  function choosePortal(id: number) {
    setChosenPortal(id)
    writeLastPortal(id)
    setNotice(null)
  }

  function start(target: SellPortal, item: SellItem) {
    setNotice(null)
    setAttempt({ portal: target, item, clientRef: newClientRef() })
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="bar-material sticky top-0 z-40 border-b border-border pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
        <div className="mx-auto flex h-14 w-full max-w-2xl items-center gap-2 px-4">
          {vendor ? null : (
            <Button asChild variant="ghost" size="sm" className="-ml-2 h-9 px-2">
              <Link to="/" aria-label="Back to the dashboard">
                <ArrowLeft className="size-4" />
                <span className="max-sm:hidden">Dashboard</span>
              </Link>
            </Button>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-1.5 text-[15px] leading-tight font-semibold">
              <CashRegister className="size-4 shrink-0 text-brand" />
              Sell Wi-Fi
            </h1>
            {sellerName ? <p className="truncate text-[11px] text-muted-foreground">Selling as {sellerName}</p> : null}
          </div>
          {vendor ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-mr-2 h-9 px-2.5"
              disabled={logout.isPending}
              onClick={() => logout.mutate()}
            >
              <SignOut className="size-4" />
              Sign out
            </Button>
          ) : null}
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 pt-4 pb-[calc(2rem+env(safe-area-inset-bottom))]">
        {menu.isPending ? <PageSpinner label="Loading the menu" /> : null}

        {menu.error && !menu.data ? (
          <div className="space-y-3">
            <ErrorNote error={menu.error} />
            <Button type="button" variant="outline" onClick={() => void menu.refetch()}>
              Try again
            </Button>
          </div>
        ) : null}

        {menu.data && portals.length === 0 ? (
          <EmptyState
            className="mt-6"
            icon={<Storefront className="size-6" />}
            title="Nothing to sell yet"
            description={
              vendor ? (
                'Ask an admin to turn on desk sales.'
              ) : (
                <>
                  Turn on <strong>Desk sales</strong> for a portal and pick the price table it sells from:{' '}
                  <Link to="/portal" className="underline underline-offset-2">
                    Guest portal
                  </Link>{' '}
                  → a portal → Edit.
                </>
              )
            }
          />
        ) : null}

        {portal ? (
          <>
            {portals.length > 1 ? (
              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium text-muted-foreground">Selling for</span>
                <select
                  className={cn(selectClassName, 'h-10 text-sm')}
                  value={portal.id}
                  onChange={(e) => choosePortal(Number(e.target.value))}
                >
                  {portals.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.gatewayOnline ? '' : ' (gateway offline)'}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Selling for <span className="font-medium text-foreground">{portal.name}</span>
              </p>
            )}

            {!portal.gatewayOnline ? (
              <p role="status" className="flex items-start gap-2 rounded-md border border-status-warning/50 bg-status-warning/10 p-2.5 text-xs">
                <CloudSlash className="mt-0.5 size-4 shrink-0 text-status-warning" />
                The gateway is offline: the code works once it reconnects.
              </p>
            ) : null}

            {notice ? (
              <div role="alert" className="flex items-start gap-2 rounded-md border border-brand/40 bg-brand/10 p-2.5 text-xs">
                <Info className="mt-0.5 size-4 shrink-0 text-brand" />
                <span className="flex-1">{notice}</span>
                <button
                  type="button"
                  aria-label="Dismiss"
                  className="-m-1 rounded-sm p-1 text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => setNotice(null)}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ) : null}

            <section aria-label={`Prices, ${portal.priceTable.name}`} className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {portal.items.map((item) => (
                <button
                  key={item.amount}
                  type="button"
                  onClick={() => start(portal, item)}
                  className={cn(
                    'pressable flex min-h-28 flex-col items-start justify-between gap-3 rounded-xl border border-border bg-card p-4 text-left select-none [-webkit-touch-callout:none]',
                    'hover:border-foreground/20 hover:bg-muted/40 active:scale-[0.97] active:bg-muted motion-reduce:active:scale-100',
                    'focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:outline-none',
                  )}
                >
                  <span className="text-2xl font-semibold tracking-tight tabular-nums">{item.amountText}</span>
                  <span className="text-xs leading-snug text-muted-foreground">{item.text}</span>
                </button>
              ))}
            </section>
            <p className="text-[11px] text-muted-foreground">
              Prices from “{portal.priceTable.name}”. Tap one to sell it: you confirm before the code appears.
            </p>
          </>
        ) : null}

        {menu.data ? (
          <SalesPanel
            isAdmin={profile.data?.role === 'admin'}
            userId={profile.data?.id}
            showPortal={portals.length > 1}
            currencyDecimals={Object.fromEntries(portals.map((p) => [p.priceTable.currency, p.priceTable.decimals]))}
          />
        ) : null}
      </main>

      <SaleSheet
        attempt={attempt}
        onAttemptChange={setAttempt}
        onClose={() => setAttempt(null)}
        onMenuChanged={setNotice}
      />
    </div>
  )
}
