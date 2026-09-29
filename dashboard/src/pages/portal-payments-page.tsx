import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Coins, Prohibit, Receipt, Ticket, Warning, X } from '@phosphor-icons/react'
import { PageHeader } from '@/components/layout/page-header'
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
import { Drawer, DrawerContent } from '@/components/ui/drawer'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Panel } from '@/components/ui/panel'
import { PageSpinner } from '@/components/ui/spinner'
import { CheckoutStateBadge, HotspotExplainer } from '@/components/portal/hotspot-ui'
import {
  DeliveryBadge,
  DurationInput,
  ErrorNote,
  Fact,
  FormField,
  Pager,
  PortalSectionNav,
  VoucherStatusBadge,
} from '@/components/portal/portal-ui'
import {
  useCreditCheckout,
  useDismissCheckout,
  useHotspotCheckout,
  useHotspotCheckouts,
  useHotspotTerminals,
  usePriceTables,
  useVoidCheckout,
} from '@/hooks/use-hotspot'
import { useIsPortalAdmin, usePortals } from '@/hooks/use-portal'
import { useRetained } from '@/hooks/use-retained'
import { apiErrorCode } from '@/lib/api'
import {
  CHECKOUT_REASON_LABELS,
  CHECKOUT_STATE_LABELS,
  DURATION_MODE_LABELS,
  checkoutAmount,
  checkoutBought,
  dayBound,
  minorToMajorText,
  moneyText,
  parseMoney,
  rateLabel,
} from '@/lib/hotspot'
import { formatDateTime, selectClassName, toMinutes, vineFieldErrors, type DurationUnit } from '@/lib/portal'
import { cn } from '@/lib/utils'
import type { CheckoutFilters, CheckoutState, HotspotCheckout, HotspotTerminal, Portal, PortalDelivery } from '@/types/api'

const PAGE_SIZE = 50
const STATES: CheckoutState[] = ['paid', 'unclaimed', 'voided', 'credited', 'dismissed']

