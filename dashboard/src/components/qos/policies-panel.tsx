import { useMemo, useState, type FormEvent } from 'react'
import { PencilSimple, Plus, Trash, TreeStructure } from '@phosphor-icons/react'
import { CheckRow, IssueList, RateBar, RateFields, RefusalAlert } from '@/components/qos/qos-bits'
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
  buildPolicyTree,
  childExceedsParent,
  depthUnder,
  eachExceedsShared,
  flattenTree,
  formatKbit,
  formatRatePair,
  kbitToInput,
  parentCandidates,
  parseRatePair,
  refusalBody,
  subtreeHeight,
  type PolicyNode,
} from '@/lib/qos'
import { cn } from '@/lib/utils'
import type { QosPlanIssue, QosPolicy, QosPolicyInput, QosRate } from '@/types/api'

type Props = {
  policies: QosPolicy[]
  /** `GET /qos` policies carry `live`; the list endpoint does not. */
  live: Map<number, QosPolicy['live']>
  issues: QosPlanIssue[]
  canEdit: boolean
  maxDepth: number
  writes: QosWrites
}

/**
 * Policies as the bucket tree (docs/gateway/qos.md 3.2, 3.3): each shared
 * bucket with its nested buckets under it, the children's rates against the
 * parent's ceiling, and the problems the server's tree check would refuse.
 */
export function PoliciesPanel({ policies, live, issues, canEdit, maxDepth, writes }: Props) {
  const tree = useMemo(() => flattenTree(buildPolicyTree(policies)), [policies])
  const [editing, setEditing] = useState<{ policy: QosPolicy | null; parentId: number | null } | null>(null)
  const [deleting, setDeleting] = useState<QosPolicy | null>(null)
  const close = () => {
    writes.createPolicy.reset()
    writes.updatePolicy.reset()
    setEditing(null)
  }

  return (
    <Panel
      title="Policies and buckets"
      description="A policy is a shared bucket, a cap per device, or both (a ceiling with caps inside). Buckets nest up to four deep."
      actions={
        canEdit ? (
          <Button size="sm" variant="outline" onClick={() => setEditing({ policy: null, parentId: null })}>
            <Plus className="size-3.5" /> New policy
          </Button>
        ) : null
      }
      flush
    >
      {tree.length === 0 ? (
        <div className="px-4 pb-4">
          <EmptyState
            icon={<TreeStructure className="size-5" />}
            title="No policies"
            description="No device, group or network is capped: everything shares the WAN queue fairly. That is the default, and the right one for a home network."
          />
        </div>
      ) : (
        <ul className="divide-y divide-border/70 border-t border-border/70" role="tree" aria-label="Bucket tree">
          {tree.map((node) => (
            <PolicyRow
              key={node.policy.id}
              node={node}
              live={live.get(node.policy.id) ?? null}
              issues={issues.filter((i) => i.policyId === node.policy.id)}
              canEdit={canEdit}
              canNest={canEdit && node.policy.shared !== null && node.depth + 2 <= maxDepth}
              onEdit={() => setEditing({ policy: node.policy, parentId: node.policy.parentPolicyId })}
              onAddChild={() => setEditing({ policy: null, parentId: node.policy.id })}
              onDelete={() => setDeleting(node.policy)}
            />
          ))}
        </ul>
      )}
      {editing ? (
        <PolicyDialog
          policy={editing.policy}
          initialParentId={editing.parentId}
          policies={policies}
          maxDepth={maxDepth}
          writes={writes}
          onClose={close}
        />
      ) : null}
      {deleting ? (
        <DeletePolicyDialog
          policy={deleting}
          writes={writes}
          onClose={() => {
            writes.deletePolicy.reset()
            setDeleting(null)
          }}
        />
      ) : null}
    </Panel>
  )
}

