import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CaretDown, DeviceMobile, PaperPlaneTilt, Trash } from '@phosphor-icons/react'
import { FiltersEditor } from '@/components/alerts/filters-editor'
import { TestResultLine } from '@/components/alerts/test-result'
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
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useConfirm } from '@/hooks/use-confirm'
import {
  useDeletePushSubscription,
  usePushSubscriptions,
  useTestPushSubscription,
  useUpdatePushSubscription,
} from '@/hooks/use-push'
import { usersQueryKey } from '@/hooks/use-users'
import { ApiError, apiFetch } from '@/lib/api'
import { formatAgo, PUSH_SERVICE_LABEL } from '@/lib/alerts'
import { cn } from '@/lib/utils'
import type { User } from '@/types/api'
import type { PushSubscriptionView } from '@/types/alerts'

function deviceName(row: PushSubscriptionView): string {
  return row.label || row.platform || `Device #${row.id}`
}

/**
 * "My other devices" (design README §5): every browser this user turned push on in, except this one. Each
 * can be paused, renamed, filtered, tested or removed from here. Admins can list everyone's.
 */
export function PushDevicesList({ thisHash, isAdmin }: { thisHash: string | null | undefined; isAdmin: boolean }) {
  const [everyone, setEveryone] = useState(false)
  const all = isAdmin && everyone
  const list = usePushSubscriptions(all)
  const users = useQuery({
    queryKey: usersQueryKey,
    queryFn: () => apiFetch<User[]>('/api/v1/settings/users'),
    enabled: all,
  })
  const remove = useDeletePushSubscription()
  const confirm = useConfirm<PushSubscriptionView>()
  const rows = (list.data ?? []).filter((row) => row.endpointHash !== thisHash)
  // An older controller without alerts: nothing to list (the card above says so).
  if (list.error instanceof ApiError && list.error.status === 404) return null
  const owner = (userId: number) => {
    const user = users.data?.find((u) => u.id === userId)
    return user ? user.fullName || user.email : `User #${userId}`
  }

  return (
    <Panel
      title={all ? 'All devices' : 'My other devices'}
      description={all ? 'Every browser any user turned notifications on in.' : 'Where else you get notifications.'}
      flush
      actions={
        isAdmin ? (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Everyone’s
            <Switch checked={everyone} onCheckedChange={setEveryone} aria-label="Show every user's devices" />
          </label>
        ) : null
      }
    >
      {list.isPending || thisHash === undefined ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">Loading devices…</p>
      ) : list.error ? (
        <p className="px-4 pb-4 text-xs text-destructive">{list.error.message}</p>
      ) : rows.length === 0 ? (
        <div className="px-4 pb-4">
          <EmptyState
            icon={<DeviceMobile className="size-6" />}
            title="No other devices"
            description="Open Perch on your phone or another computer and tap “Notify this device” there."
          />
        </div>
      ) : (
        <ul className="divide-y divide-border/70 border-t border-border/70">
          {rows.map((row) => (
            <DeviceRow key={row.id} row={row} owner={all ? owner(row.userId) : null} onRemove={() => confirm.open(row)} />
          ))}
        </ul>
      )}

      <Dialog {...confirm.props}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {confirm.target ? deviceName(confirm.target) : 'device'}?</DialogTitle>
            <DialogDescription>
              It stops getting notifications. To get them again, tap “Notify this device” on it.
            </DialogDescription>
          </DialogHeader>
          {remove.error ? (
            <DialogBody>
              <p className="text-destructive">{remove.error.message}</p>
            </DialogBody>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={confirm.close}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => confirm.target && remove.mutate(confirm.target.id, { onSuccess: confirm.close })}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  )
}

function DeviceRow({
  row,
  owner,
  onRemove,
}: {
  row: PushSubscriptionView
  owner: string | null
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const update = useUpdatePushSubscription()
  const test = useTestPushSubscription()
  const nameId = useId()
  const stateText =
    row.state === 'gone'
      ? 'Stopped: turn it on again on that device'
      : row.state === 'failing'
        ? `Failing${row.lastError ? `: ${row.lastError}` : ''}`
        : row.lastSuccessAt
          ? `Last delivery ${formatAgo(row.lastSuccessAt)}`
          : `Added ${formatAgo(row.createdAt)}`

  return (
    <li>
      <div className="flex items-center gap-3 px-4 py-2.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <DeviceMobile className="size-5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{deviceName(row)}</span>
            <span className={cn('block truncate text-xs', row.state === 'active' ? 'text-muted-foreground' : 'text-destructive')}>
              {[owner, row.label && row.platform ? row.platform : null, stateText].filter(Boolean).join(' · ')}
            </span>
          </span>
          <CaretDown
            className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform duration-base ease-out', open && 'rotate-180')}
          />
        </button>
        <Switch
          checked={row.enabled}
          disabled={row.state === 'gone' || update.isPending}
          onCheckedChange={(enabled) => update.mutate({ id: row.id, enabled })}
          aria-label={`Notifications on ${deviceName(row)}`}
        />
      </div>
      {open ? (
        <div className="space-y-4 border-t border-border/50 bg-muted/20 px-4 py-3">
          <div className="space-y-1.5">
            <label htmlFor={nameId} className="text-xs font-medium">
              Name
            </label>
            <Input
              key={`${row.id}-${row.label ?? ''}`}
              id={nameId}
              defaultValue={row.label ?? ''}
              placeholder={row.platform ?? 'Device'}
              maxLength={80}
              className="h-9 max-w-sm rounded-md"
              onBlur={(event) => {
                const label = event.target.value.trim() || null
                if (label !== row.label) update.mutate({ id: row.id, label })
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
              }}
            />
            <p className="text-[11px] text-muted-foreground">Through {PUSH_SERVICE_LABEL[row.pushService]}.</p>
          </div>
          <FiltersEditor
            idPrefix={`push-${row.id}`}
            value={row.filters}
            onChange={(filters) => update.mutate({ id: row.id, filters })}
          />
          {update.error ? <p className="text-xs text-destructive">{update.error.message}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => test.mutate(row.id)} disabled={test.isPending || row.state === 'gone'}>
              {test.isPending ? <Spinner /> : <PaperPlaneTilt />}
              Send a test
            </Button>
            <Button size="sm" variant="ghost" className="text-destructive" onClick={onRemove}>
              <Trash />
              Remove
            </Button>
          </div>
          <TestResultLine kind="push" data={test.data} error={test.error} />
        </div>
      ) : null}
    </li>
  )
}