/** `/portal/payments`: the Paid Hotspot ledger (portal.md §14.5). */
export function PortalPaymentsPage() {
  const { isAdmin } = useIsPortalAdmin()
  const [search, setSearch] = useSearchParams()
  const portals = usePortals()
  const terminals = useHotspotTerminals()
  const tables = usePriceTables()

  const portalId = Number(search.get('portalId')) || undefined
  const terminalId = Number(search.get('terminalId')) || undefined
  const state = (STATES as string[]).includes(search.get('state') ?? '') ? (search.get('state') as CheckoutState) : undefined
  const fromDay = search.get('from') ?? ''
  const toDay = search.get('to') ?? ''
  const mac = search.get('mac') ?? ''
  const offset = Math.max(0, Number(search.get('offset')) || 0)
  const openId = Number(search.get('checkout')) || null

  const filters: CheckoutFilters = {
    portalId,
    terminalId,
    state,
    from: dayBound(fromDay, false),
    to: dayBound(toDay, true),
    mac: mac || undefined,
    limit: PAGE_SIZE,
    offset,
  }
  const checkouts = useHotspotCheckouts(filters)
  // Coins nobody claimed yet, whatever the filters: they wait for an admin.
  const unclaimed = useHotspotCheckouts({ state: 'unclaimed', limit: 1 })

  function setParam(changes: Record<string, string | number | null | undefined>, keepOffset = false) {
    const next = new URLSearchParams(search)
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === undefined || value === '') next.delete(key)
      else next.set(key, String(value))
    }
    if (!keepOffset && !('offset' in changes)) next.delete('offset')
    setSearch(next, { replace: true })
  }

  if (checkouts.isPending && !checkouts.data) return <PageSpinner label="Loading payments" />

  const portalList = portals.data ?? []
  const terminalList = terminals.data ?? []
  const filtered = Boolean(portalId || terminalId || state || fromDay || toDay || mac)
  const pendingCount = unclaimed.data?.total ?? 0

  return (
    <div className="flex w-full flex-col gap-5">
      <PageHeader
        title="Payments"
        crumbs={[{ label: 'Guest portal', to: '/portal' }, { label: 'Payments' }]}
        description="Every paid checkout the gateways reported, and coins that could not be credited to anyone."
      />
      <PortalSectionNav />

      {pendingCount > 0 && state !== 'unclaimed' ? (
        <button
          type="button"
          onClick={() => setParam({ state: 'unclaimed' })}
          className="flex items-start gap-2 rounded-md border border-status-warning/50 bg-status-warning/10 px-3 py-2 text-left text-xs transition-colors hover:bg-status-warning/15"
        >
          <Warning className="mt-0.5 size-3.5 shrink-0 text-status-warning" />
          <span>
            <strong>
              {pendingCount} unclaimed coin report{pendingCount === 1 ? '' : 's'}
            </strong>{' '}
            (money that reached a terminal after its checkout closed). {isAdmin ? 'Credit or dismiss them.' : 'An admin can credit or dismiss them.'}{' '}
            <span className="underline underline-offset-2">Show</span>
          </span>
        </button>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Totals
            page={checkouts.data}
            filtered={filtered}
            decimalsOf={(currency) =>
              checkouts.data?.items.find((c) => c.currency === currency)?.decimals ??
              tables.data?.find((t) => t.currency === currency)?.decimals ??
              0
            }
          />

          <Panel
            title="Ledger"
            flush
            updating={checkouts.isPlaceholderData}
            actions={
              filtered ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setParam({ portalId: null, terminalId: null, state: null, from: null, to: null, mac: null })}
                >
                  <X className="size-3.5" />
                  Clear filters
                </Button>
              ) : null
            }
          >
            <div className="grid grid-cols-2 gap-2 border-b border-border px-4 pb-3 sm:grid-cols-3 lg:grid-cols-6">
              <select
                aria-label="Portal"
                className={selectClassName}
                value={portalId ?? ''}
                onChange={(e) => setParam({ portalId: e.target.value })}
              >
                <option value="">All portals</option>
                {portalList.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Terminal"
                className={selectClassName}
                value={terminalId ?? ''}
                onChange={(e) => setParam({ terminalId: e.target.value })}
              >
                <option value="">All terminals</option>
                {terminalList
                  .filter((t) => !portalId || t.portalId === portalId)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>
              <select
                aria-label="Status"
                className={selectClassName}
                value={state ?? ''}
                onChange={(e) => setParam({ state: e.target.value })}
              >
                <option value="">Any status</option>
                {STATES.map((s) => (
                  <option key={s} value={s}>
                    {CHECKOUT_STATE_LABELS[s]}
                  </option>
                ))}
              </select>
              <Input
                type="date"
                aria-label="From"
                title="From"
                value={fromDay}
                max={toDay || undefined}
                onChange={(e) => setParam({ from: e.target.value })}
                className="h-8 rounded-md text-xs"
              />
              <Input
                type="date"
                aria-label="To"
                title="To"
                value={toDay}
                min={fromDay || undefined}
                onChange={(e) => setParam({ to: e.target.value })}
                className="h-8 rounded-md text-xs"
              />
              <MacFilter key={mac} value={mac} onChange={(value) => setParam({ mac: value })} />
            </div>

            {checkouts.error ? <ErrorNote error={checkouts.error} className="m-4" /> : null}
            {checkouts.data && checkouts.data.items.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  icon={<Receipt className="size-6" />}
                  title={filtered ? 'Nothing matches' : 'No payments yet'}
                  description={
                    filtered
                      ? 'Try a wider date range or fewer filters.'
                      : 'Payments appear here when a guest pays at a coin terminal of a paid portal.'
                  }
                />
              </div>
            ) : null}
            {checkouts.data && checkouts.data.items.length > 0 ? (
              <>
                <div
                  aria-hidden
                  className="hidden grid-cols-[8.5rem_6rem_6.5rem_minmax(0,1fr)_minmax(0,9rem)_minmax(0,10rem)] gap-3 border-b border-border px-4 py-2 text-[11px] font-medium text-muted-foreground lg:grid"
                >
                  <span>When</span>
                  <span className="text-right">Amount</span>
                  <span>Status</span>
                  <span>Bought</span>
                  <span>Terminal</span>
                  <span>Device</span>
                </div>
                <ul className="divide-y divide-border">
                  {checkouts.data.items.map((c) => (
                    <LedgerRow
                      key={c.id}
                      checkout={c}
                      portal={portalList.find((p) => p.id === c.portalId)}
                      active={c.id === openId}
                      onOpen={() => setParam({ checkout: c.id }, true)}
                    />
                  ))}
                </ul>
                <div className="px-4 pb-3">
                  <Pager
                    offset={offset}
                    limit={PAGE_SIZE}
                    total={checkouts.data.total}
                    onChange={(next) => setParam({ offset: next || null })}
                  />
                </div>
              </>
            ) : null}
          </Panel>
        </div>

        <Panel title="How paid access works" className="self-start">
          <HotspotExplainer />
          <p className="mt-4 border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground">
            Perch records money; it does not hold it. Compare the ledger with each terminal’s cash box: a coin the box never
            reported is invisible here, and a payment with no coin in the box means its token leaked (rotate it under{' '}
            <Link to="/portal/terminals" className="underline underline-offset-2">
              Terminals
            </Link>
            ).
          </p>
        </Panel>
      </div>

      <CheckoutDrawer
        id={openId}
        preview={checkouts.data?.items.find((c) => c.id === openId) ?? null}
        portals={portalList}
        terminals={terminalList}
        isAdmin={isAdmin}
        onClose={() => setParam({ checkout: null }, true)}
      />
    </div>
  )
}

