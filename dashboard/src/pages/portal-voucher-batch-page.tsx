import { useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { CheckCircle, DownloadSimple, Eye, EyeSlash, Printer, Prohibit, Trash } from '@phosphor-icons/react'
import { PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import { PageSpinner } from '@/components/ui/spinner'
import {
  AdminOnlyNotice,
  ConfirmDialog,
  DeliveryBadge,
  ErrorNote,
  Fact,
  VoucherStatusBadge,
} from '@/components/portal/portal-ui'
import { useConfirm } from '@/hooks/use-confirm'
import {
  downloadVoucherCsv,
  useDeleteVoucherBatch,
  useIsPortalAdmin,
  usePortals,
  useRevokeVoucher,
  useRevokeVoucherBatch,
  useVoucherBatch,
  useVoucherCodes,
} from '@/hooks/use-portal'
import { ApiError } from '@/lib/api'
import { formatBytes } from '@/lib/format-bytes'
import {
  VOUCHER_STATUS_LABELS,
  batchKind,
  formatDateTime,
  formatSeconds,
  limitsLabel,
  portalErrorMessage,
  rateLabel,
} from '@/lib/portal'
import type { PortalDelivery, Voucher, VoucherStatus } from '@/types/api'

type Filter = 'all' | VoucherStatus

/** `/portal/vouchers/:id`: one batch, its codes (on demand), print and CSV. */
export function PortalVoucherBatchPage() {
  const params = useParams()
  const id = Number(params.id)
  const batchId = Number.isInteger(id) && id > 0 ? id : null
  const navigate = useNavigate()
  const location = useLocation()
  const created = (location.state ?? null) as { codes?: string[]; delivery?: PortalDelivery } | null
  const { isAdmin, isPending } = useIsPortalAdmin()
  const batch = useVoucherBatch(isAdmin ? batchId : null)
  const portals = usePortals({ enabled: isAdmin })
  const [showCodes, setShowCodes] = useState(Boolean(created?.codes))
  const codes = useVoucherCodes(batchId, { enabled: isAdmin && showCodes })
  const [filter, setFilter] = useState<Filter>('all')
  const revokeBatch = useRevokeVoucherBatch()
  const deleteBatch = useDeleteVoucherBatch()
  const revokeVoucher = useRevokeVoucher()
  const [confirmBatch, setConfirmBatch] = useState<'revoke' | 'delete' | null>(null)
  const confirmVoucher = useConfirm<Voucher>()
  const [csvError, setCsvError] = useState<unknown>(null)

  if (isPending || (isAdmin && batch.isPending)) return <PageSpinner label="Loading batch" />
  if (!isAdmin) return <AdminOnlyNotice what="vouchers" />
  if (!batch.data) {
    return (
      <div className="flex w-full flex-col gap-5">
        <PageHeader title="Batch" crumbs={[{ label: 'Guest portal', to: '/portal' }, { label: 'Vouchers', to: '/portal/vouchers' }, { label: 'Batch' }]} />
        {batch.error instanceof ApiError && batch.error.status === 404 ? (
          <p className="text-sm text-muted-foreground">This batch does not exist (any more).</p>
        ) : (
          <ErrorNote error={batch.error} />
        )}
      </div>
    )
  }

  const { batch: info, vouchers } = batch.data
  const codeById = new Map((codes.data?.vouchers ?? []).map((v) => [v.id, v.code ?? null]))
  const portal = info.portalId === null ? null : portals.data?.find((p) => p.id === info.portalId)
  const rates = rateLabel(info.downKbps, info.upKbps)
  const used = vouchers.some((v) => v.firstUsedAt !== null)
  const shown = filter === 'all' ? vouchers : vouchers.filter((v) => v.status === filter)
  const filters: Array<{ id: Filter; label: string }> = [
    { id: 'all', label: `All ${vouchers.length}` },
    ...(['unused', 'active', 'exhausted', 'expired', 'revoked'] as VoucherStatus[])
      .filter((s) => info.counts[s] > 0)
      .map((s) => ({ id: s as Filter, label: `${VOUCHER_STATUS_LABELS[s]} ${info.counts[s]}` })),
  ]

  async function onCsv() {
    setCsvError(null)
    try {
      await downloadVoucherCsv(info.id)
    } catch (error) {
      setCsvError(error)
    }
  }

  return (
    <div className="flex w-full flex-col gap-5">
      <PageHeader
        title={info.name}
        crumbs={[{ label: 'Guest portal', to: '/portal' }, { label: 'Vouchers', to: '/portal/vouchers' }, { label: info.name }]}
        description={`${info.count} codes · ${limitsLabel(info)}${rates ? ` · ${rates}` : ''}`}
        actions={
          <>
            <Button asChild size="sm">
              <Link to={`/portal/vouchers/${info.id}/print`}>
                <Printer className="size-3.5" />
                Print sheet
              </Link>
            </Button>
            <Button size="sm" variant="outline" onClick={onCsv}>
              <DownloadSimple className="size-3.5" />
              CSV
            </Button>
            {!info.revokedAt ? (
              <Button size="sm" variant="destructive" onClick={() => setConfirmBatch('revoke')}>
                <Prohibit className="size-3.5" />
                Revoke
              </Button>
            ) : null}
            {!used ? (
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirmBatch('delete')}>
                <Trash className="size-3.5" />
                Delete
              </Button>
            ) : null}
          </>
        }
      >
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" className="rounded-sm text-muted-foreground">
            {batchKind(info)}
          </Badge>
          {info.revokedAt ? (
            <Badge variant="outline" className="rounded-sm border-destructive/30 bg-destructive/10 text-destructive">
              Revoked {formatDateTime(info.revokedAt)}
            </Badge>
          ) : null}
        </div>
      </PageHeader>

      {csvError ? <ErrorNote error={csvError} /> : null}

      {created?.codes ? (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-status-good/30 bg-status-good/5 px-3 py-2.5 text-xs">
          <CheckCircle className="size-4 text-status-good" />
          <span className="font-medium">{created.codes.length} codes created.</span>
          <span className="text-muted-foreground">Print them or copy one below.</span>
          {created.delivery ? <DeliveryBadge delivery={created.delivery} /> : null}
          {created.delivery === 'pending' ? (
            <span className="text-muted-foreground">The gateway gets them for offline use when it is online.</span>
          ) : null}
        </div>
      ) : null}

      <section className="card-surface p-4">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Fact label="Portal">{portal ? portal.name : info.portalId === null ? 'Any portal' : `Portal ${info.portalId}`}</Fact>
          <Fact label="Clock">
            {info.durationMode === 'active_time' ? 'Only while online' : info.startMode === 'creation' ? 'From creation' : 'From first use'}
          </Fact>
          <Fact label="Devices per code">{info.maxDevices}</Fact>
          <Fact label="Use by">{formatDateTime(info.redeemBy)}</Fact>
          <Fact label="Created">{formatDateTime(info.createdAt)}</Fact>
          <Fact label="By">{info.createdBy?.email ?? '—'}</Fact>
          <Fact label="Code length">{info.codeLength}</Fact>
          {info.note ? <Fact label="Note">{info.note}</Fact> : null}
        </dl>
      </section>

      <Panel
        title="Codes"
        description={showCodes ? 'Treat codes like cash: anyone who has one can get online.' : 'Codes stay hidden until you show them.'}
        updating={codes.isFetching}
        actions={
          <Button size="sm" variant="outline" onClick={() => setShowCodes((v) => !v)}>
            {showCodes ? <EyeSlash className="size-3.5" /> : <Eye className="size-3.5" />}
            {showCodes ? 'Hide codes' : 'Show codes'}
          </Button>
        }
      >
        {codes.error ? <ErrorNote error={codes.error} className="mb-3" /> : null}
        {filters.length > 2 ? (
          <Segmented ariaLabel="Status" size="xs" value={filter} options={filters} onChange={setFilter} className="mb-3 w-fit max-w-full overflow-x-auto" />
        ) : null}
        <ul className="divide-y divide-border rounded-md border border-border">
          {shown.map((voucher) => {
            const code = codeById.get(voucher.id)
            return (
              <li key={voucher.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
                <span className="min-w-[9.5rem] font-mono text-sm font-medium tracking-wider">
                  {showCodes && code ? code : `·····-·${voucher.hint}`}
                </span>
                <VoucherStatusBadge status={voucher.status} />
                <span className="text-[11px] text-muted-foreground">
                  {voucher.firstUsedAt
                    ? `${formatSeconds(voucher.timeUsedSeconds)} · ${formatBytes(voucher.bytesUsed)} used · ${voucher.devices} device${voucher.devices === 1 ? '' : 's'}`
                    : 'Not used'}
                  {voucher.expiresAt ? ` · until ${formatDateTime(voucher.expiresAt)}` : ''}
                </span>
                <span className="ml-auto flex gap-1.5">
                  {showCodes && code ? <CopyButton value={code} ariaLabel={`Copy code ending ${voucher.hint}`} /> : null}
                  {voucher.status !== 'revoked' && voucher.status !== 'expired' ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        revokeVoucher.reset()
                        confirmVoucher.open(voucher)
                      }}
                    >
                      Revoke
                    </Button>
                  ) : null}
                </span>
              </li>
            )
          })}
        </ul>
      </Panel>

      <ConfirmDialog
        open={confirmBatch === 'revoke'}
        onOpenChange={(open) => !open && setConfirmBatch(null)}
        title={`Revoke all ${info.count} codes?`}
        description="Unused codes stop working and every device using one of them goes offline. This cannot be undone."
        confirmLabel="Revoke batch"
        destructive
        pending={revokeBatch.isPending}
        error={revokeBatch.error}
        onConfirm={() => revokeBatch.mutate(info.id, { onSuccess: () => setConfirmBatch(null) })}
      />
      <ConfirmDialog
        open={confirmBatch === 'delete'}
        onOpenChange={(open) => !open && setConfirmBatch(null)}
        title="Delete this batch?"
        description="None of its codes was used, so it can go without a trace."
        confirmLabel="Delete"
        destructive
        pending={deleteBatch.isPending}
        error={deleteBatch.error}
        onConfirm={() => deleteBatch.mutate(info.id, { onSuccess: () => navigate('/portal/vouchers') })}
      />
      <ConfirmDialog
        {...confirmVoucher.props}
        title={`Revoke the code ending ${confirmVoucher.target?.hint ?? ''}?`}
        description="It stops working at once and every device using it goes offline."
        confirmLabel="Revoke"
        destructive
        pending={revokeVoucher.isPending}
        error={revokeVoucher.error}
        onConfirm={() => {
          if (confirmVoucher.target) revokeVoucher.mutate(confirmVoucher.target.id, { onSuccess: () => confirmVoucher.close() })
        }}
      />
      {deleteBatch.error && confirmBatch === null ? <p className="text-xs text-destructive">{portalErrorMessage(deleteBatch.error)}</p> : null}
    </div>
  )
}
