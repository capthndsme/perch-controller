import { useState, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, PencilSimple, Plus, WarningOctagon } from '@phosphor-icons/react'
import { CheckRow, RateBar, RefusalAlert, StatePill } from '@/components/qos/qos-bits'
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
import type { QosWrites } from '@/hooks/use-qos'
import { apiErrorCode } from '@/lib/api'
import {
  describeApply,
  formatKbit,
  formatWhen,
  kbitToInput,
  LINK_PRESETS,
  matchLinkPreset,
  parseMbitInput,
  refusalBody,
  WAN_FAIRNESS_LABEL,
  WAN_FLAG_TEXT,
} from '@/lib/qos'
import { cn } from '@/lib/utils'
import type { QosDiffserv, QosLinkLayer, QosQdiscStats, QosWanFairness, QosWanQueue, QosWanQueueInput, QosWarning } from '@/types/api'

type Props = {
  queues: QosWanQueue[]
  canEdit: boolean
  writes: QosWrites
}

/**
 * WAN queues (sqm-scripts, two-way synced; docs/gateway/qos.md section 2).
 * On the live gateway the imported queue is kept as it is (owner decision 14):
 * rows show where a queue came from, and editing is a deliberate step.
 */
export function WanQueuesPanel({ queues, canEdit, writes }: Props) {
  const [editing, setEditing] = useState<QosWanQueue | 'new' | null>(null)
  const [reenable, setReenable] = useState<QosWanQueue | null>(null)
  const closeEditor = () => {
    writes.createWanQueue.reset()
    writes.updateWanQueue.reset()
    setEditing(null)
  }
  const closeReenable = () => {
    writes.updateWanQueue.reset()
    setReenable(null)
  }

  return (
    <Panel
      title="WAN queues"
      description="Smart queueing on each internet line (sqm-scripts): keeps latency low when the line is full."
      actions={
        canEdit ? (
          <Button size="sm" variant="outline" onClick={() => setEditing('new')}>
            <Plus className="size-3.5" /> Add queue
          </Button>
        ) : null
      }
    >
      {queues.length === 0 ? (
        <EmptyState
          title="No WAN queue"
          description="The router has no sqm queue. Without one, a full line adds lag for everyone; add one with rates a little below what the line delivers."
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {queues.map((q) => (
            <WanQueueCard
              key={q.id}
              queue={q}
              canEdit={canEdit}
              onEdit={() => setEditing(q)}
              onReenable={() => setReenable(q)}
            />
          ))}
        </div>
      )}
      {editing !== null ? (
        <WanQueueDialog queue={editing === 'new' ? null : editing} writes={writes} onClose={closeEditor} />
      ) : null}
      {reenable ? <ReenableDialog queue={reenable} writes={writes} onClose={closeReenable} /> : null}
    </Panel>
  )
}