function MacFilter({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [text, setText] = useState(value)
  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault()
        onChange(text.trim())
      }}
    >
      <Input
        aria-label="Device MAC"
        placeholder="Device MAC"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text.trim() !== value && onChange(text.trim())}
        className="h-8 rounded-md font-mono text-xs"
        spellCheck={false}
        autoComplete="off"
      />
    </form>
  )
}

function Totals({
  page,
  filtered,
  decimalsOf,
}: {
  page: { totals: Array<{ currency: string; amount: number; count: number }>; total: number } | undefined
  filtered: boolean
  /** Totals are per currency in minor units; the rows or a table of that currency know the decimals. */
  decimalsOf: (currency: string) => number
}) {
  if (!page) return null
  return (
    <section className="card-surface flex flex-wrap items-end gap-x-8 gap-y-3 p-4" aria-label="Totals">
      {page.totals.length === 0 ? (
        <div>
          <p className="text-[11px] text-muted-foreground">Paid{filtered ? ' (these filters)' : ''}</p>
          <p className="text-2xl font-semibold tabular-nums">—</p>
        </div>
      ) : (
        page.totals.map((t) => (
          <div key={t.currency}>
            <p className="text-[11px] text-muted-foreground">Paid in {t.currency}{filtered ? ' (these filters)' : ''}</p>
            <p className="text-2xl font-semibold tabular-nums">
              {moneyText(t.amount, t.currency, decimalsOf(t.currency))}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {t.count} payment{t.count === 1 ? '' : 's'}
            </p>
          </div>
        ))
      )}
      <div className="ml-auto text-right">
        <p className="text-[11px] text-muted-foreground">Rows</p>
        <p className="text-sm font-medium tabular-nums">{page.total}</p>
      </div>
    </section>
  )
}

function deviceLabel(c: HotspotCheckout): string {
  if (c.hostname) return c.hostname
  if (c.mac) return c.mac
  return c.kind === 'unclaimed' ? 'Nobody (unclaimed)' : 'Removed (retention)'
}

