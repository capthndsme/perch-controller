import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowDown, ArrowUp, ClockClockwise, Plus, Prohibit, Stack } from '@phosphor-icons/react'
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
import {
  Checkbox,
  ConfirmDialog,
  DeliveryBadge,
  DurationInput,
  ErrorNote,
  FormField,
  GrantStateBadge,
  Pager,
  QuotaInput,
  UsageBar,
} from '@/components/portal/portal-ui'
import { useConfirm } from '@/hooks/use-confirm'
import { useAuthorizeDevice, useExtendGrant, usePortalGrants, useRevokeGrant } from '@/hooks/use-portal'
import { formatBytes } from '@/lib/format-bytes'
import {
  GRANT_SOURCE_LABELS,
  formatDateTime,
  groupByDevice,
  grantSourceLabel,
  mbpsToKbps,
  normalizeMac,
  rateLabel,
  relativeTime,
  remainingLabel,
  toBytes,
  toMinutes,
  usedFraction,
  vineFieldErrors,
  type DurationUnit,
  type QuotaUnit,
} from '@/lib/portal'
import { cn } from '@/lib/utils'
import type { PortalGrant, PortalGrantStateFilter } from '@/types/api'

type View = 'current' | 'queued' | 'ended' | 'all'

const VIEWS: ReadonlyArray<{ id: View; label: string }> = [
  { id: 'current', label: 'Current' },
  { id: 'queued', label: 'Queued' },
  { id: 'ended', label: 'Ended' },
  { id: 'all', label: 'All' },
]

const STATE_OF: Record<View, PortalGrantStateFilter> = {
  current: 'active',
  queued: 'queued',
  ended: 'ended',
  all: 'all',
}

const PAGE = 100

/**
 * A portal's grants. "Current" (every grant that has not ended) groups them
 * per device: the running entitlement, then the queue in the order the
 * router consumes it (time before data, decision 23).
 */
