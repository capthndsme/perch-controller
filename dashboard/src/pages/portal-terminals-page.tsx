import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowsClockwise, Coins, PencilSimple, Plus, Trash, Warning } from '@phosphor-icons/react'
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
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Panel } from '@/components/ui/panel'
import { PageSpinner } from '@/components/ui/spinner'
import { HotspotExplainer, TerminalStateBadge } from '@/components/portal/hotspot-ui'
import {
  Checkbox,
  ConfirmDialog,
  DeliveryBadge,
  ErrorNote,
  Fact,
  FormField,
  PortalSectionNav,
} from '@/components/portal/portal-ui'
import { TerminalProtocol } from '@/components/portal/terminal-protocol'
import { useConfirm } from '@/hooks/use-confirm'
import {
  useCreateHotspotTerminal,
  useDeleteHotspotTerminal,
  useHotspotTerminals,
  usePriceTables,
  useRotateHotspotTerminal,
  useUpdateHotspotTerminal,
} from '@/hooks/use-hotspot'
import { useIsPortalAdmin, usePortals } from '@/hooks/use-portal'
import { moneyText, routerAddress } from '@/lib/hotspot'
import { normalizeMac, relativeTime, selectClassName, vineFieldErrors } from '@/lib/portal'
import type { HotspotTerminal, HotspotTerminalPayload, Portal, PortalDelivery, PriceTable } from '@/types/api'

/** `/portal/terminals`: coin terminals, the boxes that take money for a paid portal (portal.md §14.3). */
export function PortalTerminalsPage() {
  const { isAdmin } = useIsPortalAdmin()
  const [search, setSearch] = useSearchParams()
  const portalFilter = Number(search.get('portalId')) || undefined
  const portals = usePortals()
  const tables = usePriceTables()
  const terminals = useHotspotTerminals({ portalId: portalFilter })
  const [editing, setEditing] = useState<HotspotTerminal | 'new' | null>(null)
  const [token, setToken] = useState<{ terminal: HotspotTerminal; token: string; rotated: boolean; delivery: PortalDelivery } | null>(null)
  const rotate = useRotateHotspotTerminal()
  const remove = useDeleteHotspotTerminal()
  const confirmRotate = useConfirm<HotspotTerminal>()
  const confirmDelete = useConfirm<HotspotTerminal>()

  if (terminals.isPending && !terminals.data) return <PageSpinner label="Loading terminals" />

  const portalList = portals.data ?? []
  const firstPortal = portalList.find((p) => p.id === portalFilter) ?? portalList.find((p) => p.methods.payment) ?? portalList[0]

  return (
    <div className="flex w-full flex-col gap-5">
      <PageHeader
        title="Coin terminals"
        crumbs={[{ label: 'Guest portal', to: '/portal' }, { label: 'Terminals' }]}
        description="Boxes that take money on a paid portal. A guest picks one on the sign-in page, pays, and gets online."
        actions={
          isAdmin ? (
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus className="size-3.5" />
              New terminal
            </Button>
          ) : null
        }
      />
      <PortalSectionNav />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
        <Panel
          title="Terminals"
          flush
          className="self-start"
          actions={
            portalList.length > 1 ? (
              <select
                aria-label="Portal"
                className={`${selectClassName} w-44`}
                value={portalFilter ?? ''}
                onChange={(e) => {
                  const next = new URLSearchParams(search)
                  if (e.target.value) next.set('portalId', e.target.value)
                  else next.delete('portalId')
                  setSearch(next, { replace: true })
                }}
              >
                <option value="">All portals</option>
                {portalList.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            ) : null
          }
        >
          {terminals.error ? <ErrorNote error={terminals.error} className="mx-4 mb-4" /> : null}
          {terminals.data && terminals.data.length === 0 ? (
            <div className="px-4 pb-4">
              <EmptyState
                icon={<Coins className="size-6" />}
                title="No terminals"
                description={
                  isAdmin
                    ? 'Create one per coin box. Its token goes into the box’s firmware.'
                    : 'An admin can add the coin boxes of a paid portal here.'
                }
              />
            </div>
          ) : null}
          {terminals.data && terminals.data.length > 0 ? (
            <ul className="divide-y divide-border border-t border-border">
              {terminals.data.map((terminal) => (
                <TerminalRow
                  key={terminal.id}
                  terminal={terminal}
                  portal={portalList.find((p) => p.id === terminal.portalId)}
                  tables={tables.data ?? []}
                  isAdmin={isAdmin}
                  onEdit={() => setEditing(terminal)}
                  onRotate={() => {
                    rotate.reset()
                    confirmRotate.open(terminal)
                  }}
                  onDelete={() => {
                    remove.reset()
                    confirmDelete.open(terminal)
                  }}
                />
              ))}
            </ul>
          ) : null}
        </Panel>

        <div className="flex min-w-0 flex-col gap-5 self-start">
          <Panel title="Paid access, in short">
            <HotspotExplainer />
          </Panel>
          <Panel title="How a terminal talks to the gateway" description="For whoever builds or programs the box.">
            <TerminalProtocol terminalId="<id>" router={routerAddress(firstPortal)} />
          </Panel>
        </div>
      </div>

      {editing ? (
        <TerminalDialog
          terminal={editing === 'new' ? null : editing}
          portals={portalList}
          tables={tables.data ?? []}
          defaultPortalId={firstPortal?.id ?? null}
          onClose={() => setEditing(null)}
          onCreated={(result) => setToken({ ...result, rotated: false })}
        />
      ) : null}
      {token ? (
        <TokenDialog
          {...token}
          portal={portalList.find((p) => p.id === token.terminal.portalId)}
          onClose={() => setToken(null)}
        />
      ) : null}
      <ConfirmDialog
        {...confirmRotate.props}
        title={`New token for ${confirmRotate.target?.name ?? ''}?`}
        description="The current token stops working as soon as the gateway gets the change (at once while it is online). Put the new one into the box straight away."
        confirmLabel="Rotate token"
        pending={rotate.isPending}
        error={rotate.error}
        onConfirm={() => {
          if (!confirmRotate.target) return
          rotate.mutate(confirmRotate.target.id, {
            onSuccess: (result) => {
              confirmRotate.close()
              setToken({ ...result, rotated: true })
            },
          })
        }}
      />
      <ConfirmDialog
        {...confirmDelete.props}
        title={`Delete ${confirmDelete.target?.name ?? ''}?`}
        description="The box can no longer take payments. Its payments stay in the ledger under its name."
        confirmLabel="Delete terminal"
        destructive
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => {
          if (confirmDelete.target) remove.mutate(confirmDelete.target.id, { onSuccess: () => confirmDelete.close() })
        }}
      />
    </div>
  )
}