function LedgerRow({
  checkout: c,
  portal,
  active,
  onOpen,
}: {
  checkout: HotspotCheckout
  portal: Portal | undefined
  active: boolean
  onOpen: () => void
}) {
  const bought = checkoutBought(c)
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          'grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-2.5 text-left text-xs transition-colors hover:bg-muted/40 lg:grid-cols-[8.5rem_6rem_6.5rem_minmax(0,1fr)_minmax(0,9rem)_minmax(0,10rem)] lg:items-center',
          active && 'bg-muted/50',
        )}
      >
        <span className="text-muted-foreground lg:order-none" title={formatDateTime(c.finalizedAt ?? c.createdAt)}>
          {formatDateTime(c.finalizedAt ?? c.createdAt)}
        </span>
        <span
          className={cn(
            'row-span-2 self-center text-right text-sm font-semibold tabular-nums lg:row-span-1 lg:text-xs',
            c.state === 'voided' && 'text-muted-foreground line-through',
          )}
        >
          {checkoutAmount(c)}
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          <CheckoutStateBadge state={c.state} />
          {c.voucher ? <span className="font-mono text-[11px] text-muted-foreground lg:hidden">··{c.voucher.hint}</span> : null}
        </span>
        <span className="col-span-2 truncate text-muted-foreground lg:col-span-1 lg:text-foreground">
          {bought ?? (c.reason ? CHECKOUT_REASON_LABELS[c.reason] : '—')}
          {c.voucher ? <span className="ml-1.5 hidden font-mono text-[11px] text-muted-foreground lg:inline">··{c.voucher.hint}</span> : null}
        </span>
        <span className="col-span-2 truncate text-[11px] text-muted-foreground lg:col-span-1 lg:text-xs">
          {c.terminal.name ?? 'Terminal removed'}
          {portal ? <span className="lg:hidden"> · {portal.name}</span> : null}
          <span className="lg:hidden"> · {deviceLabel(c)}</span>
        </span>
        <span className={cn('hidden truncate lg:block', !c.mac && 'text-muted-foreground', c.mac && !c.hostname && 'font-mono text-[11px]')}>
          {deviceLabel(c)}
        </span>
      </button>
    </li>
  )
}

// ── Detail drawer ────────────────────────────────────────────────────────

type Action = 'void' | 'credit' | 'dismiss' | null

