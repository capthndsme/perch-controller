import { useId, useState } from 'react'
import { ArrowDown, ArrowUp, PencilSimple, Plus, Trash, Warning } from '@phosphor-icons/react'
import { ApplyNowCheckbox, ErrorNote, FormField, selectClassName } from '@/components/firewall/firewall-ui'
import { ConfirmDialog, ToneBadge } from '@/components/gateway-config/bits'
import { SyncBadges } from '@/components/gateway-native/native-ui'
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
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Spinner } from '@/components/ui/spinner'
import { useConfirm } from '@/hooks/use-confirm'
import { useDialog } from '@/hooks/use-dialog'
import { useFirewallDevices } from '@/hooks/use-firewall'
import { useDeleteUpnpAcl, useOrderUpnpAcl, useSaveUpnpAcl } from '@/hooks/use-gateway-sync'
import { syncRefusalMessage } from '@/lib/gateway-sync'
import { cn } from '@/lib/utils'
import type { FirewallWriteSummary, FwGateway } from '@/types/firewall'
import type { UpnpAclInput, UpnpAclRule, UpnpConfigView } from '@/types/gateway-sync'

const PORTS = /^(\d{1,5})(?:-(\d{1,5}))?$/
const ADDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/

function portsError(value: string): string | null {
  const m = PORTS.exec(value.trim())
  if (!m) return 'A port or a range, like 3074 or 1024-65535.'
  const a = Number(m[1])
  const b = m[2] ? Number(m[2]) : a
  if (a < 0 || b > 65535 || a > b) return 'Ports run from 0 to 65535, low to high.'
  return null
}

function addrError(value: string): string | null {
  const m = ADDR.exec(value.trim())
  if (!m) return 'An IPv4 address or subnet, like 192.168.1.20 or 192.168.1.0/24.'
  if (m.slice(1, 5).some((o) => Number(o) > 255) || (m[5] !== undefined && Number(m[5]) > 32)) return 'Not a valid address.'
  return null
}

function ruleText(rule: UpnpAclRule): string {
  return `${rule.extPorts} → ${rule.device?.name ?? rule.intAddr}, ports ${rule.intPorts}`
}

/**
 * miniupnpd's access list, first match wins (design gateway-sync rest.md 8):
 * which device may open which ports. Up and down move a rule (one order
 * write); a rule an earlier one covers says so.
 */