function WanQueueCard({
  queue: q,
  canEdit,
  onEdit,
  onReenable,
}: {
  queue: QosWanQueue
  canEdit: boolean
  onEdit: () => void
  onReenable: () => void
}) {
  const sync = describeApply(q.sync, 'wan')
  const preset = matchLinkPreset(q)
  const flags = q.flags.filter((f) => f !== 'router_paused')
  return (
    <article
      className={cn(
        'rounded-lg border p-3',
        q.pausedByRouter ? 'border-status-critical/60 bg-status-critical/5' : 'border-border',
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
            <span className="font-mono">{q.device}</span>
            {q.pausedByRouter ? (
              <Badge variant="destructive" className="rounded">
                <WarningOctagon weight="fill" /> Off on the router
              </Badge>
            ) : q.enabled ? (
              <Badge variant="secondary" className="rounded">On</Badge>
            ) : (
              <Badge variant="outline" className="rounded">Off</Badge>
            )}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {q.origin === 'router' ? 'Imported from the router, kept as it is' : 'Created by Perch'}
            {q.uciSection ? <> · <span className="font-mono">sqm.{q.uciSection}</span></> : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatePill tone={sync.tone} title={sync.detail ?? undefined}>{sync.label}</StatePill>
          {canEdit && q.pausedByRouter ? (
            <Button size="xs" variant="outline" onClick={onReenable}>Turn back on…</Button>
          ) : null}
          {canEdit ? (
            <Button size="xs" variant="ghost" onClick={onEdit} aria-label={`Edit the queue on ${q.device}`}>
              <PencilSimple /> Edit
            </Button>
          ) : null}
        </div>
      </header>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <LiveDirection
          label="Download"
          icon={<ArrowDown className="size-3.5" />}
          rateKbit={q.downloadKbit}
          stats={q.live?.ingress ?? null}
        />
        <LiveDirection
          label="Upload"
          icon={<ArrowUp className="size-3.5" />}
          rateKbit={q.uploadKbit}
          stats={q.live?.egress ?? null}
        />
      </div>

      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
        <dt className="text-muted-foreground">Queue</dt>
        <dd className="truncate">
          {q.qdisc}
          {q.diffserv ? ` · ${q.diffserv}` : ''} <span className="text-muted-foreground">({q.script})</span>
        </dd>
        <dt className="text-muted-foreground">Sharing</dt>
        <dd className="truncate">
          {q.fairness ? WAN_FAIRNESS_LABEL[q.fairness] : 'Router default'}
          {q.nat ? ' · NAT-aware' : ''}
        </dd>
        <dt className="text-muted-foreground">Line type</dt>
        <dd className="truncate">
          {preset ? preset.label : `${q.linkLayer}${q.overhead !== null ? `, overhead ${q.overhead}` : ''}${q.mpu !== null ? `, MPU ${q.mpu}` : ''}`}
        </dd>
        {q.routerUpdatedAt ? (
          <>
            <dt className="text-muted-foreground">Router edit</dt>
            <dd>{formatWhen(q.routerUpdatedAt)}</dd>
          </>
        ) : null}
      </dl>

      {flags.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-[11px] text-status-warning">
          {flags.map((f) => (
            <li key={f}>{WAN_FLAG_TEXT[f] ?? f}</li>
          ))}
        </ul>
      ) : null}
    </article>
  )
}

function LiveDirection({
  label,
  icon,
  rateKbit,
  stats,
}: {
  label: string
  icon: React.ReactNode
  rateKbit: number
  stats: QosQdiscStats | null
}) {
  const shaped = rateKbit > 0
  const now = stats?.rateKbit ?? null
  const delayMs = stats?.peakDelayUs != null ? stats.peakDelayUs / 1000 : null
  return (
    <div className="min-w-0 space-y-1">
      <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
        {icon} {label}
      </p>
      <p className="text-lg leading-none font-semibold tracking-tight">{shaped ? formatKbit(rateKbit) : 'Unshaped'}</p>
      <RateBar kbit={now} capKbit={shaped ? rateKbit : null} />
      <p className="truncate text-[11px] text-muted-foreground tabular-nums">
        {stats ? (
          <>
            now {formatKbit(now, '—')}
            {delayMs !== null ? ` · delay ${delayMs < 10 ? delayMs.toFixed(1) : Math.round(delayMs)} ms` : ''}
            {` · ${stats.drops.toLocaleString()} drops`}
          </>
        ) : (
          'no live report'
        )}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------

type FormState = {
  device: string
  enabled: boolean
  down: string
  up: string
  qdisc: 'cake' | 'fq_codel'
  diffserv: QosDiffserv
  fairness: QosWanFairness
  nat: boolean
  linkLayer: QosLinkLayer
  overhead: string
  mpu: string
  ingressEcn: boolean
  egressEcn: boolean
}

function initialForm(q: QosWanQueue | null): FormState {
  return {
    device: q?.device ?? '',
    enabled: q?.enabled ?? true,
    down: q ? (q.downloadKbit > 0 ? kbitToInput(q.downloadKbit) : '') : '',
    up: q ? (q.uploadKbit > 0 ? kbitToInput(q.uploadKbit) : '') : '',
    qdisc: q?.qdisc === 'fq_codel' ? 'fq_codel' : 'cake',
    diffserv: q?.diffserv ?? 'besteffort',
    fairness: q?.fairness ?? 'per_host',
    nat: q?.nat ?? true,
    linkLayer: q?.linkLayer ?? 'none',
    overhead: q?.overhead != null ? String(q.overhead) : '',
    mpu: q?.mpu != null ? String(q.mpu) : '',
    ingressEcn: q?.ingressEcn ?? true,
    egressEcn: q?.egressEcn ?? false,
  }
}

function WanQueueDialog({ queue, writes, onClose }: { queue: QosWanQueue | null; writes: QosWrites; onClose: () => void }) {
  const [form, setForm] = useState<FormState>(() => initialForm(queue))
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<QosWarning[]>([])
  const mutation = queue ? writes.updateWanQueue : writes.createWanQueue
  const qdiscEditable = !queue || queue.qdisc === 'cake' || queue.qdisc === 'fq_codel'
  const isCake = form.qdisc === 'cake'
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }))
  const queued = apiErrorCode(mutation.error) === 'plane_unavailable'
  const intended = queued ? (refusalBody(mutation.error)?.intended as { changed?: string[] } | undefined) : undefined

  function build(): QosWanQueueInput | null {
    const down = parseMbitInput(form.down)
    const up = parseMbitInput(form.up)
    if (!down.ok || !up.ok) {
      setError('Rates are in Mbit/s; leave one empty to leave that direction unshaped.')
      return null
    }
    const overhead = form.overhead.trim() === '' ? null : Number(form.overhead)
    const mpu = form.mpu.trim() === '' ? null : Number(form.mpu)
    if ((overhead !== null && !Number.isInteger(overhead)) || (mpu !== null && !Number.isInteger(mpu))) {
      setError('Overhead and MPU are whole numbers of bytes.')
      return null
    }
    const full: QosWanQueueInput = {
      device: form.device.trim(),
      enabled: form.enabled,
      downloadKbit: down.kbit ?? 0,
      uploadKbit: up.kbit ?? 0,
      linkLayer: form.linkLayer,
      overhead: form.linkLayer === 'none' ? null : overhead,
      mpu: form.linkLayer === 'none' ? null : mpu,
    }
    if (qdiscEditable) full.qdisc = form.qdisc
    if (isCake) {
      full.diffserv = form.diffserv
      full.fairness = form.fairness
      full.nat = form.nat
    }
    full.ingressEcn = form.ingressEcn
    full.egressEcn = form.egressEcn
    if (!queue) return full
    // A PATCH names only what changed: the router's other options stay as they are.
    const before = initialForm(queue)
    const patch: QosWanQueueInput = {}
    if (form.enabled !== before.enabled) patch.enabled = form.enabled
    if (form.down !== before.down) patch.downloadKbit = full.downloadKbit
    if (form.up !== before.up) patch.uploadKbit = full.uploadKbit
    if (qdiscEditable && form.qdisc !== before.qdisc) patch.qdisc = form.qdisc
    if (isCake && form.diffserv !== before.diffserv) patch.diffserv = form.diffserv
    if (isCake && form.fairness !== before.fairness) patch.fairness = form.fairness
    if (isCake && form.nat !== before.nat) patch.nat = form.nat
    if (form.linkLayer !== before.linkLayer || form.overhead !== before.overhead || form.mpu !== before.mpu) {
      patch.linkLayer = full.linkLayer
      patch.overhead = full.overhead
      patch.mpu = full.mpu
    }
    if (form.ingressEcn !== before.ingressEcn) patch.ingressEcn = form.ingressEcn
    if (form.egressEcn !== before.egressEcn) patch.egressEcn = form.egressEcn
    return patch
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setWarnings([])
    const body = build()
    if (!body) return
    if (queue && Object.keys(body).length === 0) {
      onClose()
      return
    }
    if (!queue && !body.device) {
      setError('Name the WAN device (for example wan or pppoe-wan).')
      return
    }
    const done = (result: { warnings: QosWarning[] }) => {
      if (result.warnings.length) setWarnings(result.warnings)
      else onClose()
    }
    if (queue) writes.updateWanQueue.mutate({ id: queue.id, patch: body }, { onSuccess: done })
    else writes.createWanQueue.mutate(body, { onSuccess: done })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent wide>
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{queue ? `WAN queue on ${queue.device}` : 'Add a WAN queue'}</DialogTitle>
            <DialogDescription>
              Set the rates a little below what the line really delivers (85–95 %), so the queue sits here and not in
              the modem.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {queue?.origin === 'router' ? (
              <p className="rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs">
                This queue came from the router and Perch keeps it as it is. Only change it on purpose: the edit goes to
                the router's sqm config, and every option Perch does not show here stays untouched.
              </p>
            ) : null}
            {!queue ? (
              <div className="space-y-1.5">
                <Label htmlFor="wan-device" className="text-xs font-medium">
                  WAN device
                </Label>
                <Input
                  id="wan-device"
                  value={form.device}
                  onChange={(e) => set('device', e.target.value)}
                  placeholder="wan"
                  className="rounded-md font-mono"
                />
                <p className="text-xs text-muted-foreground">The Linux device of the line (wan, pppoe-wan, eth1…).</p>
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="wan-down" className="text-xs font-medium">
                  Download (Mbit/s)
                </Label>
                <Input id="wan-down" inputMode="decimal" value={form.down} onChange={(e) => set('down', e.target.value)} placeholder="Unshaped" className="rounded-md" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="wan-up" className="text-xs font-medium">
                  Upload (Mbit/s)
                </Label>
                <Input id="wan-up" inputMode="decimal" value={form.up} onChange={(e) => set('up', e.target.value)} placeholder="Unshaped" className="rounded-md" />
              </div>
            </div>

            <div className="space-y-1.5">
              <p className="text-xs font-medium">Line type (overhead compensation)</p>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Line type preset">
                {LINK_PRESETS.map((p) => {
                  const active =
                    form.linkLayer === p.linkLayer &&
                    form.overhead === (p.overhead !== null ? String(p.overhead) : '') &&
                    form.mpu === (p.mpu !== null ? String(p.mpu) : '')
                  return (
                    <Button
                      key={p.id}
                      type="button"
                      size="xs"
                      role="radio"
                      aria-checked={active}
                      variant={active ? 'secondary' : 'outline'}
                      title={p.hint}
                      onClick={() =>
                        setForm((f) => ({
                          ...f,
                          linkLayer: p.linkLayer,
                          overhead: p.overhead !== null ? String(p.overhead) : '',
                          mpu: p.mpu !== null ? String(p.mpu) : '',
                        }))
                      }
                    >
                      {p.label}
                    </Button>
                  )
                })}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="wan-ll" className="text-[11px] text-muted-foreground">Link layer</Label>
                  <NativeSelect id="wan-ll" value={form.linkLayer} onChange={(e) => set('linkLayer', e.target.value as QosLinkLayer)} className="rounded-md">
                    <option value="none">none</option>
                    <option value="ethernet">ethernet</option>
                    <option value="atm">atm</option>
                  </NativeSelect>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="wan-oh" className="text-[11px] text-muted-foreground">Overhead (bytes)</Label>
                  <Input id="wan-oh" inputMode="numeric" value={form.overhead} disabled={form.linkLayer === 'none'} onChange={(e) => set('overhead', e.target.value)} className="rounded-md" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="wan-mpu" className="text-[11px] text-muted-foreground">MPU (bytes)</Label>
                  <Input id="wan-mpu" inputMode="numeric" value={form.mpu} disabled={form.linkLayer === 'none'} onChange={(e) => set('mpu', e.target.value)} className="rounded-md" />
                </div>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="wan-qdisc" className="text-[11px] text-muted-foreground">Queue</Label>
                {qdiscEditable ? (
                  <NativeSelect id="wan-qdisc" value={form.qdisc} onChange={(e) => set('qdisc', e.target.value as 'cake' | 'fq_codel')} className="rounded-md">
                    <option value="cake">cake</option>
                    <option value="fq_codel">fq_codel</option>
                  </NativeSelect>
                ) : (
                  <p className="py-1.5 text-xs">{queue?.qdisc} (kept; Perch does not edit it)</p>
                )}
              </div>
              <div className="space-y-1">
                <Label htmlFor="wan-fair" className="text-[11px] text-muted-foreground">Sharing</Label>
                <NativeSelect id="wan-fair" value={form.fairness} disabled={!isCake} onChange={(e) => set('fairness', e.target.value as QosWanFairness)} className="rounded-md">
                  <option value="per_host">{WAN_FAIRNESS_LABEL.per_host}</option>
                  <option value="triple_isolate">{WAN_FAIRNESS_LABEL.triple_isolate}</option>
                  <option value="per_flow">{WAN_FAIRNESS_LABEL.per_flow}</option>
                </NativeSelect>
              </div>
              <div className="space-y-1">
                <Label htmlFor="wan-ds" className="text-[11px] text-muted-foreground">Priority classes</Label>
                <NativeSelect id="wan-ds" value={form.diffserv} disabled={!isCake} onChange={(e) => set('diffserv', e.target.value as QosDiffserv)} className="rounded-md">
                  <option value="besteffort">None (besteffort)</option>
                  <option value="diffserv3">3 tiers</option>
                  <option value="diffserv4">4 tiers</option>
                  <option value="diffserv8">8 tiers</option>
                </NativeSelect>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <CheckRow checked={form.enabled} onChange={(v) => set('enabled', v)} label="Queue on" />
              <CheckRow checked={form.nat} disabled={!isCake} onChange={(v) => set('nat', v)} label="NAT-aware" hint="Share per LAN device, not per public address." />
              <CheckRow checked={form.ingressEcn} onChange={(v) => set('ingressEcn', v)} label="ECN on download" />
              <CheckRow checked={form.egressEcn} onChange={(v) => set('egressEcn', v)} label="ECN on upload" />
            </div>

            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            {queued ? (
              <div role="status" className="space-y-1 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs">
                <p className="font-medium">Queued: config plane unavailable</p>
                <p className="text-muted-foreground">
                  WAN queues live in the router's sqm config, which this controller cannot write yet. Nothing was stored
                  or sent; the queue stays as the router has it.
                  {intended?.changed?.length ? ` It would have changed: ${intended.changed.join(', ')}.` : ''}
                </p>
              </div>
            ) : mutation.error ? (
              <RefusalAlert error={mutation.error} />
            ) : null}
            {warnings.length ? (
              <div className="space-y-1 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs">
                <p className="font-medium">Saved, with warnings</p>
                <ul className="list-disc pl-4">
                  {warnings.map((w, i) => (
                    <li key={i}>
                      {w.code === 'qos_rate_far_below_observed'
                        ? `The ${w.field === 'uploadKbit' ? 'upload' : 'download'} rate is under half of what this line carried (${formatKbit(w.observedKbit ?? null)} at the 95th percentile this week).`
                        : (w.message ?? w.code)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {warnings.length ? 'Close' : 'Cancel'}
            </Button>
            {!warnings.length ? (
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? 'Saving…' : queue ? 'Save queue' : 'Add queue'}
              </Button>
            ) : null}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ReenableDialog({ queue, writes, onClose }: { queue: QosWanQueue; writes: QosWrites; onClose: () => void }) {
  const m = writes.updateWanQueue
  const queued = apiErrorCode(m.error) === 'plane_unavailable'
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Turn the queue on {queue.device} back on?</DialogTitle>
          <DialogDescription>The router switched it off{queue.pausedByRouter ? ` (${formatWhen(queue.pausedByRouter.at)})` : ''}.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p>
            A queue switched off on the router is a safety pause: Perch never turns it back on by itself. Someone may
            have switched it off because the line changed or a rate was wrong.
          </p>
          <p>Turn it back on only when you know why it was off.</p>
          {queued ? (
            <p className="rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2">
              Queued: config plane unavailable. The router's sqm config cannot be written from this controller yet, so
              the queue stays off. Switch it on in LuCI instead.
            </p>
          ) : m.error ? (
            <RefusalAlert error={m.error} />
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Leave it off
          </Button>
          <Button
            variant="destructive"
            disabled={m.isPending}
            onClick={() => m.mutate({ id: queue.id, patch: { enabled: true } }, { onSuccess: onClose })}
          >
            Turn it back on
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
