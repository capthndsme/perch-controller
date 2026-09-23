import { useState } from 'react'
import { Link } from 'react-router-dom'
import { MagnifyingGlass, Plus, Ticket } from '@phosphor-icons/react'
import { PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Panel } from '@/components/ui/panel'
import { PageSpinner } from '@/components/ui/spinner'
import { DeviceHeader, GrantRow } from '@/components/portal/grants-panel'
import {
  AdminOnlyNotice,
  ConfirmDialog,
  ErrorNote,
  Fact,
  PortalSectionNav,
  VoucherStatusBadge,
} from '@/components/portal/portal-ui'
import { VoucherBatchDialog } from '@/components/portal/voucher-batch-dialog'
import { useIsPortalAdmin, useLookupVoucher, usePortals, useRevokeVoucher, useVoucherBatches } from '@/hooks/use-portal'
import { formatBytes } from '@/lib/format-bytes'
import { apiErrorCode } from '@/lib/api'
import { batchKind, formatDateTime, formatSeconds, limitsLabel, rateLabel, VOUCHER_STATUS_LABELS } from '@/lib/portal'
import type { Portal, VoucherBatch, VoucherStatus } from '@/types/api'

/** `/portal/vouchers`: batches, a new batch, and lookup by code. */
export function PortalVouchersPage() {
  const { isAdmin, isPending } = useIsPortalAdmin()
  const batches = useVoucherBatches({ enabled: isAdmin })
  const portals = usePortals()
  const [creating, setCreating] = useState(false)

  if (isPending) return <PageSpinner label="Loading vouchers" />

  return (
    <div className="flex w-full flex-col gap-5">
      <PageHeader
        title="Vouchers"
        crumbs={[{ label: 'Guest portal', to: '/portal' }, { label: 'Vouchers' }]}
        description="Codes guests type on the sign-in page. Print them, or hand one out from your phone."
        actions={
          isAdmin ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" />
              New vouchers
            </Button>
          ) : null
        }
      />
      <PortalSectionNav />
      {!isAdmin ? (
        <AdminOnlyNotice what="vouchers" />
      ) : (
        <>
          <VoucherLookup portals={portals.data ?? []} />
          <Panel title="Batches" description="Newest first." flush>
            {batches.isPending ? <p className="px-4 pb-4 text-xs text-muted-foreground">Loading batches…</p> : null}
            {batches.error ? <ErrorNote error={batches.error} className="mx-4 mb-4" /> : null}
            {batches.data && batches.data.length === 0 ? (
              <div className="px-4 pb-4">
                <EmptyState
                  icon={<Ticket className="size-6" />}
                  title="No vouchers yet"
                  description="Create a batch: a few codes to hand out, or a sheet to print."
                />
              </div>
            ) : null}
            {batches.data && batches.data.length > 0 ? (
              <ul className="divide-y divide-border border-t border-border">
                {batches.data.map((batch) => (
                  <BatchRow key={batch.id} batch={batch} portals={portals.data ?? []} />
                ))}
              </ul>
            ) : null}
          </Panel>
        </>
      )}
      {creating ? <VoucherBatchDialog onClose={() => setCreating(false)} /> : null}
    </div>
  )
}

const COUNT_ORDER: VoucherStatus[] = ['unused', 'active', 'exhausted', 'expired', 'revoked']

