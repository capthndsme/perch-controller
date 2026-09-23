import { useMemo, useState, type FormEvent } from 'react'
import { CalendarDots, PencilSimple, Plus, Trash } from '@phosphor-icons/react'
import type { KnownDevice } from '@/components/qos/groups-panel'
import { CheckRow, RefusalAlert, StatePill } from '@/components/qos/qos-bits'
import { NativeSelect } from '@/components/infra/native-select'
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
import {
  dayLabel,
  DAYS,
  formatDays,
  formatOverridePair,
  formatWhen,
  formatWindowTimes,
  minuteToTime,
  overrideToInput,
  parseOverrideInput,
  timeToMinute,
  windowActiveAt,
} from '@/lib/qos'
import { cn } from '@/lib/utils'
import type {
  QosAssignment,
  QosDay,
  QosGroup,
  QosOverview,
  QosPolicy,
  QosRateOverride,
  QosSchedule,
  QosScheduleAction,
  QosScheduleInput,
} from '@/types/api'

type Props = {
  schedules: QosSchedule[]
  policies: QosPolicy[]
  assignments: QosAssignment[]
  groups: QosGroup[]
  devices: KnownDevice[]
  overview: QosOverview | undefined
  canEdit: boolean
  writes: QosWrites
}

const ACTION_TEXT: Record<QosScheduleAction, string> = {
  limit: 'Different rates',
  unlimited: 'No cap',
  block: 'No internet',
  policy: 'Move to another policy',
}

/**
 * Weekly windows in which a policy or an assignment behaves differently
 * (docs/gateway/qos.md 3.4). The router runs them on its own clock; "active
 * now" here is the controller's preview in the zone the API names.
 */
