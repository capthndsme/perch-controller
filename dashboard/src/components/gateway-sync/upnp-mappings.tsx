import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Prohibit, Trash } from '@phosphor-icons/react'
import { ConfirmDialog, ErrorLine, ToneBadge } from '@/components/gateway-config/bits'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/hooks/use-confirm'
import { useBlockUpnpDevice, useDeleteUpnpMappings } from '@/hooks/use-gateway-sync'
import { formatRelative } from '@/lib/gateway-observation'
import { syncRefusalMessage } from '@/lib/gateway-sync'
import { macPath } from '@/lib/traffic'
import { cn } from '@/lib/utils'
import type { UpnpMapping } from '@/types/api'
import type { FirewallWriteSummary, FwGateway } from '@/types/firewall'
import type { DeviceRef, UpnpConfigView, UpnpMappingsDeleteAnswer } from '@/types/gateway-sync'

const keyOf = (m: Pick<UpnpMapping, 'proto' | 'externalPort'>) => `${m.proto}:${m.externalPort}`

/**
 * The ports devices opened with UPnP right now: pick some and delete them on
 * the router (runtime, no apply: a device may open them again), or block a
 * device from UPnP (a deny rule at the top of the access list, then its
 * mappings go). A list of rows that reads the same on a phone and a desk.
 */