function BatchRow({ batch, portals }: { batch: VoucherBatch; portals: Portal[] }) {
  const portal = batch.portalId === null ? null : portals.find((p) => p.id === batch.portalId)
  const rates = rateLabel(batch.downKbps, batch.upKbps)
  return (
    <li>
      <Link
        to={`/portal/vouchers/${batch.id}`}
        className="flex flex-col gap-2 px-4 py-3 transition-colors hover:bg-muted/40 sm:flex-row sm:items-center"
      >
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">{batch.name}</span>
            <Badge variant="outline" className="rounded-sm text-muted-foreground">
              {batchKind(batch)}
            </Badge>
            {batch.revokedAt ? (
              <Badge variant="outline" className="rounded-sm border-destructive/30 bg-destructive/10 text-destructive">
                Revoked
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {limitsLabel(batch)}
            {rates ? ` · ${rates}` : ''} · {portal ? portal.name : batch.portalId === null ? 'Any portal' : `Portal ${batch.portalId}`}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {batch.count} codes · {formatDateTime(batch.createdAt)}
            {batch.redeemBy ? ` · use by ${formatDateTime(batch.redeemBy)}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] sm:justify-end">
          {COUNT_ORDER.filter((status) => batch.counts[status] > 0).map((status) => (
            <span key={status} className="text-muted-foreground">
              <span className="font-semibold text-foreground tabular-nums">{batch.counts[status]}</span>{' '}
              {VOUCHER_STATUS_LABELS[status].toLowerCase()}
            </span>
          ))}
        </div>
      </Link>
    </li>
  )
}

function VoucherLookup({ portals }: { portals: Portal[] }) {
  const lookup = useLookupVoucher()
  const revoke = useRevokeVoucher()
  const [code, setCode] = useState('')
  const [confirming, setConfirming] = useState(false)
  const result = lookup.data
  const notFound = apiErrorCode(lookup.error) === 'voucher_not_found'
  const bound = result?.voucher.boundPortalId ? portals.find((p) => p.id === result.voucher.boundPortalId) : null

  return (
    <Panel title="Look up a code" description="Any spelling works: dashes, spaces, lower case, O for 0.">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (code.trim()) lookup.mutate(code.trim())
        }}
      >
        <Input
          aria-label="Voucher code"
          placeholder="XXXXX-XXXXX"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="h-9 max-w-xs rounded-md font-mono text-sm tracking-wider uppercase"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
        />
        <Button type="submit" size="lg" disabled={lookup.isPending || !code.trim()}>
          <MagnifyingGlass className="size-4" />
          Look up
        </Button>
      </form>

      {notFound ? <p className="mt-3 text-xs text-muted-foreground">No voucher has that code.</p> : null}
      {lookup.error && !notFound ? <ErrorNote error={lookup.error} className="mt-3" /> : null}

      {result ? (
        <div className="mt-4 space-y-3 rounded-md border border-border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-medium">··{result.voucher.hint}</span>
            <VoucherStatusBadge status={result.voucher.status} />
            <Link to={`/portal/vouchers/${result.batch.id}`} className="text-xs underline-offset-2 hover:underline">
              {result.batch.name}
            </Link>
            {result.voucher.status !== 'revoked' ? (
              <Button
                size="xs"
                variant="destructive"
                className="ml-auto"
                onClick={() => {
                  revoke.reset()
                  setConfirming(true)
                }}
              >
                Revoke code
              </Button>
            ) : null}
          </div>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Fact label="Grants">{limitsLabel(result.batch)}</Fact>
            <Fact label="Used">
              {formatSeconds(result.voucher.timeUsedSeconds)} · {formatBytes(result.voucher.bytesUsed)}
            </Fact>
            <Fact label="Devices now">
              {result.voucher.devices} / {result.batch.maxDevices}
            </Fact>
            <Fact label="Expires">{formatDateTime(result.voucher.expiresAt)}</Fact>
            <Fact label="First used">{formatDateTime(result.voucher.firstUsedAt)}</Fact>
            <Fact label="Portal">{bound ? bound.name : result.voucher.boundPortalId ? `Portal ${result.voucher.boundPortalId}` : 'Not bound yet'}</Fact>
          </dl>
          {result.grants.length > 0 ? (
            <ul className="divide-y divide-border rounded-md border border-border">
              {result.grants.map((grant) => (
                <li key={grant.id}>
                  <DeviceHeader grant={grant} compact />
                  <GrantRow grant={grant} isAdmin={false} onExtend={() => {}} onRevoke={() => {}} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No device has used this code.</p>
          )}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Revoke this code?"
        description="It stops working at once and every device using it goes offline."
        confirmLabel="Revoke"
        destructive
        pending={revoke.isPending}
        error={revoke.error}
        onConfirm={() => {
          if (!result) return
          revoke.mutate(result.voucher.id, {
            onSuccess: () => {
              setConfirming(false)
              lookup.mutate(code.trim())
            },
          })
        }}
      />
    </Panel>
  )
}
