import { useState } from 'react'
import { Eye, Prohibit, Receipt } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { PanelOverlay } from '@/components/ui/panel-overlay'
import { Segmented } from '@/components/ui/segmented'
import { CheckoutStateBadge } from '@/components/portal/hotspot-ui'
import { ConfirmDialog, ErrorNote, FormField, VoucherStatusBadge } from '@/components/portal/portal-ui'
import { useRetained } from '@/hooks/use-retained'
import { useRevealSaleCode, useSales, useVoidSale } from '@/hooks/use-sell'
import { minorToMajorText, moneyText, parseMoney } from '@/lib/hotspot'
import { portalErrorMessage } from '@/lib/portal'
import { saleTime } from '@/lib/sell'
import { cn } from '@/lib/utils'
import type { Sale, SaleFilters } from '@/types/sell'

type Scope = 'everyone' | 'mine'

const SCOPES: ReadonlyArray<{ id: Scope; label: string }> = [
  { id: 'everyone', label: 'Everyone' },
  { id: 'mine', label: 'Mine' },
]

/**
 * Today's desk sales (portal.md §15.3, `GET /sell/sales` with the server's
 * default range: today from 00:00 in the instance's time zone). A vendor sees
 * their own; an admin everyone's or their own. Per row: the code again while
 * it is unused, and void. Refreshes every 30 s in place.
 */
export function SalesPanel({
  isAdmin,
  userId,
  showPortal,
  currencyDecimals,
}: {
  isAdmin: boolean
  userId: number | undefined
  /** Name the portal on each row (more than one portal sells). */
  showPortal: boolean
  /** Minor-unit digits per currency, from the menu's price tables (totals are in minor units). */
  currencyDecimals: Record<string, number>
}) {
  const [scope, setScope] = useState<Scope>('everyone')
  const [limit, setLimit] = useState(50)
  const filters: SaleFilters = { limit, ...(isAdmin && scope === 'mine' && userId ? { sellerId: userId } : {}) }
  const sales = useSales(filters)
  const [voiding, setVoiding] = useState<Sale | null>(null)
  const page = sales.data
  const tz = page?.timezone

  return (
    <section className="card-surface relative flex min-w-0 flex-col" aria-labelledby="sell-today">
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3.5 pb-2.5">
        <div className="min-w-0">
          <h2 id="sell-today" className="text-[13px] font-semibold">
            Today
          </h2>
          <p className="text-[11px] text-muted-foreground">
            {isAdmin && scope === 'everyone' ? 'Every desk sale' : 'Your sales'} since midnight{tz ? ` (${tz})` : ''}
          </p>
        </div>
        {isAdmin ? <Segmented ariaLabel="Whose sales" size="xs" value={scope} options={SCOPES} onChange={setScope} /> : null}
      </header>

      {page ? (
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2 border-y border-border bg-muted/20 px-4 py-3">
          {page.totals.length === 0 ? (
            <p className="text-2xl font-semibold tabular-nums">—</p>
          ) : (
            page.totals.map((t) => (
              <div key={t.currency}>
                <p className="text-2xl font-semibold tabular-nums">
                  {moneyText(
                    t.amount,
                    t.currency,
                    page.items.find((s) => s.currency === t.currency)?.decimals ?? currencyDecimals[t.currency] ?? 0,
                  )}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {t.count} sale{t.count === 1 ? '' : 's'}
                </p>
              </div>
            ))
          )}
        </div>
      ) : null}

      {sales.isPending ? <p className="px-4 py-6 text-xs text-muted-foreground">Loading …</p> : null}
      {sales.error ? <ErrorNote error={sales.error} className="m-4" /> : null}
      {page && page.items.length === 0 ? (
        <div className="p-4">
          <EmptyState icon={<Receipt className="size-6" />} title="No sales yet today" />
        </div>
      ) : null}
      {page && page.items.length > 0 ? (
        <ul className="divide-y divide-border">
          {page.items.map((sale) => (
            <SaleRow
              key={sale.id}
              sale={sale}
              timeZone={tz}
              showSeller={isAdmin && scope === 'everyone'}
              showPortal={showPortal}
              onVoid={() => setVoiding(sale)}
            />
          ))}
        </ul>
      ) : null}
      {page && page.total > page.items.length && limit < 200 ? (
        <div className="px-4 py-3">
          <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => setLimit(200)}>
            Show more ({page.total - page.items.length})
          </Button>
        </div>
      ) : null}
      <PanelOverlay show={sales.isPlaceholderData} label="Updating…" />

      <VoidSaleDialog sale={voiding} onClose={() => setVoiding(null)} />
    </section>
  )
}