export function GrantsPanel({ portalId, isAdmin }: { portalId: number; isAdmin: boolean }) {
  const [view, setView] = useState<View>('current')
  const [macInput, setMacInput] = useState('')
  const [offset, setOffset] = useState(0)
  const mac = normalizeMac(macInput) ?? undefined
  const grants = usePortalGrants({ portalId, state: STATE_OF[view], mac, limit: PAGE, offset })
  const [extending, setExtending] = useState<PortalGrant | null>(null)
  const [authorizing, setAuthorizing] = useState(false)
  const revoke = useRevokeGrant()
  const confirmRevoke = useConfirm<PortalGrant>()

  const devices = useMemo(
    () => (view === 'current' && grants.data ? groupByDevice(grants.data.items) : null),
    [view, grants.data],
  )

  const actions = {
    isAdmin,
    onExtend: (grant: PortalGrant) => setExtending(grant),
    onRevoke: (grant: PortalGrant) => {
      revoke.reset()
      confirmRevoke.open(grant)
    },
  }

  return (
    <Panel
      title="Guests"
      description="Who is authorized on this portal. Changes reach the router when the gateway is online."
      updating={grants.isPlaceholderData}
      actions={
        isAdmin ? (
          <Button size="sm" onClick={() => setAuthorizing(true)}>
            <Plus className="size-3.5" />
            Authorize device
          </Button>
        ) : null
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented
          ariaLabel="Grants"
          size="xs"
          value={view}
          options={VIEWS}
          onChange={(next) => {
            setView(next)
            setOffset(0)
          }}
        />
        <Input
          aria-label="Filter by MAC"
          placeholder="Filter by MAC"
          value={macInput}
          onChange={(e) => {
            setMacInput(e.target.value)
            setOffset(0)
          }}
          className={cn('h-7 w-full rounded-md font-mono sm:w-52', macInput && !mac && 'border-status-warning')}
        />
      </div>

      {grants.error ? <ErrorNote error={grants.error} /> : null}
      {grants.isPending ? <p className="text-xs text-muted-foreground">Loading grants…</p> : null}

      {grants.data && grants.data.items.length === 0 ? (
        <EmptyState
          title={view === 'current' ? 'Nobody is online' : 'No grants'}
          description={
            view === 'current'
              ? 'Guests show here once they redeem a voucher, sign in, or an integration authorizes them.'
              : undefined
          }
        />
      ) : null}

      {devices ? (
        <ul className="space-y-2">
          {devices.map((device) => (
            <li key={device.mac} className="rounded-md border border-border">
              <DeviceHeader grant={device.live ?? device.queued[0]} />
              {device.live ? <GrantRow grant={device.live} {...actions} /> : null}
              {device.queued.length > 0 ? (
                <div className="border-t border-dashed border-border bg-muted/20">
                  <p className="flex items-center gap-1.5 px-3 pt-2 text-[11px] font-medium text-muted-foreground">
                    <Stack className="size-3.5" />
                    {device.live
                      ? `Queued: starts when the one above ends (${device.queued.length})`
                      : `Queued (${device.queued.length})`}
                  </p>
                  {device.queued.map((grant, index) => (
                    <GrantRow key={grant.id} grant={grant} position={index + 1} {...actions} />
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : grants.data ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {grants.data.items.map((grant) => (
            <li key={grant.id}>
              <DeviceHeader grant={grant} compact />
              <GrantRow grant={grant} {...actions} />
            </li>
          ))}
        </ul>
      ) : null}

      {grants.data ? <Pager offset={offset} limit={PAGE} total={grants.data.total} onChange={setOffset} /> : null}

      {extending ? <ExtendGrantDialog grant={extending} onClose={() => setExtending(null)} /> : null}
      {authorizing ? <AuthorizeDeviceDialog portalId={portalId} onClose={() => setAuthorizing(false)} /> : null}
      <ConfirmDialog
        {...confirmRevoke.props}
        title="Revoke this grant?"
        description={
          confirmRevoke.target
            ? `${confirmRevoke.target.mac} loses this entitlement now. If the device has another one queued, that one starts.`
            : undefined
        }
        confirmLabel="Revoke"
        destructive
        pending={revoke.isPending}
        error={revoke.error}
        onConfirm={() => {
          if (!confirmRevoke.target) return
          revoke.mutate(confirmRevoke.target.id, { onSuccess: () => confirmRevoke.close() })
        }}
      />
    </Panel>
  )
}

export function DeviceHeader({ grant, compact = false }: { grant: PortalGrant | undefined; compact?: boolean }) {
  if (!grant) return null
  return (
    <div className={cn('flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3', compact ? 'pt-2' : 'pt-2.5')}>
      <Link to={`/devices/${encodeURIComponent(grant.mac)}`} className="font-mono text-xs font-medium hover:underline">
        {grant.mac}
      </Link>
      {grant.hostname ? <span className="text-xs">{grant.hostname}</span> : null}
      {grant.ip ? <span className="font-mono text-[11px] text-muted-foreground">{grant.ip}</span> : null}
      {grant.lastSeenAt ? (
        <span className="text-[11px] text-muted-foreground">seen {relativeTime(grant.lastSeenAt)}</span>
      ) : null}
    </div>
  )
}

export type GrantRowProps = {
  grant: PortalGrant
  /** Place in the device's queue (1 = next). */
  position?: number
  isAdmin: boolean
  onExtend: (grant: PortalGrant) => void
  onRevoke: (grant: PortalGrant) => void
}

export function GrantRow({ grant, position, isAdmin, onExtend, onRevoke }: GrantRowProps) {
  const fraction = usedFraction(grant.group)
  const group = grant.group
  const rates = group ? rateLabel(group.downKbps, group.upKbps) : null
  const ended = grant.state === 'ended'
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {position ? (
            <Badge variant="outline" className="rounded-sm text-muted-foreground" title="Place in the queue">
              #{position}
            </Badge>
          ) : null}
          <GrantStateBadge grant={grant} />
          <DeliveryBadge delivery={grant.delivery} />
          <span className="text-xs font-medium">{grantSourceLabel(grant)}</span>
          {grant.source !== 'voucher' ? (
            <span className="text-[11px] text-muted-foreground">{GRANT_SOURCE_LABELS[grant.source]}</span>
          ) : null}
          {grant.externalRef ? (
            <span className="font-mono text-[11px] text-muted-foreground" title="External reference">
              {grant.externalRef}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          {!ended ? <span className="text-foreground">{remainingLabel(grant)}</span> : null}
          {grant.expiresAt && !ended ? <span>until {formatDateTime(grant.expiresAt)}</span> : null}
          {ended && grant.endedAt ? <span>ended {formatDateTime(grant.endedAt)}</span> : null}
          {grant.bytesDown > 0 || grant.bytesUp > 0 ? (
            <span className="inline-flex items-center gap-0.5">
              <ArrowDown className="size-3" />
              {formatBytes(grant.bytesDown)}
              <ArrowUp className="ml-1 size-3" />
              {formatBytes(grant.bytesUp)}
            </span>
          ) : null}
          {group && group.maxDevices > 1 ? (
            <span title="Devices sharing this entitlement">
              {group.devices}/{group.maxDevices} devices
            </span>
          ) : null}
          {rates ? <span>{rates}</span> : null}
          {grant.note ? <span className="italic">{grant.note}</span> : null}
        </div>
        {fraction !== null && !ended && grant.state !== 'queued' ? <UsageBar fraction={fraction} className="max-w-72" /> : null}
      </div>
      {isAdmin && !ended ? (
        <div className="flex shrink-0 gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onExtend(grant)}
            disabled={grant.source === 'voucher'}
            title={grant.source === 'voucher' ? 'Voucher grants follow their voucher' : undefined}
          >
            <ClockClockwise className="size-3.5" />
            Extend
          </Button>
          <Button size="sm" variant="destructive" onClick={() => onRevoke(grant)}>
            <Prohibit className="size-3.5" />
            Revoke
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function ExtendGrantDialog({ grant, onClose }: { grant: PortalGrant; onClose: () => void }) {
  const extend = useExtendGrant()
  const [time, setTime] = useState<{ amount: string; unit: DurationUnit }>({ amount: '', unit: 'h' })
  const [data, setData] = useState<{ amount: string; unit: QuotaUnit }>({ amount: '', unit: 'GB' })
  const [localError, setLocalError] = useState<string | null>(null)
  const group = grant.group
  const hasTime = Boolean(group?.durationMinutes || grant.expiresAt || group?.expiresAt)
  const hasData = Boolean(group?.quotaBytes)

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setLocalError(null)
    const minutes = toMinutes(time.amount, time.unit)
    const bytes = toBytes(data.amount, data.unit)
    if (minutes === undefined && bytes === undefined) {
      setLocalError('Add time, data, or both.')
      return
    }
    extend.mutate({ id: grant.id, minutes, bytes }, { onSuccess: onClose })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>Extend {grant.mac}</DialogTitle>
            <DialogDescription>
              Adds to what this grant already has. A limit it does not have cannot be added: extending never
              turns “unlimited” into a limit.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p className="text-muted-foreground">Now: {remainingLabel(grant)}</p>
            <FormField
              label="Add time"
              htmlFor="extend-time"
              hint={hasTime ? 'A running clock moves on from its deadline (or now, if later).' : 'This grant has no time limit.'}
            >
              <DurationInput id="extend-time" {...time} onChange={setTime} placeholder={hasTime ? '0' : 'No time limit'} />
            </FormField>
            <FormField
              label="Add data"
              htmlFor="extend-data"
              hint={hasData ? 'Added to the quota.' : 'This grant has no data quota.'}
            >
              <QuotaInput id="extend-data" {...data} onChange={setData} placeholder={hasData ? '0' : 'No quota'} />
            </FormField>
            {localError ? <p className="text-xs text-destructive">{localError}</p> : null}
            <ErrorNote error={extend.error} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={extend.isPending}>
              {extend.isPending ? 'Extending…' : 'Extend'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** An admin grant through the authorize API (`source: 'admin'`, portal.md §11.6). */
function AuthorizeDeviceDialog({ portalId, onClose }: { portalId: number; onClose: () => void }) {
  const authorize = useAuthorizeDevice()
  const [macInput, setMacInput] = useState('')
  const [time, setTime] = useState<{ amount: string; unit: DurationUnit }>({ amount: '1', unit: 'h' })
  const [data, setData] = useState<{ amount: string; unit: QuotaUnit }>({ amount: '', unit: 'GB' })
  const [activeTime, setActiveTime] = useState(false)
  const [down, setDown] = useState('')
  const [up, setUp] = useState('')
  const [replace, setReplace] = useState(false)
  const [note, setNote] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const fieldErrors = vineFieldErrors(authorize.error)

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setLocalError(null)
    const mac = normalizeMac(macInput)
    if (!mac) {
      setLocalError('Enter the device’s MAC address, e.g. 02:00:00:aa:bb:cc.')
      return
    }
    const minutes = toMinutes(time.amount, time.unit)
    const bytes = toBytes(data.amount, data.unit)
    if (minutes === undefined && bytes === undefined) {
      setLocalError('Give a duration, a data quota, or both.')
      return
    }
    authorize.mutate(
      {
        portalId,
        mac,
        minutes,
        bytes,
        durationMode: activeTime ? 'active_time' : 'wall_clock',
        downKbps: mbpsToKbps(down),
        upKbps: mbpsToKbps(up),
        mode: replace ? 'replace' : 'extend',
        note: note.trim() || undefined,
      },
      { onSuccess: onClose },
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>Authorize a device</DialogTitle>
            <DialogDescription>
              Puts a device online without a voucher. If it already has something running, time goes first and
              anything else waits in its queue.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <FormField label="MAC address" htmlFor="auth-mac" error={fieldErrors.mac}>
              <Input
                id="auth-mac"
                required
                placeholder="02:00:00:aa:bb:cc"
                value={macInput}
                onChange={(e) => setMacInput(e.target.value)}
                className="rounded-md font-mono"
                autoComplete="off"
              />
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Time" htmlFor="auth-time" error={fieldErrors.minutes}>
                <DurationInput id="auth-time" {...time} onChange={setTime} />
              </FormField>
              <FormField label="Data" htmlFor="auth-data" error={fieldErrors.bytes}>
                <QuotaInput id="auth-data" {...data} onChange={setData} />
              </FormField>
            </div>
            <Checkbox
              id="auth-active"
              checked={activeTime}
              onChange={setActiveTime}
              label="Count only time in use"
              description="The time runs down only while the device moves traffic (active time), not by the wall clock."
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Download limit (Mbps)" htmlFor="auth-down" error={fieldErrors.downKbps}>
                <Input id="auth-down" inputMode="decimal" placeholder="None" value={down} onChange={(e) => setDown(e.target.value)} className="rounded-md" />
              </FormField>
              <FormField label="Upload limit (Mbps)" htmlFor="auth-up" error={fieldErrors.upKbps}>
                <Input id="auth-up" inputMode="decimal" placeholder="None" value={up} onChange={(e) => setUp(e.target.value)} className="rounded-md" />
              </FormField>
            </div>
            <Checkbox
              id="auth-replace"
              checked={replace}
              onChange={setReplace}
              label="Replace my earlier grant for this device"
              description="Otherwise a matching admin grant of the device is extended."
            />
            <FormField label="Note" htmlFor="auth-note" error={fieldErrors.note}>
              <Input id="auth-note" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} className="rounded-md" placeholder="Optional" />
            </FormField>
            {localError ? <p className="text-xs text-destructive">{localError}</p> : null}
            <ErrorNote error={authorize.error} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={authorize.isPending}>
              {authorize.isPending ? 'Authorizing…' : 'Authorize'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