function tableName(tables: PriceTable[], id: number | null): string {
  if (id === null) return 'None'
  return tables.find((t) => t.id === id)?.name ?? `Table ${id}`
}

function TerminalRow({
  terminal,
  portal,
  tables,
  isAdmin,
  onEdit,
  onRotate,
  onDelete,
}: {
  terminal: HotspotTerminal
  portal: Portal | undefined
  tables: PriceTable[]
  isAdmin: boolean
  onEdit: () => void
  onRotate: () => void
  onDelete: () => void
}) {
  const table = tables.find((t) => t.id === terminal.effectivePriceTableId)
  const open = terminal.status?.checkout?.state === 'open' ? terminal.status.checkout : null
  return (
    <li className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-start">
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium">{terminal.name}</span>
          <TerminalStateBadge terminal={terminal} />
          <span className="font-mono text-[11px] text-muted-foreground">
            #{terminal.id} · {terminal.prefix}…
          </span>
        </div>
        {open ? (
          <p className="rounded-md border border-brand/30 bg-brand/5 px-2.5 py-1.5 text-xs">
            A guest is paying: <strong className="tabular-nums">{moneyText(open.amount, table?.currency ?? null, table?.decimals ?? 0)}</strong>{' '}
            so far, since {relativeTime(open.openedAt)}.
          </p>
        ) : null}
        {!terminal.tokenRecoverable ? (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <Warning className="mt-0.5 size-3.5 shrink-0" />
            The controller’s key changed, so the gateway cannot check this box’s signatures. Rotate the token.
          </p>
        ) : null}
        {terminal.status?.error ? (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <Warning className="mt-0.5 size-3.5 shrink-0" />
            The box reports: {terminal.status.error}
          </p>
        ) : null}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
          <Fact label="Portal">
            {portal ? (
              <Link to={`/portal/portals/${portal.id}`} className="underline-offset-2 hover:underline">
                {portal.name}
              </Link>
            ) : (
              `Portal ${terminal.portalId}`
            )}
          </Fact>
          <Fact label="Price table">
            {tableName(tables, terminal.effectivePriceTableId)}
            {terminal.priceTableId === null && terminal.effectivePriceTableId !== null ? (
              <span className="text-muted-foreground"> (portal’s)</span>
            ) : null}
          </Fact>
          <Fact label="Last heartbeat">{relativeTime(terminal.lastSeenAt)}</Fact>
          <Fact label="Coin slot">
            {terminal.status?.acceptor ?? '—'}
            {terminal.status?.firmware ? <span className="text-muted-foreground"> · {terminal.status.firmware}</span> : null}
          </Fact>
          {terminal.mac ? (
            <Fact label="Pinned to MAC" className="col-span-2">
              <span className="font-mono">{terminal.mac}</span>
            </Fact>
          ) : null}
        </dl>
      </div>
      {isAdmin ? (
        <div className="flex shrink-0 flex-wrap gap-1.5">
          <Button size="sm" variant="outline" onClick={onEdit}>
            <PencilSimple className="size-3.5" />
            Edit
          </Button>
          <Button size="sm" variant="outline" onClick={onRotate}>
            <ArrowsClockwise className="size-3.5" />
            Rotate token
          </Button>
          <Button size="sm" variant="destructive" aria-label={`Delete ${terminal.name}`} onClick={onDelete}>
            <Trash className="size-3.5" />
          </Button>
        </div>
      ) : null}
    </li>
  )
}

