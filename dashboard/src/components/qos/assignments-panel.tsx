import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { ArrowCounterClockwise, PencilSimple, Plus, Trash } from '@phosphor-icons/react'
import type { KnownDevice } from '@/components/qos/groups-panel'
import { CheckRow, QuotaBar, RateFields, RefusalAlert, StatePill } from '@/components/qos/qos-bits'
import { NativeSelect } from '@/components/infra/native-select'
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
import { Label } from '@/components/ui/label'
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import type { QosWrites } from '@/hooks/use-qos'
import { formatLastSeen } from '@/lib/collectors'
import { formatBytes } from '@/lib/format-bytes'
import {
  bytesToQuotaInput,
  formatRatePair,
  formatWhen,
  isPast,
  kbitToInput,
  normalizeMacInput,
  parseQuotaInput,
  parseRatePair,
  QUOTA_UNITS,
  SHAPING_STATE,
  type QuotaUnit,
} from '@/lib/qos'
import { macPath } from '@/lib/traffic'
import type { DeviceShaping, QosAssignment, QosAssignmentInput, QosGroup, QosPolicy, QosTarget } from '@/types/api'

type Props = {
  assignments: QosAssignment[]
  policies: QosPolicy[]
  groups: QosGroup[]
  devices: KnownDevice[]
  shaping: DeviceShaping[]
  canEdit: boolean
  writes: QosWrites
}

/**
 * Who gets which policy (docs/gateway/qos.md 3.2): a device's own assignment
 * beats its group's, which beats its network's default. Quotas ride on device
 * assignments; an expired assignment stays listed (inert) for a while.
 */
