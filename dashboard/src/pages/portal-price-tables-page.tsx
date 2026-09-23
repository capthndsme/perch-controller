import { useMemo, useState } from 'react'
import { ClockCounterClockwise, CurrencyCircleDollar, PencilSimple, Plus, Trash, X } from '@phosphor-icons/react'
import { PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import { PageSpinner } from '@/components/ui/spinner'
import { HotspotExplainer } from '@/components/portal/hotspot-ui'
import {
  ConfirmDialog,
  DeliveryBadge,
  DurationInput,
  ErrorNote,
  FormField,
  PortalSectionNav,
  QuotaInput,
} from '@/components/portal/portal-ui'
import { useConfirm } from '@/hooks/use-confirm'
import {
  useCreatePriceTable,
  useDeletePriceTable,
  useHotspotTerminals,
  usePriceQuote,
  usePriceTable,
  usePriceTables,
  useUpdatePriceTable,
} from '@/hooks/use-hotspot'
import { useIsPortalAdmin, usePortals } from '@/hooks/use-portal'
import { apiErrorCode } from '@/lib/api'
import {
  DURATION_MODE_LABELS,
  entitlementLabel,
  minorToMajorText,
  moneyText,
  parseMoney,
  priceDraft,
  rateLabel,
} from '@/lib/hotspot'
import {
  errorDetail,
  formatDateTime,
  formatKbps,
  kbpsToMbpsText,
  mbpsToKbps,
  selectClassName,
  splitBytes,
  splitMinutes,
  toBytes,
  toMinutes,
  vineFieldErrors,
  type DurationUnit,
  type QuotaUnit,
} from '@/lib/portal'
import type { PortalDelivery, PriceDurationMode, PriceEntry, PriceTable, PriceTablePayload } from '@/types/api'

/** `/portal/price-tables`: what coins buy on the Paid Hotspot (portal.md §14.2). */
export function PortalPriceTablesPage() {
  const { isAdmin } = useIsPortalAdmin()
  const tables = usePriceTables()
  const portals = usePortals()
  const terminals = useHotspotTerminals()
  const [editing, setEditing] = useState<PriceTable | 'new' | null>(null)
  const [history, setHistory] = useState<PriceTable | null>(null)
  const [delivery, setDelivery] = useState<PortalDelivery | null>(null)
  const confirmDelete = useConfirm<PriceTable>()
  const remove = useDeletePriceTable()

  if (tables.isPending) return <PageSpinner label="Loading price tables" />

  const portalName = (id: number) => portals.data?.find((p) => p.id === id)?.name ?? `Portal ${id}`
  const terminalName = (id: number) => terminals.data?.find((t) => t.id === id)?.name ?? `Terminal ${id}`
  const inUse = errorDetail<number[]>(remove.error, 'portalIds')
  const inUseTerminals = errorDetail<number[]>(remove.error, 'terminalIds')

  return (
    <div className="flex w-full flex-col gap-5">
      <PageHeader
        title="Price tables"
        crumbs={[{ label: 'Guest portal', to: '/portal' }, { label: 'Price tables' }]}
        description="What an amount of money buys on a paid portal: time, optionally data, and a speed tier."
        actions={
          isAdmin ? (
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus className="size-3.5" />
              New price table
            </Button>
          ) : null
        }
      />
      <PortalSectionNav />
      {delivery === 'pending' ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <DeliveryBadge delivery="pending" /> Saved. Gateways that are offline get the new prices when they are back.
        </p>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="flex min-w-0 flex-col gap-4">
          {tables.error ? <ErrorNote error={tables.error} /> : null}
          {tables.data && tables.data.length === 0 ? (
            <section className="card-surface p-4">
              <EmptyState
                icon={<CurrencyCircleDollar className="size-6" />}
                title="No price tables"
                description={
                  isAdmin
                    ? 'Create one, then turn on “Paid access” in a portal and pick it.'
                    : 'An admin can create one for a paid portal.'
                }
              />
            </section>
          ) : null}
          {(tables.data ?? []).map((table) => (
            <PriceTableCard
              key={table.id}
              table={table}
              isAdmin={isAdmin}
              usedBy={[
                ...table.usedBy.portalIds.map(portalName),
                ...table.usedBy.terminalIds.map((id) => `${terminalName(id)} (terminal)`),
              ]}
              onEdit={() => setEditing(table)}
              onHistory={() => setHistory(table)}
              onDelete={() => {
                remove.reset()
                confirmDelete.open(table)
              }}
            />
          ))}
        </div>

        <Panel title="How pricing works" className="self-start">
          <div className="space-y-3 text-[11px] leading-relaxed text-muted-foreground">
            <p>
              Like a coin box: the largest rate that fits is taken as often as it fits, then the next smaller one. Time
              and data add up; the speed is that of the most expensive rate taken. What is left below the cheapest rate is
              kept as “unused” in the ledger.
            </p>
            <p>
              With rates 1 → 10 min, 5 → 1 h at 5 Mbps and 20 → 5 h at 10 Mbps, paying 7 buys 1 h 20 min at 5 Mbps.
            </p>
            <p>
              A change reaches the gateways at once. A guest who is paying keeps the prices they started with; the ledger
              keeps the revision each payment used.
            </p>
          </div>
          <div className="mt-4 border-t border-border pt-4">
            <HotspotExplainer compact />
          </div>
        </Panel>
      </div>

      {editing ? (
        <PriceTableDialog
          table={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={setDelivery}
        />
      ) : null}
      {history ? <HistoryDialog table={history} onClose={() => setHistory(null)} /> : null}
      <ConfirmDialog
        {...confirmDelete.props}
        title={`Delete ${confirmDelete.target?.name ?? ''}?`}
        description="Past payments keep the prices they were sold at."
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        error={apiErrorCode(remove.error) === 'price_table_in_use' ? null : remove.error}
        onConfirm={() => {
          if (confirmDelete.target) remove.mutate(confirmDelete.target.id, { onSuccess: () => confirmDelete.close() })
        }}
      >
        {apiErrorCode(remove.error) === 'price_table_in_use' ? (
          <p className="rounded-md border border-status-warning/50 bg-status-warning/10 p-2.5">
            Still in use by{' '}
            {[...(inUse ?? []).map(portalName), ...(inUseTerminals ?? []).map((id) => `${terminalName(id)} (terminal)`)].join(', ')}
            . Point them at another table first.
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  )
}

function PriceTableCard({
  table,
  isAdmin,
  usedBy,
  onEdit,
  onHistory,
  onDelete,
}: {
  table: PriceTable
  isAdmin: boolean
  usedBy: string[]
  onEdit: () => void
  onHistory: () => void
  onDelete: () => void
}) {
  const sorted = [...table.entries].sort((a, b) => a.amount - b.amount)
  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center gap-1.5">
          {table.name}
          <Badge variant="outline" className="rounded-sm font-mono text-muted-foreground">
            {table.currency}
          </Badge>
          <Badge variant="outline" className="rounded-sm text-muted-foreground">
            {DURATION_MODE_LABELS[table.durationMode]}
          </Badge>
        </span>
      }
      description={
        <>
          Revision {table.revision} · {usedBy.length ? `Used by ${usedBy.join(', ')}` : 'Not used yet'}
        </>
      }
      actions={
        <>
          <Button size="sm" variant="ghost" onClick={onHistory}>
            <ClockCounterClockwise className="size-3.5" />
            History
          </Button>
          {isAdmin ? (
            <>
              <Button size="sm" variant="outline" onClick={onEdit}>
                <PencilSimple className="size-3.5" />
                Edit
              </Button>
              <Button size="sm" variant="outline" aria-label={`Delete ${table.name}`} onClick={onDelete}>
                <Trash className="size-3.5" />
              </Button>
            </>
          ) : null}
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,15rem)]">
        <ul className="divide-y divide-border rounded-md border border-border">
          {sorted.map((entry) => (
            <li key={entry.amount} className="flex items-baseline justify-between gap-3 px-3 py-2 text-xs">
              <span className="font-semibold tabular-nums">{entry.amountText}</span>
              <span className="text-right text-muted-foreground">
                {rateLabel(entry, table.durationMode)}
                {entry.upKbps ? ` · ${formatKbps(entry.upKbps)} up` : ''}
              </span>
            </li>
          ))}
        </ul>
        <QuoteBox table={table} />
      </div>
    </Panel>
  )
}

/** "What does 7 buy?" against the saved table, answered by the server's pricing. */
function QuoteBox({ table }: { table: PriceTable }) {
  const cheapest = Math.min(...table.entries.map((e) => e.amount))
  const [text, setText] = useState(minorToMajorText(cheapest > 0 ? cheapest + Math.ceil(cheapest / 2) : 0, table.decimals))
  const amount = parseMoney(text, table.decimals)
  const valid = amount !== undefined && Number.isSafeInteger(amount) && amount <= 10_000_000
  const quote = usePriceQuote(table.id, valid ? amount : null)
  const id = `quote-${table.id}`
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
      <label htmlFor={id} className="block text-[11px] font-medium text-muted-foreground">
        What does this buy?
      </label>
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-xs text-muted-foreground">{table.currency}</span>
        <Input
          id={id}
          inputMode="decimal"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="h-8 rounded-md tabular-nums"
        />
      </div>
      {!valid && text.trim() !== '' ? (
        <p className="text-[11px] text-destructive">
          Up to {table.decimals} decimal{table.decimals === 1 ? '' : 's'}.
        </p>
      ) : quote.data ? (
        <div className="space-y-0.5" aria-live="polite">
          <p className="text-sm font-semibold">{quote.data.text ?? 'Nothing yet'}</p>
          {quote.data.upKbps ? <p className="text-[11px] text-muted-foreground">{formatKbps(quote.data.upKbps)} up</p> : null}
          {quote.data.unusedAmount > 0 ? (
            <p className="text-[11px] text-muted-foreground">
              {moneyText(quote.data.unusedAmount, table.currency, table.decimals)} would stay unused
            </p>
          ) : null}
          {!quote.data.text && quote.data.amount > 0 ? (
            <p className="text-[11px] text-muted-foreground">Below the cheapest rate: the guest could not press Done.</p>
          ) : null}
        </div>
      ) : quote.error ? (
        <ErrorNote error={quote.error} />
      ) : (
        <p className="text-[11px] text-muted-foreground">…</p>
      )}
    </div>
  )
}

function HistoryDialog({ table, onClose }: { table: PriceTable; onClose: () => void }) {
  const detail = usePriceTable(table.id)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>History of {table.name}</DialogTitle>
          <DialogDescription>Every change is a revision; each payment in the ledger names the one it was sold at.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {detail.isPending ? <p className="text-muted-foreground">Loading…</p> : null}
          <ErrorNote error={detail.error} />
          <ol className="space-y-3">
            {(detail.data?.revisions ?? []).map((rev) => (
              <li key={rev.revision} className="rounded-md border border-border p-2.5">
                <p className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    Revision {rev.revision}
                    {rev.revision === table.revision ? <span className="ml-1.5 text-muted-foreground">(current)</span> : null}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{formatDateTime(rev.createdAt)}</span>
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {rev.name} · {rev.currency} · {DURATION_MODE_LABELS[rev.durationMode]}
                </p>
                <ul className="mt-1 space-y-0.5 text-[11px]">
                  {[...rev.entries]
                    .sort((a, b) => a.amount - b.amount)
                    .map((e) => (
                      <li key={e.amount}>
                        <span className="font-medium tabular-nums">{moneyText(e.amount, rev.currency, rev.decimals)}</span>{' '}
                        <span className="text-muted-foreground">{rateLabel(e, rev.durationMode)}</span>
                      </li>
                    ))}
                </ul>
              </li>
            ))}
          </ol>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Editor ───────────────────────────────────────────────────────────────

type EntryDraft = {
  key: number
  amount: string
  duration: { amount: string; unit: DurationUnit }
  quota: { amount: string; unit: QuotaUnit }
  down: string
  up: string
}

let entryKey = 0

function draftOf(entry: PriceEntry | null, decimals: number): EntryDraft {
  return {
    key: ++entryKey,
    amount: entry ? minorToMajorText(entry.amount, decimals) : '',
    duration: entry ? splitMinutes(entry.minutes) : { amount: '', unit: 'h' },
    quota: splitBytes(entry?.quotaBytes ?? null),
    down: kbpsToMbpsText(entry?.downKbps ?? null),
    up: kbpsToMbpsText(entry?.upKbps ?? null),
  }
}

const STARTER: PriceEntry[] = [
  { amount: 1, minutes: 10, quotaBytes: null, downKbps: null, upKbps: null },
  { amount: 5, minutes: 60, quotaBytes: null, downKbps: 5000, upKbps: 2000 },
  { amount: 20, minutes: 300, quotaBytes: null, downKbps: 10000, upKbps: 5000 },
]

const MODES: ReadonlyArray<{ id: PriceDurationMode; label: string; title: string }> = [
  { id: 'wall_clock', label: 'Clock time', title: 'Time runs from the moment the guest is online, used or not.' },
  { id: 'active_time', label: 'Time online', title: 'Time runs only while the device is connected and active.' },
]

function PriceTableDialog({
  table,
  onClose,
  onSaved,
}: {
  table: PriceTable | null
  onClose: () => void
  onSaved: (delivery: PortalDelivery) => void
}) {
  const create = useCreatePriceTable()
  const update = useUpdatePriceTable()
  const mutation = table ? update : create
  const [name, setName] = useState(table?.name ?? 'Standard rates')
  const [currency, setCurrency] = useState(table?.currency ?? 'PHP')
  const [decimals, setDecimals] = useState(table?.decimals ?? 0)
  const [mode, setMode] = useState<PriceDurationMode>(table?.durationMode ?? 'wall_clock')
  const [rows, setRows] = useState<EntryDraft[]>(() =>
    (table ? table.entries : STARTER).map((e) => draftOf(e, table?.decimals ?? 0)),
  )
  const [previewText, setPreviewText] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const fieldErrors = vineFieldErrors(mutation.error)

  const parsed = useMemo(
    () =>
      rows.map((row) => {
        const amount = parseMoney(row.amount, decimals)
        const minutes = toMinutes(row.duration.amount, row.duration.unit)
        const quotaBytes = toBytes(row.quota.amount, row.quota.unit) ?? null
        const downKbps = mbpsToKbps(row.down) ?? null
        const upKbps = mbpsToKbps(row.up) ?? null
        const ok =
          amount !== undefined &&
          Number.isSafeInteger(amount) &&
          amount >= 1 &&
          minutes !== undefined &&
          Number.isSafeInteger(minutes) &&
          minutes >= 1 &&
          (quotaBytes === null || quotaBytes >= 1e6) &&
          (downKbps === null || downKbps >= 64) &&
          (upKbps === null || upKbps >= 64)
        return { ok, entry: { amount: amount ?? 0, minutes: minutes ?? 0, quotaBytes, downKbps, upKbps } as PriceEntry }
      }),
    [rows, decimals],
  )
  const validEntries = parsed.filter((p) => p.ok).map((p) => p.entry)
  const amounts = validEntries.map((e) => e.amount)
  const duplicate = amounts.length !== new Set(amounts).size
  const withQuota = validEntries.filter((e) => e.quotaBytes !== null).length
  const mixed = withQuota > 0 && withQuota < validEntries.length
  const previewAmount = parseMoney(previewText, decimals)
  const preview =
    previewAmount !== undefined && Number.isSafeInteger(previewAmount) ? priceDraft(validEntries, previewAmount) : null

  function patch(key: number, next: Partial<EntryDraft>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...next } : row)))
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setLocalError(null)
    const bad = parsed.findIndex((p) => !p.ok)
    if (rows.length === 0) return setLocalError('Add at least one rate.')
    if (bad >= 0) {
      return setLocalError(
        `Rate ${bad + 1}: give an amount (up to ${decimals} decimal${decimals === 1 ? '' : 's'}) and a duration; data at least 1 MB, speeds at least 0.064 Mbps.`,
      )
    }
    if (duplicate) return setLocalError('Two rates have the same amount.')
    if (mixed) return setLocalError('Either every rate includes data or none does.')
    const payload: PriceTablePayload = {
      name: name.trim(),
      currency: currency.trim().toUpperCase(),
      decimals,
      durationMode: mode,
      entries: validEntries,
    }
    if (table) {
      update.mutate(
        { id: table.id, ...payload },
        {
          onSuccess: (result) => {
            onSaved(result.delivery)
            onClose()
          },
        },
      )
    } else {
      create.mutate(payload, { onSuccess: onClose })
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent wide>
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>{table ? `Edit ${table.name}` : 'New price table'}</DialogTitle>
            <DialogDescription>
              {table
                ? 'Saving makes a new revision and sends it to the gateways. Guests who are paying right now keep the old prices.'
                : 'Rates a coin terminal sells. A portal uses one table; a terminal may use its own.'}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_6rem_7rem]">
              <FormField label="Name" htmlFor="pt-name" error={fieldErrors.name}>
                <Input id="pt-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} className="rounded-md" />
              </FormField>
              <FormField label="Currency" htmlFor="pt-currency" error={fieldErrors.currency} hint="ISO code">
                <Input
                  id="pt-currency"
                  required
                  maxLength={3}
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                  className="rounded-md font-mono uppercase"
                />
              </FormField>
              <FormField label="Decimals" htmlFor="pt-decimals" error={fieldErrors.decimals} hint="0 = whole coins">
                <select
                  id="pt-decimals"
                  className={selectClassName}
                  value={decimals}
                  disabled={Boolean(table)}
                  title={table ? 'Amounts are stored in minor units: make a new table to change this.' : undefined}
                  onChange={(e) => setDecimals(Number(e.target.value))}
                >
                  {[0, 1, 2, 3].map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>

            <div className="space-y-1.5">
              <p className="text-xs font-medium">Time counts</p>
              <Segmented ariaLabel="How time counts" size="xs" value={mode} options={MODES} onChange={setMode} className="w-fit" />
              <p className="text-[11px] text-muted-foreground">{MODES.find((m) => m.id === mode)?.title}</p>
            </div>

            <fieldset className="space-y-2">
              <legend className="mb-1 text-xs font-medium">Rates</legend>
              <ol className="space-y-2">
                {rows.map((row, index) => (
                  <li key={row.key} className="relative rounded-md border border-border p-2.5 pr-9">
                    <div className="grid gap-2 sm:grid-cols-[6.5rem_minmax(0,1fr)_minmax(0,1fr)]">
                      <FormField label={`Amount (${currency || '…'})`} htmlFor={`pt-amount-${row.key}`}>
                        <Input
                          id={`pt-amount-${row.key}`}
                          inputMode="decimal"
                          value={row.amount}
                          onChange={(e) => patch(row.key, { amount: e.target.value })}
                          className="rounded-md tabular-nums"
                        />
                      </FormField>
                      <FormField label="Buys" htmlFor={`pt-minutes-${row.key}`}>
                        <DurationInput
                          id={`pt-minutes-${row.key}`}
                          {...row.duration}
                          placeholder="Time"
                          onChange={(duration) => patch(row.key, { duration })}
                        />
                      </FormField>
                      <FormField label="Data (optional)" htmlFor={`pt-quota-${row.key}`}>
                        <QuotaInput id={`pt-quota-${row.key}`} {...row.quota} onChange={(quota) => patch(row.key, { quota })} />
                      </FormField>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2 sm:w-2/3">
                      <FormField label="Down Mbps (optional)" htmlFor={`pt-down-${row.key}`}>
                        <Input
                          id={`pt-down-${row.key}`}
                          inputMode="decimal"
                          placeholder="No cap"
                          value={row.down}
                          onChange={(e) => patch(row.key, { down: e.target.value })}
                          className="rounded-md"
                        />
                      </FormField>
                      <FormField label="Up Mbps (optional)" htmlFor={`pt-up-${row.key}`}>
                        <Input
                          id={`pt-up-${row.key}`}
                          inputMode="decimal"
                          placeholder="No cap"
                          value={row.up}
                          onChange={(e) => patch(row.key, { up: e.target.value })}
                          className="rounded-md"
                        />
                      </FormField>
                    </div>
                    {fieldErrors[`entries.${index}.amount`] ?? fieldErrors[`entries.${index}.minutes`] ? (
                      <p className="mt-1 text-xs text-destructive">
                        {fieldErrors[`entries.${index}.amount`] ?? fieldErrors[`entries.${index}.minutes`]}
                      </p>
                    ) : null}
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      className="absolute top-2 right-2"
                      aria-label={`Remove rate ${index + 1}`}
                      disabled={rows.length <= 1}
                      onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ol>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={rows.length >= 32}
                onClick={() => setRows((current) => [...current, draftOf(null, decimals)])}
              >
                <Plus className="size-3.5" />
                Add rate
              </Button>
              {duplicate ? <p className="text-xs text-destructive">Two rates have the same amount.</p> : null}
              {mixed ? <p className="text-xs text-destructive">Either every rate includes data or none does.</p> : null}
            </fieldset>

            <div className="space-y-1.5 rounded-md border border-border bg-muted/20 p-3">
              <label htmlFor="pt-preview" className="block text-xs font-medium">
                Try an amount
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="pt-preview"
                  inputMode="decimal"
                  placeholder="e.g. 7"
                  value={previewText}
                  onChange={(e) => setPreviewText(e.target.value)}
                  className="h-8 w-28 rounded-md tabular-nums"
                />
                <span className="text-xs" aria-live="polite">
                  {preview && preview.amount > 0
                    ? (entitlementLabel({ ...preview, durationMode: mode }) ?? 'Too little for any rate') +
                      (preview.unusedAmount > 0 && preview.durationSeconds > 0
                        ? ` (${moneyText(preview.unusedAmount, currency, decimals)} unused)`
                        : '')
                    : previewText.trim()
                      ? '—'
                      : 'buys…'}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground">Uses the rates above as typed, before saving.</p>
            </div>

            {localError ? <p className="text-xs text-destructive">{localError}</p> : null}
            <ErrorNote error={mutation.error && Object.keys(fieldErrors).length === 0 ? mutation.error : null} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : table ? 'Save new revision' : 'Create price table'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