function CheckoutDrawer({
  id,
  preview,
  portals,
  terminals,
  isAdmin,
  onClose,
}: {
  id: number | null
  preview: HotspotCheckout | null
  portals: Portal[]
  terminals: HotspotTerminal[]
  isAdmin: boolean
  onClose: () => void
}) {
  // The last checkout shown stays in the drawer while it slides out.
  const shownId = useRetained(id)
  const shownPreview = useRetained(preview)
  const detail = useHotspotCheckout(shownId)
  const c = detail.data ?? shownPreview
  const [action, setAction] = useState<Action>(null)
  const [delivery, setDelivery] = useState<PortalDelivery | null>(null)
  const portal = c ? portals.find((p) => p.id === c.portalId) : undefined
  const terminal = c?.terminal.id ? terminals.find((t) => t.id === c.terminal.id) : undefined

  return (
    <Drawer
      open={id !== null}
      onOpenChange={(open) => {
        if (!open) {
          setAction(null)
          setDelivery(null)
          onClose()
        }
      }}
    >
      <DrawerContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {c ? (
              <>
                <span className={cn('text-base tabular-nums', c.state === 'voided' && 'line-through')}>{checkoutAmount(c)}</span>
                <CheckoutStateBadge state={c.state} />
                {delivery ? <DeliveryBadge delivery={delivery} /> : null}
              </>
            ) : (
              'Payment'
            )}
          </DialogTitle>
          {c ? (
            <DialogDescription>
              {c.kind === 'payment' ? 'Payment' : 'Unclaimed coins'} · {formatDateTime(c.finalizedAt ?? c.createdAt)}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <DialogBody className="space-y-5">
          {!c && detail.isPending ? <p className="text-muted-foreground">Loading…</p> : null}
          <ErrorNote error={detail.error} />
          {c ? (
            <>
              {isAdmin && c.kind === 'payment' && c.state === 'paid' ? (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="destructive" onClick={() => setAction('void')}>
                    <Prohibit className="size-3.5" />
                    Void (refund)
                  </Button>
                </div>
              ) : null}
              {isAdmin && c.kind === 'unclaimed' && c.state === 'unclaimed' ? (
                <div className="space-y-2 rounded-md border border-status-warning/50 bg-status-warning/10 p-3">
                  <p>
                    {c.reason ? CHECKOUT_REASON_LABELS[c.reason] : 'Coins without a checkout'}. Nobody got time for this money
                    yet.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => setAction('credit')}>
                      <Ticket className="size-3.5" />
                      Credit as a code
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setAction('dismiss')}>
                      Dismiss
                    </Button>
                  </div>
                </div>
              ) : null}

              <dl className="grid grid-cols-2 gap-3">
                <Fact label="Portal">
                  {portal ? (
                    <Link to={`/portal/portals/${portal.id}`} className="underline-offset-2 hover:underline">
                      {portal.name}
                    </Link>
                  ) : c.portalId ? (
                    `Portal ${c.portalId}`
                  ) : (
                    '—'
                  )}
                </Fact>
                <Fact label="Terminal">{terminal?.name ?? c.terminal.name ?? 'Removed'}</Fact>
                <Fact label="Bought">{checkoutBought(c) ?? '—'}</Fact>
                <Fact label="How it ended">{c.reason ? CHECKOUT_REASON_LABELS[c.reason] : '—'}</Fact>
                {c.unusedAmount > 0 ? (
                  <Fact label="Unused (below the cheapest rate)">{moneyText(c.unusedAmount, c.currency, c.decimals)}</Fact>
                ) : null}
                {c.entitlement?.durationMode ? (
                  <Fact label="Time counts">
                    {DURATION_MODE_LABELS[c.entitlement.durationMode as keyof typeof DURATION_MODE_LABELS] ?? c.entitlement.durationMode}
                  </Fact>
                ) : null}
              </dl>

              <ReferenceSection checkout={c} />
              <DeviceSection checkout={c} />
              <CoinsTimeline checkout={c} />
              <PriceSnapshot checkout={c} />
              <ResolutionSection checkout={c} />

              <details className="text-[11px] text-muted-foreground">
                <summary className="cursor-pointer select-none">Technical details</summary>
                <dl className="mt-2 grid grid-cols-2 gap-2">
                  <Fact label="Checkout reference">
                    <span className="font-mono">{c.checkoutRef ?? '—'}</span>
                  </Fact>
                  <Fact label="Gateway">{c.gatewayId}</Fact>
                  <Fact label="Signing key epoch">{c.keyEpoch ?? '—'}</Fact>
                  <Fact label="Recorded">{formatDateTime(c.createdAt)}</Fact>
                </dl>
              </details>
            </>
          ) : null}
        </DialogBody>
        {c && action === 'void' ? (
          <VoidDialog checkout={c} onClose={() => setAction(null)} onDone={setDelivery} />
        ) : null}
        {c && action === 'credit' ? (
          <CreditDialog checkout={c} onClose={() => setAction(null)} onDone={setDelivery} />
        ) : null}
        {c && action === 'dismiss' ? <DismissDialog checkout={c} onClose={() => setAction(null)} /> : null}
      </DrawerContent>

    </Drawer>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  )
}