export function UpnpMappings({
  gateway,
  view,
  canWrite,
  onWrite,
}: {
  gateway: FwGateway
  view: UpnpConfigView
  canWrite: boolean
  onWrite: (summary: FirewallWriteSummary) => void
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [deleted, setDeleted] = useState<UpnpMappingsDeleteAnswer | null>(null)
  const remove = useDeleteUpnpMappings(gateway.id)
  const block = useBlockUpnpDevice(gateway.id)
  const confirmDelete = useConfirm<UpnpMapping[]>()
  const confirmBlock = useConfirm<{ device: DeviceRef; blocked: boolean }>()
  const canDelete = canWrite && view.canDeleteMappings

  // Devices a deny rule already keeps out of UPnP.
  const blockedMacs = useMemo(
    () => new Set(view.acl.filter((r) => r.action === 'deny' && r.device).map((r) => r.device!.mac.toLowerCase())),
    [view.acl],
  )
  const mappings = useMemo(
    () => [...view.mappings].sort((a, b) => a.externalPort - b.externalPort || a.proto.localeCompare(b.proto)),
    [view.mappings],
  )
  // A mapping that went away drops out of the selection.
  const live = new Set(mappings.map(keyOf))
  const chosen = mappings.filter((m) => selected.has(keyOf(m)) && live.has(keyOf(m)))

  const toggle = (m: UpnpMapping) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(keyOf(m))) next.delete(keyOf(m))
      else next.add(keyOf(m))
      return next
    })

  return (
    <section className="space-y-2" aria-label="Open UPnP ports" data-testid="upnp-mappings">
      <header className="flex min-h-8 flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold">
          Open ports <span className="font-normal text-muted-foreground">({mappings.length})</span>
        </h3>
        {canDelete && chosen.length > 0 ? (
          <Button
            size="sm"
            variant="outline"
            className="text-destructive"
            onClick={() => {
              remove.reset()
              confirmDelete.open(chosen)
            }}
          >
            <Trash />
            Delete {chosen.length}
          </Button>
        ) : null}
      </header>

      {deleted ? (
        <p className="text-xs text-muted-foreground" role="status">
          Removed {deleted.deleted} on the router{deleted.notFound > 0 ? ` (${deleted.notFound} were already gone)` : ''}
          {deleted.restarted ? '; miniupnpd restarted once' : ''}. A device may open them again unless it is blocked.
        </p>
      ) : null}

      {mappings.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          No device has opened a port.
        </p>
      ) : (
        <ul className="divide-y divide-border/70 rounded-md border border-border">
          {mappings.map((m) => {
            const k = keyOf(m)
            const isBlocked = m.device ? blockedMacs.has(m.device.mac.toLowerCase()) : false
            return (
              <li
                key={k}
                className={cn(
                  'grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-1 px-2.5 py-2 text-xs transition-colors duration-base',
                  selected.has(k) && 'bg-muted/50',
                )}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-primary sm:size-3.5"
                  aria-label={`Select ${m.proto} ${m.externalPort}`}
                  checked={selected.has(k)}
                  disabled={!canDelete}
                  onChange={() => toggle(m)}
                />
                <div className="min-w-0 space-y-0.5">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    {m.device ? (
                      <Link to={`/devices/${macPath(m.device.mac)}`} className="font-medium underline-offset-2 hover:underline">
                        {m.device.name ?? m.device.mac}
                      </Link>
                    ) : (
                      <span className="font-medium">{m.internalIp}</span>
                    )}
                    {isBlocked ? <ToneBadge tone="critical">UPnP blocked</ToneBadge> : null}
                  </p>
                  <p className="font-mono text-[11px] break-all">
                    {m.proto} {m.externalPort} → {m.internalIp}:{m.internalPort}
                  </p>
                  {m.description ? <p className="break-words text-muted-foreground">{m.description}</p> : null}
                </div>
                <div className="flex flex-col items-end gap-1 text-right">
                  <span className="text-[11px] whitespace-nowrap text-muted-foreground">
                    {m.expiresAt ? `ends ${formatRelative(m.expiresAt)}` : 'permanent'}
                  </span>
                  {canWrite && m.device ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      className={cn(!isBlocked && 'text-destructive')}
                      onClick={() => {
                        block.reset()
                        confirmBlock.open({ device: m.device!, blocked: !isBlocked })
                      }}
                    >
                      <Prohibit />
                      {isBlocked ? 'Unblock' : 'Block UPnP'}
                    </Button>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <ConfirmDialog
        {...confirmDelete.props}
        title={`Delete ${confirmDelete.target?.length ?? 0} port mapping${confirmDelete.target?.length === 1 ? '' : 's'}?`}
        description="The router drops them now. Nothing else changes: a device may open them again, unless you block it from UPnP."
        confirmLabel="Delete on the router"
        destructive
        pending={remove.isPending}
        error={remove.error ? syncRefusalMessage(remove.error) : null}
        onConfirm={async () => {
          const target = confirmDelete.target ?? []
          try {
            const answer = await remove.mutateAsync(target.map((m) => ({ proto: m.proto, externalPort: m.externalPort })))
            setDeleted(answer)
            setSelected(new Set())
            confirmDelete.close()
          } catch {
            // shown
          }
        }}
      >
        <ul className="space-y-0.5 font-mono text-[11px]">
          {(confirmDelete.target ?? []).map((m) => (
            <li key={keyOf(m)}>
              {m.proto} {m.externalPort} → {m.internalIp}:{m.internalPort}
            </li>
          ))}
        </ul>
      </ConfirmDialog>

      <ConfirmDialog
        {...confirmBlock.props}
        title={
          confirmBlock.target?.blocked
            ? `Block ${confirmBlock.target.device.name ?? confirmBlock.target.device.mac} from UPnP?`
            : `Let ${confirmBlock.target?.device.name ?? confirmBlock.target?.device.mac ?? 'it'} use UPnP again?`
        }
        description={
          confirmBlock.target?.blocked
            ? 'A deny rule for its reserved address goes to the top of the access list, then the ports it opened are removed. If it has no reserved address yet, Perch reserves the one it has.'
            : 'Its deny rule is removed from the access list.'
        }
        confirmLabel={confirmBlock.target?.blocked ? 'Block UPnP' : 'Unblock'}
        destructive={confirmBlock.target?.blocked}
        pending={block.isPending}
        error={block.error ? syncRefusalMessage(block.error) : null}
        onConfirm={async () => {
          const target = confirmBlock.target
          if (!target) return
          try {
            const answer = await block.mutateAsync({ mac: target.device.mac, blocked: target.blocked })
            const name = target.device.name ?? target.device.mac
            onWrite({
              what: target.blocked
                ? `Blocked ${name} from UPnP${answer.deletedMappings ? `; ${answer.deletedMappings} of its ports removed` : ''}`
                : `${name} may use UPnP again`,
              issues: answer.issues,
              apply: answer.apply,
              applyError: answer.applyError,
            })
            confirmBlock.close()
          } catch {
            // shown
          }
        }}
      />
      {remove.error && !confirmDelete.props.open ? <ErrorLine message={syncRefusalMessage(remove.error)} /> : null}
    </section>
  )
}