function TerminalDialog({
  terminal,
  portals,
  tables,
  defaultPortalId,
  onClose,
  onCreated,
}: {
  terminal: HotspotTerminal | null
  portals: Portal[]
  tables: PriceTable[]
  defaultPortalId: number | null
  onClose: () => void
  onCreated: (result: { terminal: HotspotTerminal; token: string; delivery: PortalDelivery }) => void
}) {
  const create = useCreateHotspotTerminal()
  const update = useUpdateHotspotTerminal()
  const mutation = terminal ? update : create
  const [name, setName] = useState(terminal?.name ?? '')
  const [portalId, setPortalId] = useState<string>(String(terminal?.portalId ?? defaultPortalId ?? ''))
  const [tableId, setTableId] = useState<string>(terminal?.priceTableId ? String(terminal.priceTableId) : '')
  const [mac, setMac] = useState(terminal?.mac ?? '')
  const [enabled, setEnabled] = useState(terminal?.enabled ?? true)
  const [localError, setLocalError] = useState<string | null>(null)
  const fieldErrors = vineFieldErrors(mutation.error)
  const portal = portals.find((p) => String(p.id) === portalId)
  const portalTable = portal?.payment.priceTableId ?? null

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setLocalError(null)
    if (!portalId) return setLocalError('Choose the portal the terminal serves.')
    let pinned: string | null = null
    if (mac.trim()) {
      pinned = normalizeMac(mac)
      if (!pinned) return setLocalError('That MAC address is not valid.')
    }
    const payload: HotspotTerminalPayload = {
      portalId: Number(portalId),
      name: name.trim(),
      mac: pinned,
      enabled,
      priceTableId: tableId ? Number(tableId) : null,
    }
    if (terminal) {
      update.mutate({ id: terminal.id, ...payload }, { onSuccess: onClose })
    } else {
      create.mutate(
        { ...payload, portalId: Number(portalId), name: name.trim() },
        {
          onSuccess: (result) => {
            onClose()
            onCreated(result)
          },
        },
      )
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>{terminal ? `Edit ${terminal.name}` : 'New coin terminal'}</DialogTitle>
            <DialogDescription>
              A terminal belongs to one portal. Its token is shown once, after you create it.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <FormField label="Name" htmlFor="term-name" error={fieldErrors.name} hint="Guests see it in the terminal picker, e.g. “Lobby, by the door”.">
              <Input id="term-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} className="rounded-md" />
            </FormField>
            <FormField
              label="Portal"
              htmlFor="term-portal"
              error={fieldErrors.portalId}
              hint={portal && !portal.methods.payment ? 'Paid access is off on this portal: guests will not see the terminal until you turn it on.' : undefined}
            >
              <select id="term-portal" className={selectClassName} value={portalId} onChange={(e) => setPortalId(e.target.value)}>
                <option value="">Choose…</option>
                {portals.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.methods.payment ? '' : ' (paid access off)'}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField
              label="Price table"
              htmlFor="term-table"
              error={fieldErrors.priceTableId}
              hint="Usually the portal’s. A terminal can sell at its own rates, e.g. a box that takes bills."
            >
              <select id="term-table" className={selectClassName} value={tableId} onChange={(e) => setTableId(e.target.value)}>
                <option value="">
                  The portal’s{portalTable !== null ? ` (${tableName(tables, portalTable)})` : ' (none set yet)'}
                </option>
                {tables.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · {t.currency}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField
              label="Pin to MAC address (optional)"
              htmlFor="term-mac"
              error={fieldErrors.mac}
              hint="The gateway then refuses requests for this terminal from any other device. Recommended once the box is installed."
            >
              <Input
                id="term-mac"
                placeholder="02:00:00:aa:bb:cc"
                value={mac}
                onChange={(e) => setMac(e.target.value)}
                className="rounded-md font-mono"
                autoComplete="off"
                spellCheck={false}
              />
            </FormField>
            <Checkbox
              id="term-enabled"
              checked={enabled}
              onChange={setEnabled}
              label="Enabled"
              description="A disabled terminal cannot take payments; guests do not see it."
            />
            {localError ? <p className="text-xs text-destructive">{localError}</p> : null}
            <ErrorNote error={mutation.error && Object.keys(fieldErrors).length === 0 ? mutation.error : null} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : terminal ? 'Save' : 'Create and show token'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** The token, once (create, rotate): the controller keeps a hash and an encrypted copy for the gateway. */
function TokenDialog({
  terminal,
  token,
  rotated,
  delivery,
  portal,
  onClose,
}: {
  terminal: HotspotTerminal
  token: string
  rotated: boolean
  delivery: PortalDelivery
  portal: Portal | undefined
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent wide onInteractOutside={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{rotated ? `New token for ${terminal.name}` : `${terminal.name} is ready`}</DialogTitle>
          <DialogDescription>Copy the token into the box now. Perch cannot show it again.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <dl className="grid grid-cols-2 gap-3">
            <Fact label="Terminal id">
              <span className="font-mono">{terminal.id}</span>
            </Fact>
            <Fact label="Gateway address">
              <span className="font-mono">{routerAddress(portal)}</span>
            </Fact>
          </dl>
          <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 font-mono text-xs break-all select-all">{token}</code>
            <CopyButton value={token} label="Copy token" ariaLabel="Copy the terminal token" className="shrink-0" />
          </div>
          <p className="flex items-start gap-2 text-muted-foreground">
            <Warning className="mt-0.5 size-3.5 shrink-0 text-status-warning" />
            Whoever has this token can report coins for this terminal: free time on {portal?.name ?? 'its portal'}, visible
            in the ledger as payments without cash. Keep it in the box only; rotate it if the box is opened or lost.
          </p>
          {delivery === 'pending' ? (
            <p className="flex items-center gap-2 text-muted-foreground">
              <DeliveryBadge delivery="pending" /> The gateway is offline: the terminal works once it has picked up this change.
            </p>
          ) : null}
          <div className="border-t border-border pt-4">
            <TerminalProtocol terminalId={terminal.id} router={routerAddress(portal)} />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>I have copied it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