function SaleRow({
  sale,
  timeZone,
  showSeller,
  showPortal,
  onVoid,
}: {
  sale: Sale
  timeZone: string | undefined
  showSeller: boolean
  showPortal: boolean
  onVoid: () => void
}) {
  const reveal = useRevealSaleCode()
  const [code, setCode] = useState<string | null>(null)
  const voided = sale.state === 'voided'
  const seller = sale.seller ? sale.seller.fullName || sale.seller.email : null
  const details = [
    sale.item.text,
    sale.voucher ? `··${sale.voucher.hint}` : null,
    showPortal && sale.portal ? sale.portal.name : null,
    showSeller && seller ? `by ${seller}` : null,
  ].filter(Boolean)

  const actions = sale.codeAvailable || sale.voidable

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className="w-11 shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">{saleTime(sale.createdAt, timeZone)}</span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('text-sm font-semibold tabular-nums', voided && 'text-muted-foreground line-through')}>
            {sale.amountText}
          </span>
          {voided ? (
            <CheckoutStateBadge state="voided" />
          ) : sale.voucher ? (
            <VoucherStatusBadge status={sale.voucher.status} />
          ) : null}
        </div>
        <p className="truncate text-[11px] text-muted-foreground">{details.join(' · ')}</p>
        {voided && sale.refundAmount !== null ? (
          <p className="text-[11px] text-muted-foreground">
            Refunded {moneyText(sale.refundAmount, sale.currency, sale.decimals)}
            {sale.note ? ` · ${sale.note}` : ''}
          </p>
        ) : null}
        {code !== null ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="font-mono text-lg font-semibold tracking-[0.06em] select-all">{code}</span>
            <CopyButton value={code} ariaLabel={`Copy the code of the ${sale.amountText} sale`} />
            <Button type="button" size="xs" variant="ghost" onClick={() => setCode(null)}>
              Hide
            </Button>
          </div>
        ) : null}
        {reveal.error ? <p className="text-[11px] text-destructive">{portalErrorMessage(reveal.error)}</p> : null}
        {actions ? (
          <div className="flex flex-wrap gap-2 pt-1">
            {sale.codeAvailable && code === null ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8"
                disabled={reveal.isPending}
                onClick={() => reveal.mutate(sale.id, { onSuccess: (data) => setCode(data.code) })}
              >
                <Eye className="size-3.5" />
                Show code
              </Button>
            ) : null}
            {sale.voidable ? (
              <Button type="button" size="sm" variant="ghost" className="h-8 text-destructive hover:text-destructive" onClick={onVoid}>
                <Prohibit className="size-3.5" />
                Void
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  )
}

/**
 * Void a sale: the code stops working (and its guest goes offline when it was
 * in use, which only an admin may do). Perch records the cash given back; the
 * refund starts at the full amount.
 */
function VoidSaleDialog({ sale, onClose }: { sale: Sale | null; onClose: () => void }) {
  const shown = useRetained(sale)
  const voidSale = useVoidSale()
  const [refund, setRefund] = useState<{ id: number; text: string } | null>(null)
  const [note, setNote] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  if (!shown) return null

  const refundText = refund && refund.id === shown.id ? refund.text : minorToMajorText(shown.amount, shown.decimals)
  const inUse = shown.voucher !== null && shown.voucher.status !== 'unused'

  function close() {
    voidSale.reset()
    setRefund(null)
    setNote('')
    setLocalError(null)
    onClose()
  }

  function confirm() {
    if (!shown) return
    setLocalError(null)
    const amount = parseMoney(refundText, shown.decimals)
    if (amount !== undefined && (Number.isNaN(amount) || amount > shown.amount)) {
      setLocalError(`Give back between 0 and ${shown.amountText}.`)
      return
    }
    voidSale.mutate(
      { id: shown.id, refundAmount: amount ?? null, note: note.trim() || null },
      { onSuccess: close },
    )
  }

  return (
    <ConfirmDialog
      open={sale !== null}
      onOpenChange={(open) => !open && close()}
      title={`Void the ${shown.amountText} sale?`}
      description={
        inUse
          ? 'The guest is using this code: voiding takes them offline and the code stops working.'
          : 'The code stops working. Write down what you gave back.'
      }
      confirmLabel="Void sale"
      destructive
      pending={voidSale.isPending}
      error={voidSale.error}
      onConfirm={confirm}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          label={`Refund (${shown.currency})`}
          htmlFor="sell-refund"
          error={localError ?? undefined}
          hint={`Paid: ${shown.amountText}. Empty = not recorded.`}
        >
          <Input
            id="sell-refund"
            inputMode="decimal"
            value={refundText}
            onChange={(e) => setRefund({ id: shown.id, text: e.target.value })}
            className="h-9 rounded-md"
          />
        </FormField>
        <FormField label="Note" htmlFor="sell-void-note" hint="Optional, e.g. wrong price.">
          <Input
            id="sell-void-note"
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="h-9 rounded-md"
          />
        </FormField>
      </div>
    </ConfirmDialog>
  )
}