export function AssignmentsPanel({ assignments, policies, groups, devices, shaping, canEdit, writes }: Props) {
  const [editing, setEditing] = useState<QosAssignment | 'new' | null>(null)
  const [deleting, setDeleting] = useState<QosAssignment | null>(null)
  const [resetting, setResetting] = useState<QosAssignment | null>(null)
  const names = new Map(devices.map((d) => [d.mac, d.name]))
  const policyName = new Map(policies.map((p) => [p.id, p.name]))
  const groupName = new Map(groups.map((g) => [g.id, g.name]))
  const stateByAssignment = new Map<number, DeviceShaping['state']>()
  for (const s of shaping) if (s.assignmentId !== null && s.via === 'device') stateByAssignment.set(s.assignmentId, s.state)
  const order = { device: 0, group: 1, network: 2 }
  const rows = [...assignments].sort((a, b) => order[a.target.type] - order[b.target.type] || a.id - b.id)
  const close = () => {
    writes.createAssignment.reset()
    writes.updateAssignment.reset()
    setEditing(null)
  }

  return (
    <Panel
      title="Assignments"
      description="A device's own assignment wins over its group's, which wins over its network's default."
      actions={
        canEdit ? (
          <Button size="sm" variant="outline" onClick={() => setEditing('new')}>
            <Plus className="size-3.5" /> Assign
          </Button>
        ) : null
      }
      flush
    >
      {rows.length === 0 ? (
        <div className="px-4 pb-4">
          <EmptyState title="Nothing assigned" description="No device, group or network has a cap, so nothing is limited. Assign a policy to a guest or lab network to cap it." />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table min-w-[720px]">
            <thead>
              <tr>
                <th>Target</th>
                <th>Policy</th>
                <th>Own rate</th>
                <th>Quota</th>
                <th>Expires</th>
                {canEdit ? <th className="text-right">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const expired = isPast(a.expiresAt)
                const state = stateByAssignment.get(a.id)
                return (
                  <tr key={a.id} className={expired ? 'opacity-60' : undefined}>
                    <td>
                      <TargetCell target={a.target} names={names} groupName={groupName} />
                      <p className="mt-0.5 flex flex-wrap gap-1">
                        {a.source === 'portal' ? <Badge variant="secondary" className="h-4 rounded px-1 text-[10px]">Portal</Badge> : null}
                        {state ? (
                          <StatePill tone={SHAPING_STATE[state].tone} title={SHAPING_STATE[state].hint}>
                            {SHAPING_STATE[state].label}
                          </StatePill>
                        ) : null}
                      </p>
                    </td>
                    <td>{a.policyId !== null ? (policyName.get(a.policyId) ?? `#${a.policyId}`) : <span className="text-muted-foreground">—</span>}</td>
                    <td className="whitespace-nowrap">{a.rate ? formatRatePair(a.rate) : <span className="text-muted-foreground">policy's</span>}</td>
                    <td>
                      {a.quota ? (
                        <div className="space-y-0.5">
                          <QuotaBar quota={a.quota} compact />
                          <p className="text-[10px] text-muted-foreground">
                            then {a.quota.onExhausted === 'block' ? 'blocked' : `throttled to ${formatRatePair(a.quota.throttle)}`}
                            {a.quota.resetAt ? ` · reset ${formatLastSeen(a.quota.resetAt)}` : ''}
                          </p>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap">
                      {a.expiresAt ? (
                        <span className={expired ? 'text-status-critical' : undefined} title={formatWhen(a.expiresAt)}>
                          {expired ? 'expired' : formatWhen(a.expiresAt)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">never</span>
                      )}
                    </td>
                    {canEdit ? (
                      <td className="text-right whitespace-nowrap">
                        {a.quota ? (
                          <Button size="xs" variant="ghost" onClick={() => setResetting(a)} title="Start the quota over">
                            <ArrowCounterClockwise /> Reset
                          </Button>
                        ) : null}
                        <Button size="xs" variant="ghost" onClick={() => setEditing(a)} aria-label={`Edit assignment ${a.id}`}>
                          <PencilSimple />
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => setDeleting(a)} aria-label={`Delete assignment ${a.id}`}>
                          <Trash />
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing !== null ? (
        <AssignmentDialog
          assignment={editing === 'new' ? null : editing}
          policies={policies}
          groups={groups}
          devices={devices}
          writes={writes}
          onClose={close}
        />
      ) : null}
      {deleting ? (
        <Dialog open onOpenChange={(open) => !open && setDeleting(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Remove this assignment?</DialogTitle>
              <DialogDescription>
                <TargetText target={deleting.target} names={names} groupName={groupName} /> falls back to the next rule
                (group, then network default).
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              {deleting.source === 'portal' ? <p>The captive portal made it: removing it ends that guest's grant here.</p> : null}
              {writes.deleteAssignment.error ? <RefusalAlert error={writes.deleteAssignment.error} /> : null}
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
              <Button
                variant="destructive"
                disabled={writes.deleteAssignment.isPending}
                onClick={() => writes.deleteAssignment.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
              >
                Remove
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      {resetting ? (
        <Dialog open onOpenChange={(open) => !open && setResetting(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Reset the quota?</DialogTitle>
              <DialogDescription>
                <TargetText target={resetting.target} names={names} groupName={groupName} /> has used{' '}
                {formatBytes(resetting.quota?.usedBytes ?? 0)} of {formatBytes(resetting.quota?.limitBytes ?? 0)}.
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <p>Usage starts again from zero; a blocked or throttled device gets its full rate back once the router takes the reset.</p>
              {writes.resetQuota.error ? <RefusalAlert error={writes.resetQuota.error} /> : null}
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => setResetting(null)}>Cancel</Button>
              <Button disabled={writes.resetQuota.isPending} onClick={() => writes.resetQuota.mutate(resetting.id, { onSuccess: () => setResetting(null) })}>
                Reset quota
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </Panel>
  )
}

function TargetText({ target, names, groupName }: { target: QosTarget; names: Map<string, string>; groupName: Map<number, string> }) {
  if (target.type === 'device') return <>{names.get(target.mac) ?? target.mac}</>
  if (target.type === 'group') return <>Group {groupName.get(target.groupId) ?? `#${target.groupId}`}</>
  return <>Network {target.network}</>
}

function TargetCell({ target, names, groupName }: { target: QosTarget; names: Map<string, string>; groupName: Map<number, string> }) {
  if (target.type === 'device') {
    return (
      <div className="min-w-0">
        <Link to={`/devices/${macPath(target.mac)}`} className="font-medium hover:underline">
          {names.get(target.mac) ?? 'Device'}
        </Link>
        <p className="font-mono text-[11px] text-muted-foreground">{target.mac}</p>
      </div>
    )
  }
  if (target.type === 'group') {
    return (
      <div>
        <p className="font-medium">{groupName.get(target.groupId) ?? `#${target.groupId}`}</p>
        <p className="text-[11px] text-muted-foreground">group</p>
      </div>
    )
  }
  return (
    <div>
      <p className="font-mono font-medium">{target.network}</p>
      <p className="text-[11px] text-muted-foreground">network default</p>
    </div>
  )
}

// ---------------------------------------------------------------------------

/** `datetime-local` value (local time) for an ISO instant. */
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const EXPIRY_PRESETS = [
  { label: '1 hour', ms: 3600_000 },
  { label: '1 day', ms: 86_400_000 },
  { label: '1 week', ms: 7 * 86_400_000 },
]

function AssignmentDialog({
  assignment,
  policies,
  groups,
  devices,
  writes,
  onClose,
}: {
  assignment: QosAssignment | null
  policies: QosPolicy[]
  groups: QosGroup[]
  devices: KnownDevice[]
  writes: QosWrites
  onClose: () => void
}) {
  const t = assignment?.target
  const [type, setType] = useState<QosTarget['type']>(t?.type ?? 'device')
  const [device, setDevice] = useState(t?.type === 'device' ? t.mac : '')
  const [groupId, setGroupId] = useState<string>(t?.type === 'group' ? String(t.groupId) : (groups[0] ? String(groups[0].id) : ''))
  const [network, setNetwork] = useState(t?.type === 'network' ? t.network : '')
  const [policyId, setPolicyId] = useState<string>(assignment?.policyId != null ? String(assignment.policyId) : '')
  const [hasRate, setHasRate] = useState(assignment?.rate != null)
  const [rate, setRate] = useState({ down: kbitToInput(assignment?.rate?.downloadKbit), up: kbitToInput(assignment?.rate?.uploadKbit) })
  const q = assignment?.quota ?? null
  const [hasQuota, setHasQuota] = useState(q !== null)
  const initialQuota = q ? bytesToQuotaInput(q.limitBytes) : { value: '5', unit: 'GB' as QuotaUnit }
  const [quotaValue, setQuotaValue] = useState(initialQuota.value)
  const [quotaUnit, setQuotaUnit] = useState<QuotaUnit>(initialQuota.unit)
  const [onExhausted, setOnExhausted] = useState<'block' | 'throttle'>(q?.onExhausted ?? 'throttle')
  const [throttle, setThrottle] = useState({ down: kbitToInput(q?.throttle?.downloadKbit ?? 256), up: kbitToInput(q?.throttle?.uploadKbit ?? 128) })
  const [expires, setExpires] = useState(toLocalInput(assignment?.expiresAt ?? null))
  const [error, setError] = useState<string | null>(null)
  const mutation = assignment ? writes.updateAssignment : writes.createAssignment
  const quotaAllowed = type === 'device'

  function target(): QosTarget | null {
    if (type === 'device') {
      const byName = devices.find((d) => d.name.toLowerCase() === device.trim().toLowerCase())
      const mac = byName?.mac ?? normalizeMacInput(device)
      return mac ? { type: 'device', mac } : null
    }
    if (type === 'group') return groupId ? { type: 'group', groupId: Number(groupId) } : null
    return network.trim() ? { type: 'network', network: network.trim() } : null
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    const body: QosAssignmentInput = { policyId: policyId === '' ? null : Number(policyId) }
    if (hasRate) {
      const r = parseRatePair(rate.down, rate.up)
      if (!r.ok) return setError(r.message)
      body.rate = r.rate
    } else body.rate = null
    if (hasQuota && quotaAllowed) {
      const limitBytes = parseQuotaInput(quotaValue, quotaUnit)
      if (limitBytes === null) return setError('Enter the quota as a number of MB or GB.')
      if (onExhausted === 'throttle') {
        const r = parseRatePair(throttle.down, throttle.up)
        if (!r.ok) return setError(r.message)
        if (r.rate.downloadKbit === null && r.rate.uploadKbit === null) return setError('A throttling quota needs the throttle rate.')
        body.quota = { limitBytes, onExhausted, throttle: r.rate }
      } else body.quota = { limitBytes, onExhausted }
    } else body.quota = null
    if (assignment && expires === toLocalInput(assignment.expiresAt)) {
      // Unchanged: leave it out (an expired one would be refused as in the past).
    } else if (expires) {
      const at = new Date(expires)
      if (Number.isNaN(at.getTime())) return setError('That expiry is not a date.')
      body.expiresAt = at.toISOString()
    } else body.expiresAt = null
    if (body.policyId === null && !body.rate && !body.quota) return setError('Pick a policy, an own rate or a quota.')
    if (assignment) {
      writes.updateAssignment.mutate({ id: assignment.id, patch: body }, { onSuccess: onClose })
    } else {
      const tg = target()
      if (!tg) return setError(type === 'device' ? 'Pick a device or type its MAC.' : type === 'group' ? 'Pick a group.' : 'Name the network (for example guest).')
      writes.createAssignment.mutate({ ...body, target: tg }, { onSuccess: onClose })
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent wide>
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{assignment ? 'Edit assignment' : 'Assign a policy'}</DialogTitle>
            <DialogDescription>Caps count internet traffic only unless the policy also covers LAN↔LAN.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {assignment ? (
              <p className="text-xs">
                Target: <strong>{t?.type === 'device' ? (devices.find((d) => d.mac === t.mac)?.name ?? t.mac) : t?.type === 'group' ? `group ${groups.find((g) => g.id === t.groupId)?.name ?? t.groupId}` : `network ${t?.type === 'network' ? t.network : ''}`}</strong>
                <span className="text-muted-foreground"> (to change it, remove this and assign again)</span>
              </p>
            ) : (
              <div className="space-y-2">
                <Segmented
                  ariaLabel="Target"
                  size="xs"
                  value={type}
                  onChange={setType}
                  options={[
                    { id: 'device', label: 'Device' },
                    { id: 'group', label: 'Group' },
                    { id: 'network', label: 'Network' },
                  ]}
                  className="w-fit"
                />
                {type === 'device' ? (
                  <div className="space-y-1">
                    <Label htmlFor="as-device" className="text-xs font-medium">Device</Label>
                    <Input id="as-device" list="as-devices" value={device} onChange={(e) => setDevice(e.target.value)} placeholder="Device name or MAC" className="rounded-md" />
                    <datalist id="as-devices">
                      {devices.map((d) => (
                        <option key={d.mac} value={d.name}>{d.mac}</option>
                      ))}
                    </datalist>
                    <p className="text-xs text-muted-foreground">A MAC that has not shown up yet works too: the cap waits for it.</p>
                  </div>
                ) : type === 'group' ? (
                  <div className="space-y-1">
                    <Label htmlFor="as-group" className="text-xs font-medium">Group</Label>
                    {groups.length ? (
                      <NativeSelect id="as-group" className="rounded-md" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                        {groups.map((g) => (
                          <option key={g.id} value={g.id}>{g.name} ({g.members.length})</option>
                        ))}
                      </NativeSelect>
                    ) : (
                      <p className="text-xs text-muted-foreground">No groups yet: create one under Policies.</p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-1">
                    <Label htmlFor="as-net" className="text-xs font-medium">Network (router interface)</Label>
                    <Input id="as-net" value={network} onChange={(e) => setNetwork(e.target.value)} placeholder="guest" className="rounded-md font-mono" />
                    <p className="text-xs text-muted-foreground">The default for every device on that network without a rule of its own.</p>
                  </div>
                )}
              </div>
            )}

            <div className="space-y-1">
              <Label htmlFor="as-policy" className="text-xs font-medium">Policy</Label>
              <NativeSelect id="as-policy" className="rounded-md" value={policyId} onChange={(e) => setPolicyId(e.target.value)}>
                <option value="">No policy (own rate or quota only)</option>
                {policies.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.enabled}>
                    {p.name}
                    {p.shared ? ` · bucket ${formatRatePair(p.shared)}` : ''}
                    {p.each ? ` · each ${formatRatePair(p.each)}` : ''}
                    {!p.enabled ? ' (off)' : ''}
                  </option>
                ))}
              </NativeSelect>
            </div>

            <div className="space-y-2 rounded-md border border-border p-3">
              <CheckRow checked={hasRate} onChange={setHasRate} label="Own rate" hint="Overrides the policy's per-device cap for this target." />
              {hasRate ? (
                <RateFields idPrefix="as-rate" label="Rate" down={rate.down} up={rate.up} onDown={(v) => setRate((r) => ({ ...r, down: v }))} onUp={(v) => setRate((r) => ({ ...r, up: v }))} />
              ) : null}
            </div>

            <div className="space-y-2 rounded-md border border-border p-3">
              <CheckRow
                checked={hasQuota && quotaAllowed}
                disabled={!quotaAllowed}
                onChange={setHasQuota}
                label="Data quota"
                hint={quotaAllowed ? 'Counts internet traffic both ways; the router enforces it even while the controller is away.' : 'Quotas work on single devices only.'}
              />
              {hasQuota && quotaAllowed ? (
                <div className="space-y-2">
                  {q ? (
                    <QuotaBar quota={q} />
                  ) : null}
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                    <Input aria-label="Quota" inputMode="decimal" value={quotaValue} onChange={(e) => setQuotaValue(e.target.value)} className="rounded-md" />
                    <NativeSelect aria-label="Quota unit" className="w-20 rounded-md" value={quotaUnit} onChange={(e) => setQuotaUnit(e.target.value as QuotaUnit)}>
                      {QUOTA_UNITS.map((u) => (
                        <option key={u.id} value={u.id}>{u.id}</option>
                      ))}
                    </NativeSelect>
                  </div>
                  <Segmented
                    ariaLabel="When the quota runs out"
                    size="xs"
                    value={onExhausted}
                    onChange={setOnExhausted}
                    options={[
                      { id: 'throttle', label: 'Then throttle' },
                      { id: 'block', label: 'Then block' },
                    ]}
                    className="w-fit"
                  />
                  {onExhausted === 'throttle' ? (
                    <RateFields idPrefix="as-throttle" label="Throttled rate" down={throttle.down} up={throttle.up} onDown={(v) => setThrottle((r) => ({ ...r, down: v }))} onUp={(v) => setThrottle((r) => ({ ...r, up: v }))} />
                  ) : (
                    <p className="text-xs text-muted-foreground">Blocked devices lose the internet; DNS and the portal stay reachable.</p>
                  )}
                  {q ? <p className="text-xs text-muted-foreground">Changing the limit keeps what was used; a higher limit lifts a used-up quota.</p> : null}
                </div>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="as-exp" className="text-xs font-medium">Expires</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input id="as-exp" type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} className="w-auto rounded-md" />
                {EXPIRY_PRESETS.map((p) => (
                  <Button key={p.label} type="button" size="xs" variant="outline" onClick={() => setExpires(toLocalInput(new Date(Date.now() + p.ms).toISOString()))}>
                    {p.label}
                  </Button>
                ))}
                <Button type="button" size="xs" variant="ghost" onClick={() => setExpires('')}>Never</Button>
              </div>
              <p className="text-xs text-muted-foreground">In your browser's time. After it the target falls back to the next rule.</p>
            </div>

            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            {mutation.error ? <RefusalAlert error={mutation.error} /> : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? 'Saving…' : assignment ? 'Save' : 'Assign'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