function PolicyRow({
  node,
  live,
  issues,
  canEdit,
  canNest,
  onEdit,
  onAddChild,
  onDelete,
}: {
  node: PolicyNode
  live: QosPolicy['live']
  issues: QosPlanIssue[]
  canEdit: boolean
  canNest: boolean
  onEdit: () => void
  onAddChild: () => void
  onDelete: () => void
}) {
  const p = node.policy
  const where = [
    p.counts.devices ? `${p.counts.devices} device${p.counts.devices === 1 ? '' : 's'}` : null,
    p.counts.groups ? `${p.counts.groups} group${p.counts.groups === 1 ? '' : 's'}` : null,
    p.counts.networks.length ? `network ${p.counts.networks.join(', ')}` : null,
  ].filter(Boolean)
  const shared = p.shared
  const hasChildren = node.children.length > 0
  const problems: QosPlanIssue[] = [
    ...node.problems.map((x) => ({ severity: x.severity, code: x.code, message: x.message })),
    ...issues.filter((i) => !node.problems.some((x) => x.code === i.code)),
  ]
  return (
    <li role="treeitem" aria-level={node.depth + 1} aria-expanded={hasChildren ? true : undefined} className={cn('px-4 py-3', !p.enabled && 'opacity-60')}>
      <div className="flex gap-2" style={{ paddingLeft: `${node.depth * 1.25}rem` }}>
        {node.depth > 0 ? <span aria-hidden className="mt-1 h-3 w-3 shrink-0 rounded-bl border-b border-l border-border" /> : null}
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold">
                {p.name}
                {!p.enabled ? <Badge variant="outline" className="rounded text-[10px]">Off</Badge> : null}
                {p.source === 'portal' ? <Badge variant="secondary" className="rounded text-[10px]">Portal</Badge> : null}
                {p.includeLan ? (
                  <Badge variant="outline" className="rounded text-[10px]" title="Also shapes traffic between LAN devices (decision 13)">
                    + LAN↔LAN
                  </Badge>
                ) : null}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {where.length ? `Applies to ${where.join(' · ')}` : 'Not assigned yet'}
                {p.notes ? ` · ${p.notes}` : ''}
              </p>
            </div>
            {canEdit ? (
              <div className="flex shrink-0 flex-wrap gap-1">
                {canNest ? (
                  <Button size="xs" variant="ghost" onClick={onAddChild} title="Add a bucket inside this one">
                    <Plus /> Nested
                  </Button>
                ) : null}
                <Button size="xs" variant="ghost" onClick={onEdit} aria-label={`Edit ${p.name}`}>
                  <PencilSimple /> Edit
                </Button>
                <Button size="xs" variant="ghost" onClick={onDelete} aria-label={`Delete ${p.name}`}>
                  <Trash />
                </Button>
              </div>
            ) : null}
          </div>

          <div className="grid gap-2 text-[12px] sm:grid-cols-3">
            <div className="min-w-0">
              <p className="section-label">Shared bucket</p>
              <p className="truncate">{shared ? formatRatePair(shared) : '—'}</p>
              {shared && live ? (
                <div className="mt-1 space-y-0.5">
                  <RateBar kbit={live.downloadKbit} capKbit={shared.downloadKbit} />
                  <p className="text-[11px] text-muted-foreground tabular-nums">
                    now ↓ {formatKbit(live.downloadKbit, '—')} ↑ {formatKbit(live.uploadKbit, '—')} · {live.activeMembers} active
                  </p>
                </div>
              ) : null}
            </div>
            <div className="min-w-0">
              <p className="section-label">Each device</p>
              <p className="truncate">{p.each ? formatRatePair(p.each) : '—'}</p>
            </div>
            <div className="min-w-0">
              <p className="section-label">Nested buckets</p>
              {hasChildren && shared ? (
                <p
                  className={cn('truncate tabular-nums', node.problems.some((x) => x.code === 'qos_children_exceed_parent') && 'text-status-critical')}
                  title="Sum of the enabled nested buckets against this bucket's ceiling"
                >
                  ↓ {formatKbit(node.childSum.down)} of {formatKbit(shared.downloadKbit, '∞')} · ↑ {formatKbit(node.childSum.up)} of{' '}
                  {formatKbit(shared.uploadKbit, '∞')}
                </p>
              ) : (
                <p className="text-muted-foreground">{hasChildren ? `${node.children.length}` : 'none'}</p>
              )}
            </div>
          </div>
          {problems.length ? <IssueList issues={problems} /> : null}
        </div>
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------------

function rateInputs(rate: QosRate | null) {
  return { down: kbitToInput(rate?.downloadKbit), up: kbitToInput(rate?.uploadKbit) }
}

function PolicyDialog({
  policy,
  initialParentId,
  policies,
  maxDepth,
  writes,
  onClose,
}: {
  policy: QosPolicy | null
  initialParentId: number | null
  policies: QosPolicy[]
  maxDepth: number
  writes: QosWrites
  onClose: () => void
}) {
  const [name, setName] = useState(policy?.name ?? '')
  const [notes, setNotes] = useState(policy?.notes ?? '')
  const [hasShared, setHasShared] = useState(policy ? policy.shared !== null : true)
  const [shared, setShared] = useState(() => rateInputs(policy?.shared ?? null))
  const [hasEach, setHasEach] = useState(policy ? policy.each !== null : false)
  const [each, setEach] = useState(() => rateInputs(policy?.each ?? null))
  const [fairness, setFairness] = useState(policy?.fairness ?? 'per_host')
  const [includeLan, setIncludeLan] = useState(policy?.includeLan ?? false)
  const [enabled, setEnabled] = useState(policy?.enabled ?? true)
  const [parentId, setParentId] = useState<number | null>(initialParentId)
  const [formError, setFormError] = useState<string | null>(null)
  const mutation = policy ? writes.updatePolicy : writes.createPolicy

  const candidates = parentCandidates(policies, policy?.id ?? null).filter(
    (c) => depthUnder(c.id, policies) + (policy ? subtreeHeight(policy.id, policies) : 0) <= maxDepth,
  )
  const parent = parentId !== null ? (policies.find((p) => p.id === parentId) ?? null) : null

  // Live checks, the same the server runs (it stays the authority).
  const sharedParsed = parseRatePair(shared.down, shared.up)
  const eachParsed = parseRatePair(each.down, each.up)
  const sharedRate = hasShared && sharedParsed.ok ? sharedParsed.rate : null
  const eachRate = hasEach && eachParsed.ok ? eachParsed.rate : null
  const preview: string[] = []
  const eachProblem = eachExceedsShared(sharedRate, eachRate)
  if (eachProblem) preview.push(eachProblem)
  if (parent) {
    if (!hasShared) preview.push('Only a policy with a shared bucket can nest inside another.')
    const over = childExceedsParent(sharedRate, parent.shared)
    if (over) preview.push(over)
    const siblings = policies.filter((p) => p.parentPolicyId === parent.id && p.id !== policy?.id && p.enabled)
    const sum = (dir: 'downloadKbit' | 'uploadKbit') =>
      siblings.reduce((s, p) => s + (p.shared?.[dir] ?? 0), 0) + (enabled ? (sharedRate?.[dir] ?? 0) : 0)
    const pd = parent.shared?.downloadKbit ?? null
    const pu = parent.shared?.uploadKbit ?? null
    if (pd !== null && sum('downloadKbit') > pd) {
      preview.push(`With this one the nested buckets add up to ${formatKbit(sum('downloadKbit'))} down, more than the ${formatKbit(pd)} of ${parent.name}.`)
    }
    if (pu !== null && sum('uploadKbit') > pu) {
      preview.push(`With this one the nested buckets add up to ${formatKbit(sum('uploadKbit'))} up, more than the ${formatKbit(pu)} of ${parent.name}.`)
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    setFormError(null)
    if (!name.trim()) return setFormError('Give the policy a name.')
    if (hasShared && !sharedParsed.ok) return setFormError(sharedParsed.message)
    if (hasEach && !eachParsed.ok) return setFormError(eachParsed.message)
    if (!hasShared && !hasEach) return setFormError('Pick a shared bucket, a per-device cap, or both.')
    const body: QosPolicyInput = {
      name: name.trim(),
      notes: notes.trim() || null,
      shared: sharedRate,
      each: eachRate,
      fairness,
      includeLan,
      parentPolicyId: parentId,
      enabled,
    }
    if (policy) writes.updatePolicy.mutate({ id: policy.id, patch: body }, { onSuccess: onClose })
    else writes.createPolicy.mutate(body, { onSuccess: onClose })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent wide>
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{policy ? `Policy ${policy.name}` : parent ? `New bucket inside ${parent.name}` : 'New policy'}</DialogTitle>
            <DialogDescription>Rates in Mbit/s; an empty direction is unlimited.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {policy?.source === 'portal' ? (
              <p className="rounded-md border border-border bg-muted/30 px-3 py-2">
                The captive portal manages this tier: it rewrites it when its tier changes.
              </p>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="pol-name" className="text-xs font-medium">Name</Label>
                <Input id="pol-name" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} className="rounded-md" placeholder="Guests" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pol-parent" className="text-xs font-medium">Inside bucket</Label>
                <NativeSelect
                  id="pol-parent"
                  className="rounded-md"
                  value={parentId ?? ''}
                  onChange={(e) => setParentId(e.target.value === '' ? null : Number(e.target.value))}
                >
                  <option value="">Top level (under the line)</option>
                  {candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({formatRatePair(c.shared)})
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>

            <div className="space-y-2 rounded-md border border-border p-3">
              <CheckRow
                checked={hasShared}
                onChange={setHasShared}
                label="Shared bucket"
                hint="Everything assigned to this policy shares these rates, split fairly."
              />
              {hasShared ? (
                <RateFields
                  idPrefix="pol-shared"
                  label="Bucket rates"
                  down={shared.down}
                  up={shared.up}
                  onDown={(v) => setShared((s) => ({ ...s, down: v }))}
                  onUp={(v) => setShared((s) => ({ ...s, up: v }))}
                />
              ) : null}
            </div>
            <div className="space-y-2 rounded-md border border-border p-3">
              <CheckRow checked={hasEach} onChange={setHasEach} label="Cap per device" hint="Each device on its own gets at most this." />
              {hasEach ? (
                <RateFields
                  idPrefix="pol-each"
                  label="Per-device cap"
                  down={each.down}
                  up={each.up}
                  onDown={(v) => setEach((s) => ({ ...s, down: v }))}
                  onUp={(v) => setEach((s) => ({ ...s, up: v }))}
                />
              ) : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="pol-fair" className="text-xs font-medium">Inside the bucket</Label>
                <NativeSelect id="pol-fair" className="rounded-md" value={fairness} onChange={(e) => setFairness(e.target.value as QosPolicy['fairness'])}>
                  <option value="per_host">Fair per device</option>
                  <option value="per_flow">Fair per connection</option>
                </NativeSelect>
              </div>
              <div className="space-y-2 pt-1">
                <CheckRow checked={enabled} onChange={setEnabled} label="Policy on" hint="Off: its devices fall back to their group or network default." />
              </div>
            </div>
            <CheckRow
              checked={includeLan}
              onChange={setIncludeLan}
              label="Also cap traffic between LAN devices"
              hint="Off (the default): only internet traffic counts. On: copies to a NAS or a printer on another network are capped too."
            />
            <div className="space-y-1">
              <Label htmlFor="pol-notes" className="text-xs font-medium">Notes</Label>
              <Input id="pol-notes" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} className="rounded-md" />
            </div>

            {preview.length ? (
              <IssueList issues={preview.map((message) => ({ severity: 'error' as const, code: 'check', message }))} />
            ) : null}
            {formError ? <p className="text-xs text-destructive">{formError}</p> : null}
            {mutation.error ? <RefusalAlert error={mutation.error} /> : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : policy ? 'Save policy' : 'Create policy'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DeletePolicyDialog({ policy, writes, onClose }: { policy: QosPolicy; writes: QosWrites; onClose: () => void }) {
  const m = writes.deletePolicy
  const inUse = apiErrorCode(m.error) === 'qos_policy_in_use' ? refusalBody(m.error) : null
  const list = (key: string) => (Array.isArray(inUse?.[key]) ? (inUse![key] as number[]) : [])
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {policy.name}?</DialogTitle>
          <DialogDescription>Its devices fall back to their group or network default.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {inUse ? (
            <div className="space-y-1 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive">
              <p>Still in use, so it stays:</p>
              <ul className="list-disc pl-4">
                {list('assignmentIds').length ? <li>assignments #{list('assignmentIds').join(', #')}</li> : null}
                {list('childPolicyIds').length ? <li>nested buckets #{list('childPolicyIds').join(', #')}</li> : null}
                {list('scheduleIds').length ? <li>schedules #{list('scheduleIds').join(', #')} move devices into it</li> : null}
              </ul>
            </div>
          ) : m.error ? (
            <RefusalAlert error={m.error} />
          ) : (
            <p>Its assignments, nested buckets and schedules must go first; Perch refuses otherwise.</p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={m.isPending || inUse !== null} onClick={() => m.mutate(policy.id, { onSuccess: onClose })}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
