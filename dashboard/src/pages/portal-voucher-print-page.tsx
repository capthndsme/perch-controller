import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Printer, WifiHigh } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { PageSpinner } from '@/components/ui/spinner'
import { Checkbox, ErrorNote } from '@/components/portal/portal-ui'
import { useIsPortalAdmin, useVoucherCodes } from '@/hooks/use-portal'
import { formatDateTime, limitsLabel, rateLabel } from '@/lib/portal'
import { cn } from '@/lib/utils'

type Columns = '2' | '3' | '4'

const COLUMN_CLASSES: Record<Columns, string> = {
  '2': 'grid-cols-2',
  '3': 'grid-cols-2 sm:grid-cols-3 print:grid-cols-3',
  '4': 'grid-cols-2 sm:grid-cols-4 print:grid-cols-4',
}

const NETWORK_KEY = 'perch-voucher-print-network'

function readNetworkName(): string {
  try {
    return localStorage.getItem(NETWORK_KEY) ?? ''
  } catch {
    return ''
  }
}

/**
 * `/portal/vouchers/:id/print`: a sheet of voucher cards to print and cut,
 * outside the app shell. The toolbar never prints; the cards keep to light
 * colours whatever the theme, and never break across pages.
 */
export function PortalVoucherPrintPage() {
  const params = useParams()
  const id = Number(params.id)
  const { isAdmin, isPending } = useIsPortalAdmin()
  const codes = useVoucherCodes(Number.isInteger(id) && id > 0 && isAdmin ? id : null)
  const [columns, setColumns] = useState<Columns>('3')
  const [unusedOnly, setUnusedOnly] = useState(true)
  const [network, setNetwork] = useState(readNetworkName)

  useEffect(() => {
    try {
      localStorage.setItem(NETWORK_KEY, network)
    } catch {
      // per-viewer convenience only
    }
  }, [network])

  if (isPending || (isAdmin && codes.isPending)) return <PageSpinner fullScreen label="Loading codes" />
  if (!isAdmin) {
    return <p className="p-6 text-sm text-muted-foreground">Only admins can print vouchers.</p>
  }
  if (!codes.data) {
    return (
      <div className="mx-auto max-w-lg space-y-3 p-6">
        <ErrorNote error={codes.error} />
        <Link to={`/portal/vouchers/${id}`} className="text-xs underline">
          Back to the batch
        </Link>
      </div>
    )
  }

  const { batch, vouchers } = codes.data
  const cards = vouchers.filter((v) => v.code && (unusedOnly ? v.status === 'unused' : v.status !== 'revoked'))
  const limits = limitsLabel(batch)
  const rates = rateLabel(batch.downKbps, batch.upKbps)

  return (
    <div className="min-h-svh bg-background print:bg-white">
      <div className="sticky top-0 z-10 border-b border-border bg-card/95 backdrop-blur print:hidden">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 px-4 py-2.5">
          <Button asChild size="sm" variant="ghost">
            <Link to={`/portal/vouchers/${batch.id}`}>
              <ArrowLeft className="size-3.5" />
              Back
            </Link>
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{batch.name}</p>
            <p className="text-[11px] text-muted-foreground">
              {cards.length} card{cards.length === 1 ? '' : 's'} · A4, cut along the dashed lines
            </p>
          </div>
          <Button size="sm" onClick={() => window.print()} disabled={cards.length === 0}>
            <Printer className="size-3.5" />
            Print
          </Button>
        </div>
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 pb-2.5">
          <Input
            aria-label="Wi-Fi name printed on the cards"
            placeholder="Wi-Fi name (printed on the cards)"
            value={network}
            onChange={(e) => setNetwork(e.target.value)}
            className="h-7 w-full rounded-md sm:w-64"
          />
          <Segmented
            ariaLabel="Cards per row"
            size="xs"
            value={columns}
            onChange={setColumns}
            options={[
              { id: '2', label: '2 per row' },
              { id: '3', label: '3 per row' },
              { id: '4', label: '4 per row' },
            ]}
          />
          <Checkbox id="print-unused" checked={unusedOnly} onChange={setUnusedOnly} label="Unused codes only" />
        </div>
      </div>

      <main className="voucher-sheet mx-auto max-w-5xl p-4 print:max-w-none print:p-0">
        {cards.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground print:hidden">
            No codes to print{unusedOnly ? ': every code of this batch has been used' : ''}.
          </p>
        ) : null}
        <div className={cn('grid gap-0 bg-white text-black', COLUMN_CLASSES[columns])}>
          {cards.map((voucher) => (
            <article
              key={voucher.id}
              className="flex break-inside-avoid flex-col items-center gap-1.5 border border-dashed border-neutral-400 px-3 py-4 text-center"
            >
              <p className="flex items-center gap-1 text-[11px] font-medium text-neutral-600">
                <WifiHigh className="size-3.5" weight="bold" />
                {network.trim() || 'Guest Wi-Fi'}
              </p>
              <p
                className={cn(
                  'font-mono font-bold tracking-[0.12em] text-black',
                  columns === '4' ? 'text-base' : columns === '3' ? 'text-lg' : 'text-2xl',
                )}
              >
                {voucher.code}
              </p>
              <p className="text-[11px] font-semibold text-neutral-800">{limits}</p>
              {rates ? <p className="text-[10px] text-neutral-600">{rates}</p> : null}
              <p className="text-[10px] leading-snug text-neutral-600">
                Join the Wi-Fi, open any website and enter the code.
                {batch.redeemBy ? ` Use by ${formatDateTime(batch.redeemBy)}.` : ''}
              </p>
            </article>
          ))}
        </div>
      </main>
    </div>
  )
}
