import { Link } from 'react-router-dom'
import { CashRegister } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Panel } from '@/components/ui/panel'
import { Fact } from '@/components/portal/portal-ui'
import { usePriceTables } from '@/hooks/use-hotspot'
import type { Portal } from '@/types/api'

/**
 * The Setup tab's desk-sales facts (Sell Mode, portal.md §15.4): the table
 * the desk sells from, the code length, and the way into Sell Mode.
 */
export function DeskSalesPanel({ portal, isAdmin, onEdit }: { portal: Portal; isAdmin: boolean; onEdit: () => void }) {
  const tables = usePriceTables()
  const table = tables.data?.find((t) => t.id === portal.desk.priceTableId)

  return (
    <Panel
      title="Desk sales"
      description="Front-desk staff sell codes for cash in Sell Mode."
      actions={
        isAdmin ? (
          <>
            <Button asChild size="sm" variant="outline">
              <Link to="/sell">
                <CashRegister className="size-3.5" />
                Enter Sell Mode
              </Link>
            </Button>
            <Button size="sm" variant="outline" onClick={onEdit}>
              Edit
            </Button>
          </>
        ) : null
      }
    >
      <dl className="grid grid-cols-2 gap-3">
        <Fact label="Price table">
          {table ? (
            <Link to="/portal/price-tables" className="underline-offset-2 hover:underline">
              {table.name} · {table.currency}
            </Link>
          ) : portal.desk.priceTableId ? (
            `Table ${portal.desk.priceTableId}`
          ) : (
            'None'
          )}
        </Fact>
        <Fact label="Code length">{portal.desk.codeLength} characters</Fact>
      </dl>
      <p className="mt-3 text-[11px] text-muted-foreground">
        Sellers are admins and Wi-Fi vendors (
        <Link to="/settings/users" className="underline underline-offset-2">
          Settings → Users
        </Link>
        ). Desk sales of this portal:{' '}
        <Link to={`/portal/payments?portalId=${portal.id}&channel=desk`} className="underline underline-offset-2">
          ledger
        </Link>
        .
      </p>
    </Panel>
  )
}