export function UpnpAcl({
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
  const order = useOrderUpnpAcl(gateway.id)
  const remove = useDeleteUpnpAcl(gateway.id)
  const edit = useDialog()
  const [editing, setEditing] = useState<UpnpAclRule | null>(null)
  const deleting = useConfirm<UpnpAclRule>()
  const rules = [...view.acl].sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9))
  const byId = new Map(rules.map((r) => [r.id, r]))
  const orderNote =
    view.aclOrder && view.aclOrder.status !== 'in_sync'
      ? view.aclOrder.status === 'ahead'
        ? 'A new order is waiting to go to the router.'
        : view.aclOrder.status === 'conflict'
          ? 'The order was changed on the router and here: resolve it under Gateway config → Conflicts.'
          : 'The order was changed on the router.'
      : null

  async function move(index: number, by: -1 | 1) {
    const ids = rules.map((r) => r.id)
    const [id] = ids.splice(index, 1)
    ids.splice(index + by, 0, id)
    try {
      const answer = await order.mutateAsync({ ids })
      onWrite({ what: 'Saved the new order of the UPnP rules', issues: answer.issues, apply: answer.apply, applyError: answer.applyError })
    } catch {
      // shown below
    }
  }

  return (
    <section className="space-y-2" aria-label="UPnP access list" data-testid="upnp-acl">
      <header className="flex min-h-8 flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold">Who may open ports</h3>
          <p className="text-[11px] text-muted-foreground">Checked top to bottom; the first rule that matches decides.</p>
        </div>
        {canWrite ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setEditing(null)
              edit.show()
            }}
          >
            <Plus />
            Add rule
          </Button>
        ) : null}
      </header>
      {orderNote ? (
        <p className="flex items-start gap-1.5 text-xs text-status-warning">
          <Warning weight="fill" className="mt-0.5 size-3.5 shrink-0" />
          {orderNote}
        </p>
      ) : null}
      {rules.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          No rules: miniupnpd’s own default applies.
        </p>
      ) : (
        <ol className="divide-y divide-border/70 rounded-md border border-border">
          {rules.map((rule, index) => (
            <li key={rule.id} className="flex items-start gap-2.5 px-2.5 py-2 text-xs">
              <span className="mt-0.5 w-5 shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="flex flex-wrap items-center gap-1.5">
                  <ToneBadge tone={rule.action === 'allow' ? 'good' : 'critical'}>
                    {rule.action === 'allow' ? 'Allow' : 'Deny'}
                  </ToneBadge>
                  <span className="font-mono text-[11px] break-all">{ruleText(rule)}</span>
                </p>
                {rule.device ? (
                  <p className="font-mono text-[11px] text-muted-foreground">{rule.intAddr}</p>
                ) : null}
                {rule.comment ? <p className="break-words text-muted-foreground">{rule.comment}</p> : null}
                {rule.shadowedBy ? (
                  <p className="flex items-start gap-1 text-status-warning">
                    <Warning className="mt-0.5 size-3 shrink-0" />
                    Never used: rule {rules.findIndex((r) => r.id === rule.shadowedBy) + 1 || '?'} (
                    {byId.get(rule.shadowedBy) ? ruleText(byId.get(rule.shadowedBy)!) : rule.shadowedBy}) matches first.
                  </p>
                ) : null}
                {rule.sync.owner !== 'perch' || rule.sync.status !== 'in_sync' ? <SyncBadges sync={rule.sync} /> : null}
              </div>
              {canWrite ? (
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-0.5">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Move up"
                    disabled={index === 0 || order.isPending}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Move down"
                    disabled={index === rules.length - 1 || order.isPending}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Edit rule"
                    onClick={() => {
                      setEditing(rule)
                      edit.show()
                    }}
                  >
                    <PencilSimple />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Delete rule"
                    className="text-destructive"
                    onClick={() => {
                      remove.reset()
                      deleting.open(rule)
                    }}
                  >
                    <Trash />
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      <ErrorNote error={order.error} />

      {canWrite ? (
        <UpnpAclDialog
          key={edit.key}
          gateway={gateway}
          rule={editing}
          open={edit.open}
          onOpenChange={edit.setOpen}
          onWrite={onWrite}
        />
      ) : null}
      <ConfirmDialog
        {...deleting.props}
        title="Delete this UPnP rule?"
        description={deleting.target ? ruleText(deleting.target) : undefined}
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        error={remove.error ? syncRefusalMessage(remove.error) : null}
        onConfirm={async () => {
          const target = deleting.target
          if (!target) return
          try {
            const answer = await remove.mutateAsync({ perchId: target.id })
            onWrite({ what: 'Deleted a UPnP rule', issues: answer.issues, apply: answer.apply, applyError: answer.applyError })
            deleting.close()
          } catch {
            // shown
          }
        }}
      />
    </section>
  )
}

function UpnpAclDialog({
  gateway,
  rule,
  open,
  onOpenChange,
  onWrite,
}: {
  gateway: FwGateway
  rule: UpnpAclRule | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onWrite: (summary: FirewallWriteSummary) => void
}) {
  const id = useId()
  // Keyed per opening: the rule it was opened for stays while it animates out.
  const shown = rule
  const devices = useFirewallDevices()
  const save = useSaveUpnpAcl(gateway.id)
  const [action, setAction] = useState<'allow' | 'deny'>(shown?.action ?? 'allow')
  const [target, setTarget] = useState<'device' | 'address'>(shown?.device ? 'device' : shown ? 'address' : 'device')
  const [deviceMac, setDeviceMac] = useState(shown?.device?.mac.toLowerCase() ?? '')
  const [intAddr, setIntAddr] = useState(shown?.intAddr ?? '')
  const [extPorts, setExtPorts] = useState(shown?.extPorts ?? '1024-65535')
  const [intPorts, setIntPorts] = useState(shown?.intPorts ?? '1024-65535')
  const [comment, setComment] = useState(shown?.comment ?? '')
  const [placement, setPlacement] = useState<'top' | 'bottom'>('top')
  const [applyNow, setApplyNow] = useState(true)
  const [touched, setTouched] = useState(false)

  const errors = {
    extPorts: portsError(extPorts),
    intPorts: portsError(intPorts),
    target: target === 'device' ? (deviceMac ? null : 'Pick a device.') : addrError(intAddr),
  }
  const invalid = Object.values(errors).some(Boolean)

  async function submit() {
    setTouched(true)
    if (invalid) return
    const input: UpnpAclInput = {
      action,
      extPorts: extPorts.trim(),
      intPorts: intPorts.trim(),
      comment: comment.trim() || null,
      ...(target === 'device' ? { deviceMac } : { intAddr: intAddr.trim() }),
      ...(shown ? {} : { placement }),
    }
    try {
      const answer = await save.mutateAsync({ perchId: shown?.id ?? null, input, apply: applyNow })
      onWrite({
        what: shown ? 'Saved the UPnP rule' : 'Added a UPnP rule',
        issues: answer.issues,
        apply: answer.apply,
        applyError: answer.applyError,
      })
      onOpenChange(false)
    } catch {
      // shown
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="upnp-acl-dialog">
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <DialogHeader>
            <DialogTitle>{shown ? 'Edit UPnP rule' : 'New UPnP rule'}</DialogTitle>
            <DialogDescription>Which device may ask {gateway.name} to open which ports.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <FormField label="The rule">
              <Segmented
                size="xs"
                ariaLabel="Allow or deny"
                value={action}
                onChange={setAction}
                options={[
                  { id: 'allow', label: 'Allow' },
                  { id: 'deny', label: 'Deny' },
                ]}
                className="w-fit"
              />
            </FormField>
            <FormField label="For" error={touched ? (errors.target ?? undefined) : undefined}>
              <Segmented
                size="xs"
                ariaLabel="A device or an address"
                value={target}
                onChange={setTarget}
                options={[
                  { id: 'device', label: 'A device' },
                  { id: 'address', label: 'An address or subnet' },
                ]}
                className="w-fit"
              />
              {target === 'device' ? (
                <select
                  aria-label="Device"
                  className={cn(selectClassName, 'mt-1.5 max-sm:h-9')}
                  value={deviceMac}
                  onChange={(e) => setDeviceMac(e.target.value)}
                >
                  <option value="">{devices.isPending ? 'Loading devices…' : 'Pick a device'}</option>
                  {devices.list.map((d) => (
                    <option key={d.mac} value={d.mac}>
                      {d.name}
                      {d.ips[0] ? ` (${d.ips[0]})` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  aria-label="Address or subnet"
                  className="mt-1.5 font-mono"
                  placeholder="192.168.1.0/24"
                  value={intAddr}
                  onChange={(e) => setIntAddr(e.target.value)}
                />
              )}
            </FormField>
            <div className="grid grid-cols-2 gap-3">
              <FormField
                label="Ports on the internet side"
                htmlFor={`${id}-ext`}
                error={touched ? (errors.extPorts ?? undefined) : undefined}
              >
                <Input id={`${id}-ext`} className="font-mono" inputMode="numeric" value={extPorts} onChange={(e) => setExtPorts(e.target.value)} />
              </FormField>
              <FormField
                label="Ports on the device"
                htmlFor={`${id}-int`}
                error={touched ? (errors.intPorts ?? undefined) : undefined}
              >
                <Input id={`${id}-int`} className="font-mono" inputMode="numeric" value={intPorts} onChange={(e) => setIntPorts(e.target.value)} />
              </FormField>
            </div>
            <FormField label="Comment" htmlFor={`${id}-comment`} hint="Optional.">
              <Input id={`${id}-comment`} value={comment} maxLength={64} onChange={(e) => setComment(e.target.value)} />
            </FormField>
            {!shown ? (
              <FormField label="Place it">
                <Segmented
                  size="xs"
                  ariaLabel="Where the rule goes"
                  value={placement}
                  onChange={setPlacement}
                  options={[
                    { id: 'top', label: 'First' },
                    { id: 'bottom', label: 'Last' },
                  ]}
                  className="w-fit"
                />
              </FormField>
            ) : null}
            <ErrorNote error={save.error} />
          </DialogBody>
          <DialogFooter className="sm:items-center">
            <div className="max-sm:order-last sm:mr-auto">
              <ApplyNowCheckbox id={`${id}-apply`} checked={applyNow} onChange={setApplyNow} />
            </div>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending || (touched && invalid)}>
              {save.isPending ? <Spinner className="size-3.5 text-current" /> : null}
              {shown ? 'Save' : 'Add rule'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
