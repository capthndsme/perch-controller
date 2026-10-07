import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle, CloudSlash, ShareNetwork } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ErrorNote } from '@/components/portal/portal-ui'
import { useRetained } from '@/hooks/use-retained'
import { sellMenuQueryKey, useCreateSale } from '@/hooks/use-sell'
import { ApiError, apiErrorCode } from '@/lib/api'
import { errorDetail, portalErrorMessage } from '@/lib/portal'
import { itemSpeed, newClientRef, shareText } from '@/lib/sell'
import type { CreateSaleResult, SellItem, SellMenu, SellPortal } from '@/types/sell'

/** A price the seller tapped: one sale attempt, its reference reused on every retry. */
export type SaleAttempt = { portal: SellPortal; item: SellItem; clientRef: string }

type SaleSheetProps = {
  attempt: SaleAttempt | null
  /** The attempt with a fresh reference (after `client_ref_used`, the one refusal a new attempt fixes). */
  onAttemptChange: (attempt: SaleAttempt) => void
  onClose: () => void
  /** The sale could not go through because the menu moved on (prices, desk sales off): a line for the page. */
  onMenuChanged: (message: string) => void
}

const SHEET_FOOTER = 'max-sm:pb-[calc(0.75rem+env(safe-area-inset-bottom))]'

/**
 * Confirm a sale, then show its code: a bottom sheet on a phone, a card from
 * `sm`. Confirm posts the sale with the attempt's `clientRef`, so "Try again"
 * after a lost answer returns the same sale instead of a second one. While a
 * code is on screen a stray tap outside does not close it; the sale stays in
 * Today's list either way (Show code).
 */