function ReferenceSection({ checkout: c }: { checkout: HotspotCheckout }) {
  if (!c.voucher) return null
  return (
    <Section title={c.kind === 'payment' ? 'Reference code' : 'Credit code'}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-medium">·····-·{c.voucher.hint}</span>
        <VoucherStatusBadge status={c.voucher.status} />
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {c.kind === 'payment'
          ? 'The guest saw this code after paying. Perch never shows the whole code again: ask the guest for it. Entering it on another phone moves what is left there.'
          : 'Handed to the guest when the coins were credited.'}{' '}
        Look a code up under{' '}
        <Link to="/portal/vouchers" className="underline underline-offset-2">
          Vouchers
        </Link>
        .
      </p>
    </Section>
  )
}

function DeviceSection({ checkout: c }: { checkout: HotspotCheckout }) {
  return (
    <Section title="Device">
      {c.mac ? (
        <dl className="grid grid-cols-2 gap-3">
          <Fact label="MAC">
            <Link to={`/devices/${encodeURIComponent(c.mac)}`} className="font-mono underline-offset-2 hover:underline">
              {c.mac}
            </Link>
          </Fact>
          <Fact label="Name">{c.hostname ?? '—'}</Fact>
          <Fact label="Address">{c.ip ?? '—'}</Fact>
        </dl>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          {c.kind === 'unclaimed'
            ? 'No device: the money reached the terminal while no checkout was open.'
            : 'Removed after the session retention (the amount stays).'}
        </p>
      )}
    </Section>
  )
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function CoinsTimeline({ checkout: c }: { checkout: HotspotCheckout }) {
  const opened = c.openedAt ? Date.parse(c.openedAt) : null
  const coins = [...c.coins].sort((a, b) => a.at - b.at)
  return (
    <Section title={`Coins (${c.coinCount})`}>
      <ol className="relative space-y-2 border-l border-border pl-4">
        {opened !== null ? (
          <li className="text-[11px] text-muted-foreground">
            <span className="absolute -left-[3.5px] mt-1 size-1.5 rounded-full bg-border" />
            Checkout opened · {formatDateTime(c.openedAt)}
          </li>
        ) : null}
        {coins.map((coin) => (
          <li key={coin.eventId} className="flex items-baseline justify-between gap-3 text-xs">
            <span className="absolute -left-[4.5px] mt-1 size-2 rounded-full bg-status-good" />
            <span className="flex items-baseline gap-2">
              <Coins className="size-3.5 self-center text-muted-foreground" />
              <span className="font-medium tabular-nums">{moneyText(coin.amount, c.currency, c.decimals)}</span>
              <span className="font-mono text-[10.5px] text-muted-foreground">{coin.eventId}</span>
            </span>
            <span className="text-[11px] text-muted-foreground tabular-nums" title={new Date(coin.at).toLocaleString()}>
              {opened !== null ? clock(coin.at - opened) : new Date(coin.at).toLocaleTimeString()}
            </span>
          </li>
        ))}
        {coins.length === 0 ? <li className="text-[11px] text-muted-foreground">No coin details reported.</li> : null}
        {c.finalizedAt ? (
          <li className="text-[11px] text-muted-foreground">
            <span className="absolute -left-[3.5px] mt-1 size-1.5 rounded-full bg-border" />
            {c.kind === 'payment' ? 'Finalised' : 'Recorded'}
            {c.reason ? ` (${CHECKOUT_REASON_LABELS[c.reason].toLowerCase()})` : ''} · {formatDateTime(c.finalizedAt)}
          </li>
        ) : null}
      </ol>
    </Section>
  )
}

function PriceSnapshot({ checkout: c }: { checkout: HotspotCheckout }) {
  const snap = c.price?.snapshot
  if (!c.price) return null
  return (
    <Section title="Price at checkout">
      {snap ? (
        <>
          <p className="text-[11px] text-muted-foreground">
            {snap.name}, revision {snap.revision} · locked when the guest started paying
          </p>
          <ul className="divide-y divide-border rounded-md border border-border">
            {[...snap.entries]
              .sort((a, b) => a.amount - b.amount)
              .map((e) => (
                <li key={e.amount} className="flex items-baseline justify-between gap-3 px-2.5 py-1.5 text-[11px]">
                  <span className="font-medium tabular-nums">{moneyText(e.amount, snap.currency, snap.decimals)}</span>
                  <span className="text-muted-foreground">{rateLabel(e, snap.durationMode)}</span>
                </li>
              ))}
          </ul>
        </>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          Table {c.price.priceTableId ?? '—'}, revision {c.price.revision ?? '—'} (no snapshot kept).
        </p>
      )}
    </Section>
  )
}

function ResolutionSection({ checkout: c }: { checkout: HotspotCheckout }) {
  if (!c.resolvedAt && !c.note && c.refundAmount === null) return null
  return (
    <Section title={c.state === 'voided' ? 'Voided' : c.state === 'credited' ? 'Credited' : c.state === 'dismissed' ? 'Dismissed' : 'Note'}>
      <dl className="grid grid-cols-2 gap-3">
        {c.refundAmount !== null ? <Fact label="Refunded">{moneyText(c.refundAmount, c.currency, c.decimals)}</Fact> : null}
        {c.resolvedAt ? <Fact label="When">{formatDateTime(c.resolvedAt)}</Fact> : null}
        {c.resolvedBy ? <Fact label="By">{c.resolvedBy.email}</Fact> : null}
      </dl>
      {c.note ? <p className="rounded-md border border-border bg-muted/20 p-2.5 text-xs whitespace-pre-wrap">{c.note}</p> : null}
    </Section>
  )
}

// ── Actions ──────────────────────────────────────────────────────────────

function VoidDialog({
  checkout: c,
  onClose,
  onDone,
}: {
  checkout: HotspotCheckout
  onClose: () => void
  onDone: (delivery: PortalDelivery) => void
}) {
  const voidCheckout = useVoidCheckout()
  const decimals = c.decimals ?? 0
  const [refund, setRefund] = useState(minorToMajorText(c.amount, decimals))
  const [note, setNote] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const fieldErrors = vineFieldErrors(voidCheckout.error)

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setLocalError(null)
    const amount = parseMoney(refund, decimals)
    if (amount !== undefined && (!Number.isSafeInteger(amount) || amount > c.amount)) {
      return setLocalError(`Refund at most ${checkoutAmount(c)}.`)
    }
    voidCheckout.mutate(
      { id: c.id, refundAmount: amount ?? null, note: note.trim() || null },
      {
        onSuccess: (result) => {
          onDone(result.delivery)
          onClose()
        },
      },
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>Void this payment?</DialogTitle>
            <DialogDescription>
              For a refund or a mistake. The reference code stops working and every device using it goes offline. Handing
              the money back happens outside Perch: record what you did.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <FormField
              label={`Refunded (${c.currency ?? ''})`}
              htmlFor="void-refund"
              error={fieldErrors.refundAmount}
              hint={`Paid: ${checkoutAmount(c)}. Leave empty if no money went back.`}
            >
              <Input id="void-refund" inputMode="decimal" value={refund} onChange={(e) => setRefund(e.target.value)} className="rounded-md tabular-nums" />
            </FormField>
            <FormField label="Note" htmlFor="void-note" error={fieldErrors.note} hint="Up to 200 characters.">
              <Input id="void-note" maxLength={200} value={note} placeholder="e.g. Guest could not connect, refunded at the desk" onChange={(e) => setNote(e.target.value)} className="rounded-md" />
            </FormField>
            {localError ? <p className="text-xs text-destructive">{localError}</p> : null}
            <ErrorNote error={voidCheckout.error && Object.keys(fieldErrors).length === 0 ? voidCheckout.error : null} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={voidCheckout.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={voidCheckout.isPending}>
              {voidCheckout.isPending ? 'Working…' : 'Void payment'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function CreditDialog({
  checkout: c,
  onClose,
  onDone,
}: {
  checkout: HotspotCheckout
  onClose: () => void
  onDone: (delivery: PortalDelivery) => void
}) {
  const credit = useCreditCheckout()
  const [custom, setCustom] = useState(false)
  const [duration, setDuration] = useState<{ amount: string; unit: DurationUnit }>({ amount: '30', unit: 'min' })
  const [note, setNote] = useState('')
  const [code, setCode] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const fieldErrors = vineFieldErrors(credit.error)
  const needMinutes = apiErrorCode(credit.error) === 'below_minimum'

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setLocalError(null)
    let minutes: number | null = null
    if (custom || needMinutes) {
      const m = toMinutes(duration.amount, duration.unit)
      if (m === undefined || !Number.isSafeInteger(m) || m < 1) return setLocalError('Give the time to credit.')
      minutes = m
    }
    credit.mutate(
      { id: c.id, minutes, note: note.trim() || null },
      {
        onSuccess: (result) => {
          onDone(result.delivery)
          setCode(result.code)
        },
      },
    )
  }

  if (code) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent onInteractOutside={(event) => event.preventDefault()}>
          <DialogHeader>
            <DialogTitle>Code for the guest</DialogTitle>
            <DialogDescription>Shown once. The guest enters it on the portal’s sign-in page.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3 sm:flex-row sm:items-center">
              <code className="min-w-0 flex-1 font-mono text-lg tracking-wider select-all">{code}</code>
              <CopyButton value={code} label="Copy code" ariaLabel="Copy the voucher code" className="shrink-0" />
            </div>
            <p className="text-muted-foreground">Write it down or copy it now: Perch keeps only a fingerprint.</p>
          </DialogBody>
          <DialogFooter>
            <Button onClick={onClose}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>Credit {checkoutAmount(c)} as a code</DialogTitle>
            <DialogDescription>
              Makes a one-device voucher for the guest who lost these coins. By default it buys what the amount buys at the
              terminal’s current prices.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" className="size-3.5 accent-primary" checked={custom || Boolean(needMinutes)} disabled={Boolean(needMinutes)} onChange={(e) => setCustom(e.target.checked)} />
              Give a set time instead
            </label>
            {custom || needMinutes ? (
              <FormField label="Time" htmlFor="credit-minutes" error={fieldErrors.minutes}>
                <DurationInput id="credit-minutes" {...duration} onChange={setDuration} placeholder="Time" />
              </FormField>
            ) : null}
            {needMinutes ? (
              <p className="text-xs text-muted-foreground">This amount buys nothing at the current prices: give a time.</p>
            ) : null}
            <FormField label="Note" htmlFor="credit-note" error={fieldErrors.note}>
              <Input id="credit-note" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Guest at the desk, coin jammed" className="rounded-md" />
            </FormField>
            {localError ? <p className="text-xs text-destructive">{localError}</p> : null}
            <ErrorNote error={credit.error && !needMinutes && Object.keys(fieldErrors).length === 0 ? credit.error : null} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={credit.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={credit.isPending}>
              {credit.isPending ? 'Working…' : 'Credit and show code'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DismissDialog({ checkout: c, onClose }: { checkout: HotspotCheckout; onClose: () => void }) {
  const dismiss = useDismissCheckout()
  const [note, setNote] = useState('')
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            dismiss.mutate({ id: c.id, note: note.trim() || null }, { onSuccess: onClose })
          }}
        >
          <DialogHeader>
            <DialogTitle>Dismiss {checkoutAmount(c)}?</DialogTitle>
            <DialogDescription>
              Nobody gets time for it. Use this when the guest was paid back in cash, or it was a test coin.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <FormField label="Note" htmlFor="dismiss-note">
              <Input id="dismiss-note" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} className="rounded-md" />
            </FormField>
            <ErrorNote error={dismiss.error} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={dismiss.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={dismiss.isPending}>
              {dismiss.isPending ? 'Working…' : 'Dismiss'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