export function SchedulesPanel({ schedules, policies, assignments, groups, devices, overview, canEdit, writes }: Props) {
  const [editing, setEditing] = useState<QosSchedule | 'new' | null>(null)
  const [deleting, setDeleting] = useState<QosSchedule | null>(null)
  const names = useMemo(() => targetNames(policies, assignments, groups, devices), [policies, assignments, groups, devices])
  const policyName = new Map(policies.map((p) => [p.id, p.name]))
  const reported = new Map((overview?.schedules.reported ?? []).map((r) => [r.name, r]))
  const zone = schedules[0]?.previewTimezone ?? null
  const routerZone = overview?.capabilities?.timezone ?? null
  const close = () => {
    writes.createSchedule.reset()
    writes.updateSchedule.reset()
    setEditing(null)
  }

  return (
    <Panel
      title="Schedules"
      description={
        <>
          Weekly windows, for example the kids' group at night. The router switches on its own clock, even while the
          controller is away.
          {zone ? ` "Active now" is previewed in ${zone}.` : ''}
          {routerZone && zone && routerZone !== zone ? ` The router's zone is ${routerZone}.` : ''}
          {overview?.schedules.nextChangeAt ? ` Next change: ${formatWhen(overview.schedules.nextChangeAt)}.` : ''}
        </>
      }
      actions={
        canEdit ? (
          <Button size="sm" variant="outline" onClick={() => setEditing('new')} disabled={policies.length === 0 && assignments.length === 0}>
            <Plus className="size-3.5" /> New schedule
          </Button>
        ) : null
      }
    >
      {schedules.length === 0 ? (
        <EmptyState icon={<CalendarDots className="size-5" />} title="No schedules" description="Caps apply around the clock." />
      ) : (
        <ul className="grid gap-2 lg:grid-cols-2">
          {schedules.map((s) => {
            const rep = reported.get(`s${s.id}`)
            const target = s.target.type === 'policy' ? names.policy.get(s.target.policyId) : names.assignment.get(s.target.assignmentId)
            const rates = [
              formatOverridePair(s.shared) ? `bucket ${formatOverridePair(s.shared)}` : null,
              formatOverridePair(s.each) ? `each ${formatOverridePair(s.each)}` : null,
              formatOverridePair(s.rate) ? `rate ${formatOverridePair(s.rate)}` : null,
            ].filter(Boolean)
            return (
              <li key={s.id} className={cn('rounded-lg border p-3', s.active ? 'border-brand/50 bg-brand/5' : 'border-border', !s.enabled && 'opacity-60')}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 space-y-0.5">
                    <p className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold">
                      {s.name}
                      {!s.enabled ? (
                        <StatePill tone="muted">Off</StatePill>
                      ) : s.active ? (
                        <StatePill tone="info" title={`Preview in ${s.previewTimezone}`}>Active now</StatePill>
                      ) : (
                        <StatePill tone="muted" title={`Preview in ${s.previewTimezone}`}>Not now</StatePill>
                      )}
                      {rep && rep.active !== s.active ? (
                        <StatePill tone="warning" title="What the router reports differs from the preview (clock or zone).">
                          Router: {rep.active ? 'active' : 'inactive'}
                        </StatePill>
                      ) : null}
                    </p>
                    <p className="text-[12px]">
                      {formatDays(s.days)} · {formatWindowTimes(s.startMinute, s.endMinute)}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {target ?? 'unknown target'} · {ACTION_TEXT[s.action]}
                      {s.action === 'policy' && s.usePolicyId !== null ? ` ${policyName.get(s.usePolicyId) ?? `#${s.usePolicyId}`}` : ''}
                      {rates.length ? ` · ${rates.join(' · ')}` : ''}
                    </p>
                  </div>
                  {canEdit ? (
                    <div className="flex shrink-0 gap-1">
                      <Button size="xs" variant="ghost" onClick={() => setEditing(s)} aria-label={`Edit ${s.name}`}>
                        <PencilSimple /> Edit
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => setDeleting(s)} aria-label={`Delete ${s.name}`}>
                        <Trash />
                      </Button>
                    </div>
                  ) : null}
                </div>
                <WeekStrip days={s.days} startMinute={s.startMinute} endMinute={s.endMinute} />
              </li>
            )
          })}
        </ul>
      )}
      {editing !== null ? (
        <ScheduleDialog
          schedule={editing === 'new' ? null : editing}
          policies={policies}
          assignments={assignments}
          names={names}
          zone={zone ?? routerZone ?? 'UTC'}
          writes={writes}
          onClose={close}
        />
      ) : null}
      {deleting ? (
        <Dialog open onOpenChange={(open) => !open && setDeleting(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete the schedule {deleting.name}?</DialogTitle>
              <DialogDescription>Its target keeps its normal rates around the clock.</DialogDescription>
            </DialogHeader>
            <DialogBody>{writes.deleteSchedule.error ? <RefusalAlert error={writes.deleteSchedule.error} /> : null}</DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
              <Button variant="destructive" disabled={writes.deleteSchedule.isPending} onClick={() => writes.deleteSchedule.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}>
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </Panel>
  )
}

type TargetNames = { policy: Map<number, string>; assignment: Map<number, string> }

function targetNames(policies: QosPolicy[], assignments: QosAssignment[], groups: QosGroup[], devices: KnownDevice[]): TargetNames {
  const deviceName = new Map(devices.map((d) => [d.mac, d.name]))
  const groupName = new Map(groups.map((g) => [g.id, g.name]))
  return {
    policy: new Map(policies.map((p) => [p.id, `Policy ${p.name}`])),
    assignment: new Map(
      assignments.map((a) => [
        a.id,
        a.target.type === 'device'
          ? (deviceName.get(a.target.mac) ?? a.target.mac)
          : a.target.type === 'group'
            ? `Group ${groupName.get(a.target.groupId) ?? a.target.groupId}`
            : `Network ${a.target.network}`,
      ]),
    ),
  }
}

/** Seven small bars, Monday first: the hours the window covers (a window past midnight spills into the next day). */
function WeekStrip({ days, startMinute, endMinute }: { days: QosDay[]; startMinute: number; endMinute: number }) {
  const covered = DAYS.map(() => [] as Array<[number, number]>)
  for (let d = 0; d < 7; d++) {
    if (!days.includes(DAYS[d])) continue
    if (endMinute > startMinute) covered[d].push([startMinute, endMinute])
    else {
      covered[d].push([startMinute, 1440])
      if (endMinute > 0 || startMinute === endMinute) covered[(d + 1) % 7].push([0, startMinute === endMinute ? startMinute : endMinute])
    }
  }
  return (
    <div className="mt-2 grid grid-cols-7 gap-1" aria-hidden>
      {DAYS.map((day, d) => (
        <div key={day} className="space-y-0.5">
          <div className="relative h-2 overflow-hidden rounded-sm bg-muted">
            {covered[d].map(([a, b], i) => (
              <span key={i} className="absolute inset-y-0 bg-brand/70" style={{ left: `${(a / 1440) * 100}%`, width: `${((b - a) / 1440) * 100}%` }} />
            ))}
          </div>
          <p className="text-center text-[9px] text-muted-foreground">{dayLabel(day)}</p>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------

type OverrideForm = { down: string; up: string }
const toOverrideForm = (o: QosRateOverride | null): OverrideForm => ({ down: overrideToInput(o?.downloadKbit), up: overrideToInput(o?.uploadKbit) })

function parseOverride(form: OverrideForm): { ok: true; value: QosRateOverride | null } | { ok: false; message: string } {
  const d = parseOverrideInput(form.down)
  if (!d.ok) return d
  const u = parseOverrideInput(form.up)
  if (!u.ok) return u
  if (d.kbit === null && u.kbit === null) return { ok: true, value: null }
  return { ok: true, value: { downloadKbit: d.kbit, uploadKbit: u.kbit } }
}

function ScheduleDialog({
  schedule,
  policies,
  assignments,
  names,
  zone,
  writes,
  onClose,
}: {
  schedule: QosSchedule | null
  policies: QosPolicy[]
  assignments: QosAssignment[]
  names: TargetNames
  zone: string
  writes: QosWrites
  onClose: () => void
}) {
  const [name, setName] = useState(schedule?.name ?? '')
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true)
  const [targetType, setTargetType] = useState<'policy' | 'assignment'>(schedule?.target.type ?? (policies.length ? 'policy' : 'assignment'))
  const [policyId, setPolicyId] = useState(String(schedule?.target.type === 'policy' ? schedule.target.policyId : (policies[0]?.id ?? '')))
  const [assignmentId, setAssignmentId] = useState(String(schedule?.target.type === 'assignment' ? schedule.target.assignmentId : (assignments[0]?.id ?? '')))
  const [action, setAction] = useState<QosScheduleAction>(schedule?.action ?? 'limit')
  const [usePolicyId, setUsePolicyId] = useState(String(schedule?.usePolicyId ?? policies[0]?.id ?? ''))
  const [shared, setShared] = useState(toOverrideForm(schedule?.shared ?? null))
  const [each, setEach] = useState(toOverrideForm(schedule?.each ?? null))
  const [rate, setRate] = useState(toOverrideForm(schedule?.rate ?? null))
  const [days, setDays] = useState<QosDay[]>(schedule?.days ?? ['mon', 'tue', 'wed', 'thu', 'fri'])
  const [start, setStart] = useState(minuteToTime(schedule?.startMinute ?? 22 * 60))
  const [end, setEnd] = useState(minuteToTime(schedule?.endMinute ?? 7 * 60))
  const [error, setError] = useState<string | null>(null)
  const mutation = schedule ? writes.updateSchedule : writes.createSchedule

  const assignment = targetType === 'assignment' ? assignments.find((a) => String(a.id) === assignmentId) : undefined
  const actions: QosScheduleAction[] =
    targetType === 'policy'
      ? ['limit', 'unlimited']
      : assignment?.target.type === 'network'
        ? ['limit', 'unlimited', 'policy']
        : ['limit', 'unlimited', 'block', 'policy']
  const startMinute = timeToMinute(start)
  const endMinute = timeToMinute(end)
  const previewNow =
    startMinute !== null && endMinute !== null && days.length ? windowActiveAt(days, startMinute, endMinute, new Date(), zone) : null

  function toggleDay(day: QosDay) {
    setDays((list) => (list.includes(day) ? list.filter((d) => d !== day) : DAYS.filter((d) => d === day || list.includes(d))))
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (!name.trim()) return setError('Give the schedule a name.')
    if (days.length === 0) return setError('Pick at least one day.')
    if (startMinute === null || endMinute === null) return setError('Times are HH:MM.')
    if (!actions.includes(action)) return setError('That action does not work on this target.')
    const body: QosScheduleInput = { name: name.trim(), enabled, action, days, startMinute, endMinute }
    if (action === 'limit') {
      if (targetType === 'policy') {
        const s = parseOverride(shared)
        const e = parseOverride(each)
        if (!s.ok) return setError(s.message)
        if (!e.ok) return setError(e.message)
        if (!s.value && !e.value) return setError('Set at least one rate (0 = unlimited, empty = keep).')
        body.shared = s.value
        body.each = e.value
      } else {
        const r = parseOverride(rate)
        if (!r.ok) return setError(r.message)
        if (!r.value) return setError('Set at least one rate (0 = unlimited, empty = keep).')
        body.rate = r.value
      }
    }
    if (action === 'policy') {
      if (!usePolicyId) return setError('Pick the policy the devices move to.')
      body.usePolicyId = Number(usePolicyId)
    }
    if (schedule) {
      writes.updateSchedule.mutate({ id: schedule.id, patch: body }, { onSuccess: onClose })
    } else {
      const target = targetType === 'policy' ? { type: 'policy' as const, policyId: Number(policyId) } : { type: 'assignment' as const, assignmentId: Number(assignmentId) }
      if (!Number(target.type === 'policy' ? policyId : assignmentId)) return setError('Pick what the schedule changes.')
      writes.createSchedule.mutate({ ...body, target }, { onSuccess: onClose })
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent wide>
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{schedule ? `Schedule ${schedule.name}` : 'New schedule'}</DialogTitle>
            <DialogDescription>Outside the window the normal rates apply.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="sc-name" className="text-xs font-medium">Name</Label>
                <Input id="sc-name" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder="School nights" className="rounded-md" />
              </div>
              <div className="pt-5">
                <CheckRow checked={enabled} onChange={setEnabled} label="Schedule on" />
              </div>
            </div>

            {schedule ? (
              <p>
                Changes: <strong>{schedule.target.type === 'policy' ? names.policy.get(schedule.target.policyId) : names.assignment.get(schedule.target.assignmentId)}</strong>
              </p>
            ) : (
              <div className="space-y-2">
                <Segmented
                  ariaLabel="What it changes"
                  size="xs"
                  value={targetType}
                  onChange={setTargetType}
                  options={[
                    { id: 'policy', label: 'A policy' },
                    { id: 'assignment', label: 'An assignment' },
                  ]}
                  className="w-fit"
                />
                {targetType === 'policy' ? (
                  <NativeSelect aria-label="Policy" className="rounded-md" value={policyId} onChange={(e) => setPolicyId(e.target.value)}>
                    {policies.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </NativeSelect>
                ) : (
                  <NativeSelect aria-label="Assignment" className="rounded-md" value={assignmentId} onChange={(e) => setAssignmentId(e.target.value)}>
                    {assignments.map((a) => (
                      <option key={a.id} value={a.id}>{names.assignment.get(a.id)}</option>
                    ))}
                  </NativeSelect>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <p className="text-xs font-medium">Days (the day a window starts)</p>
              <div className="flex flex-wrap gap-1" role="group" aria-label="Days">
                {DAYS.map((day) => (
                  <Button key={day} type="button" size="xs" variant={days.includes(day) ? 'secondary' : 'outline'} aria-pressed={days.includes(day)} onClick={() => toggleDay(day)} className="w-11">
                    {dayLabel(day)}
                  </Button>
                ))}
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1">
                  <Label htmlFor="sc-start" className="text-[11px] text-muted-foreground">From</Label>
                  <Input id="sc-start" type="time" value={start} onChange={(e) => setStart(e.target.value)} className="w-28 rounded-md" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="sc-end" className="text-[11px] text-muted-foreground">Until</Label>
                  <Input id="sc-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="w-28 rounded-md" />
                </div>
              </div>
              {startMinute !== null && endMinute !== null ? (
                <>
                  <WeekStrip days={days} startMinute={startMinute} endMinute={endMinute} />
                  <p className="text-xs text-muted-foreground">
                    {formatDays(days)}, {formatWindowTimes(startMinute, endMinute)}.{' '}
                    {previewNow === null ? null : (
                      <span className={previewNow ? 'font-medium text-brand' : undefined}>
                        {previewNow ? 'Active now' : 'Not active now'} ({zone}).
                      </span>
                    )}
                  </p>
                </>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sc-action" className="text-xs font-medium">During the window</Label>
              <NativeSelect id="sc-action" className="rounded-md" value={action} onChange={(e) => setAction(e.target.value as QosScheduleAction)}>
                {actions.map((a) => (
                  <option key={a} value={a}>{ACTION_TEXT[a]}</option>
                ))}
              </NativeSelect>
              {action === 'block' ? <p className="text-xs text-muted-foreground">DNS and the portal stay reachable.</p> : null}
            </div>

            {action === 'limit' ? (
              <div className="space-y-2 rounded-md border border-border p-3">
                <p className="text-xs text-muted-foreground">Mbit/s. Empty keeps the normal value; 0 means unlimited.</p>
                {(targetType === 'policy' ? [['Shared bucket', shared, setShared], ['Each device', each, setEach]] : [['Rate', rate, setRate]]).map(
                  ([label, value, setter]) => {
                    const v = value as OverrideForm
                    const set = setter as (f: OverrideForm) => void
                    const id = String(label).replace(/\s+/g, '-').toLowerCase()
                    return (
                      <div key={String(label)} className="grid grid-cols-[6.5rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
                        <span className="text-xs">{String(label)}</span>
                        <Input aria-label={`${label} download`} id={`sc-${id}-down`} inputMode="decimal" placeholder="↓ keep" value={v.down} onChange={(e) => set({ ...v, down: e.target.value })} className="rounded-md" />
                        <Input aria-label={`${label} upload`} id={`sc-${id}-up`} inputMode="decimal" placeholder="↑ keep" value={v.up} onChange={(e) => set({ ...v, up: e.target.value })} className="rounded-md" />
                      </div>
                    )
                  },
                )}
              </div>
            ) : action === 'policy' ? (
              <div className="space-y-1">
                <Label htmlFor="sc-use" className="text-xs font-medium">Move to</Label>
                <NativeSelect id="sc-use" className="rounded-md" value={usePolicyId} onChange={(e) => setUsePolicyId(e.target.value)}>
                  {policies.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </NativeSelect>
              </div>
            ) : null}

            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            {mutation.error ? <RefusalAlert error={mutation.error} /> : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? 'Saving…' : schedule ? 'Save schedule' : 'Create schedule'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