export function SaleSheet({ attempt, onAttemptChange, onClose, onMenuChanged }: SaleSheetProps) {
  const queryClient = useQueryClient()
  const create = useCreateSale()
  const [result, setResult] = useState<{ clientRef: string; data: CreateSaleResult } | null>(null)
  // What the sheet shows while it slides out.
  const shown = useRetained(attempt)
  const done = result && shown && result.clientRef === shown.clientRef ? result.data : null
  const failed = create.error && !done ? create.error : null
  const offline = failed !== null && !(failed instanceof ApiError)

  function close() {
    create.reset()
    onClose()
  }

  function confirm() {
    if (!attempt) return
    const { portal, item } = attempt
    let { clientRef } = attempt
    if (apiErrorCode(failed) === 'client_ref_used') {
      clientRef = newClientRef()
      onAttemptChange({ ...attempt, clientRef })
    }
    create.mutate(
      { portalId: portal.id, amount: item.amount, priceRevision: portal.priceTable.revision, clientRef },
      {
        onSuccess: (data) => setResult({ clientRef, data }),
        onError: (error) => {
          const code = apiErrorCode(error)
          if (code === 'price_changed') {
            const fresh = errorDetail<SellPortal>(error, 'portal')
            if (fresh) {
              queryClient.setQueryData<SellMenu>(sellMenuQueryKey, (menu) =>
                menu ? { ...menu, portals: menu.portals.map((p) => (p.id === fresh.id ? fresh : p)) } : menu,
              )
            }
            void queryClient.invalidateQueries({ queryKey: sellMenuQueryKey })
            close()
            onMenuChanged(portalErrorMessage(error))
          } else if (code === 'not_on_menu' || code === 'desk_sales_off' || code === 'portal_not_found') {
            void queryClient.invalidateQueries({ queryKey: sellMenuQueryKey })
            close()
            onMenuChanged(portalErrorMessage(error))
          }
        },
      },
    )
  }

  const open = attempt !== null

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        // A code on screen is the guest's purchase: only the buttons put it away.
        onInteractOutside={(event) => {
          if (done) event.preventDefault()
        }}
      >
        {shown && done ? (
          <SaleDone attempt={shown} result={done} onNext={close} />
        ) : shown ? (
          <>
            <DialogHeader>
              <DialogTitle>Sell {shown.item.amountText}?</DialogTitle>
              <DialogDescription>{shown.portal.name}</DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-4">
              <div className="space-y-1 text-center">
                <p className="text-4xl font-semibold tracking-tight tabular-nums">{shown.item.amountText}</p>
                <p className="text-sm">{shown.item.text}</p>
                {itemSpeed(shown.item) ? (
                  <p className="text-xs text-muted-foreground">{itemSpeed(shown.item)}</p>
                ) : null}
              </div>
              <p className="text-center text-[11px] leading-relaxed text-muted-foreground">
                {shown.portal.priceTable.durationMode === 'active_time'
                  ? 'Time counts only while the guest is online.'
                  : 'The clock starts when the guest first signs in.'}{' '}
                Take the money first: the code is shown once you confirm.
              </p>
              {offline ? (
                <p role="alert" className="rounded-md border border-status-warning/50 bg-status-warning/10 p-2.5">
                  Perch could not be reached, so this sale may or may not be recorded. Try again: it is never sold
                  twice.
                </p>
              ) : failed ? (
                <ErrorNote error={failed} />
              ) : null}
            </DialogBody>
            <DialogFooter className={SHEET_FOOTER}>
              <Button type="button" variant="outline" size="lg" className="h-11 sm:h-9" onClick={close}>
                Cancel
              </Button>
              <Button
                type="button"
                size="lg"
                className="h-11 text-sm sm:h-9 sm:text-xs"
                disabled={create.isPending}
                onClick={confirm}
              >
                {create.isPending ? 'Selling…' : failed ? 'Try again' : `Confirm ${shown.item.amountText}`}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function SaleDone({ attempt, result, onNext }: { attempt: SaleAttempt; result: CreateSaleResult; onNext: () => void }) {
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
  const waiting = result.delivery === 'pending' || !attempt.portal.gatewayOnline
  const what = `${result.sale.item.text} · ${result.sale.amountText}`

  async function share() {
    try {
      await navigator.share({ title: 'Wi-Fi code', text: shareText(result.code, what, attempt.portal.name) })
    } catch {
      // Dismissed, or the browser refused: the code is still on screen.
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-1.5">
          <CheckCircle className="size-4 text-status-good" weight="fill" />
          Sold: {result.sale.amountText}
        </DialogTitle>
        <DialogDescription>{attempt.portal.name}</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <div className="space-y-2 rounded-xl border border-border bg-muted/30 px-3 py-5 text-center">
          <p className="text-[11px] text-muted-foreground">Wi-Fi code</p>
          <p className="font-mono text-[2.5rem] leading-none font-semibold tracking-[0.08em] break-all select-all sm:text-5xl">
            {result.code}
          </p>
          <p className="text-xs text-muted-foreground">{what}</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <CopyButton value={result.code} label="Copy code" className="h-9 px-3 text-xs" />
          {canShare ? (
            <Button type="button" variant="outline" className="h-9 px-3" onClick={() => void share()}>
              <ShareNetwork className="size-3.5" />
              Share
            </Button>
          ) : null}
        </div>
        {waiting ? (
          <p role="status" className="flex items-start gap-2 rounded-md border border-status-warning/50 bg-status-warning/10 p-2.5">
            <CloudSlash className="mt-0.5 size-4 shrink-0 text-status-warning" />
            The gateway is offline: the code works once it reconnects.
          </p>
        ) : null}
        <p className="text-center text-[11px] leading-relaxed text-muted-foreground">
          The guest joins the Wi-Fi and types this code on the sign-in page. Entering it on another phone moves what
          is left there.
        </p>
      </DialogBody>
      <DialogFooter className={SHEET_FOOTER}>
        <Button type="button" size="lg" className="h-11 text-sm sm:h-9 sm:text-xs" onClick={onNext} autoFocus>
          New sale
        </Button>
      </DialogFooter>
    </>
  )
}
