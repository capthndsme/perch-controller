import { useState, type FormEvent } from 'react'
import { PencilSimple, Plus, Trash, UsersThree, X } from '@phosphor-icons/react'
import { RefusalAlert } from '@/components/qos/qos-bits'
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
import { normalizeMacInput, refusalBody } from '@/lib/qos'
import type { QosAssignment, QosGroup, QosPolicy } from '@/types/api'

export type KnownDevice = { mac: string; name: string }

type Props = {
  groups: QosGroup[]
  assignments: QosAssignment[]
  policies: QosPolicy[]
  devices: KnownDevice[]
  canEdit: boolean
  writes: QosWrites
}

/** Groups: a set of devices one assignment caps together (one group per device). */
export function GroupsPanel({ groups, assignments, policies, devices, canEdit, writes }: Props) {
  const [editing, setEditing] = useState<QosGroup | 'new' | null>(null)
  const [deleting, setDeleting] = useState<QosGroup | null>(null)
  const policyName = new Map(policies.map((p) => [p.id, p.name]))
  const close = () => {
    writes.createGroup.reset()
    writes.updateGroup.reset()
    setEditing(null)
  }

  return (
    <Panel
      title="Groups"
      description="Devices that share one assignment, for example the kids' tablets. A device is in at most one group."
      actions={
        canEdit ? (
          <Button size="sm" variant="outline" onClick={() => setEditing('new')}>
            <Plus className="size-3.5" /> New group
          </Button>
        ) : null
      }
    >
      {groups.length === 0 ? (
        <EmptyState icon={<UsersThree className="size-5" />} title="No groups" description="Group devices to cap them together with one assignment." />
      ) : (
        <ul className="grid gap-2 md:grid-cols-2">
          {groups.map((g) => {
            const assignment = assignments.find((a) => a.target.type === 'group' && a.target.groupId === g.id)
            return (
              <li key={g.id} className="rounded-lg border border-border p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold">{g.name}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {g.members.length} device{g.members.length === 1 ? '' : 's'} ·{' '}
                      {assignment ? `policy ${assignment.policyId !== null ? (policyName.get(assignment.policyId) ?? `#${assignment.policyId}`) : 'own rate'}` : 'not assigned'}
                      {g.notes ? ` · ${g.notes}` : ''}
                    </p>
                  </div>
                  {canEdit ? (
                    <div className="flex shrink-0 gap-1">
                      <Button size="xs" variant="ghost" onClick={() => setEditing(g)} aria-label={`Edit ${g.name}`}>
                        <PencilSimple /> Edit
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => setDeleting(g)} aria-label={`Delete ${g.name}`}>
                        <Trash />
                      </Button>
                    </div>
                  ) : null}
                </div>
                {g.members.length ? (
                  <p className="mt-2 flex flex-wrap gap-1">
                    {g.members.map((m) => (
                      <Badge key={m.mac} variant="outline" className="rounded text-[10px]" title={m.mac}>
                        {m.name ?? m.mac}
                      </Badge>
                    ))}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      {editing !== null ? (
        <GroupDialog group={editing === 'new' ? null : editing} groups={groups} devices={devices} writes={writes} onClose={close} />
      ) : null}
      {deleting ? (
        <Dialog open onOpenChange={(open) => !open && setDeleting(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete the group {deleting.name}?</DialogTitle>
              <DialogDescription>Its assignment goes with it; its devices fall back to their own assignment or network default.</DialogDescription>
            </DialogHeader>
            <DialogBody>{writes.deleteGroup.error ? <RefusalAlert error={writes.deleteGroup.error} /> : null}</DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleting(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={writes.deleteGroup.isPending}
                onClick={() => writes.deleteGroup.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
              >
                Delete group
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </Panel>
  )
}

function GroupDialog({
  group,
  groups,
  devices,
  writes,
  onClose,
}: {
  group: QosGroup | null
  groups: QosGroup[]
  devices: KnownDevice[]
  writes: QosWrites
  onClose: () => void
}) {
  const [name, setName] = useState(group?.name ?? '')
  const [notes, setNotes] = useState(group?.notes ?? '')
  const [members, setMembers] = useState<string[]>(group?.members.map((m) => m.mac) ?? [])
  const [adding, setAdding] = useState('')
  const [error, setError] = useState<string | null>(null)
  const mutation = group ? writes.updateGroup : writes.createGroup
  const nameOf = new Map([
    ...devices.map((d) => [d.mac, d.name] as const),
    ...(group?.members ?? []).filter((m) => m.name).map((m) => [m.mac, m.name!] as const),
  ])
  const inOtherGroup = new Map<string, string>()
  for (const g of groups) if (g.id !== group?.id) for (const m of g.members) inOtherGroup.set(m.mac, g.name)
  const macInGroup = apiErrorCode(mutation.error) === 'qos_mac_in_group' ? refusalBody(mutation.error) : null

  function add() {
    const typed = adding.trim()
    const byName = devices.find((d) => d.name.toLowerCase() === typed.toLowerCase())
    const mac = byName?.mac ?? normalizeMacInput(typed)
    if (!mac) {
      setError('Pick a device from the list or type its MAC.')
      return
    }
    setError(null)
    setMembers((list) => (list.includes(mac) ? list : [...list, mac]))
    setAdding('')
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) return setError('Give the group a name.')
    if (group) {
      const before = new Set(group.members.map((m) => m.mac))
      const after = new Set(members)
      writes.updateGroup.mutate(
        {
          id: group.id,
          patch: {
            name: name.trim(),
            notes: notes.trim() || null,
            removeMacs: [...before].filter((m) => !after.has(m)),
            addMacs: [...after].filter((m) => !before.has(m)),
          },
        },
        { onSuccess: onClose },
      )
    } else {
      writes.createGroup.mutate({ name: name.trim(), notes: notes.trim() || null, members }, { onSuccess: onClose })
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{group ? `Group ${group.name}` : 'New group'}</DialogTitle>
            <DialogDescription>Cap the group with an assignment once it exists.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="space-y-1">
              <Label htmlFor="grp-name" className="text-xs font-medium">Name</Label>
              <Input id="grp-name" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} className="rounded-md" placeholder="Kids" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="grp-notes" className="text-xs font-medium">Notes</Label>
              <Input id="grp-notes" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} className="rounded-md" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="grp-add" className="text-xs font-medium">Devices</Label>
              <div className="flex gap-2">
                <Input
                  id="grp-add"
                  list="grp-devices"
                  value={adding}
                  onChange={(e) => setAdding(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      add()
                    }
                  }}
                  placeholder="Device name or MAC"
                  className="rounded-md"
                />
                <datalist id="grp-devices">
                  {devices.map((d) => (
                    <option key={d.mac} value={d.name}>
                      {d.mac}
                    </option>
                  ))}
                </datalist>
                <Button type="button" variant="outline" onClick={add}>
                  Add
                </Button>
              </div>
              {members.length ? (
                <ul className="flex flex-wrap gap-1">
                  {members.map((mac) => (
                    <li key={mac}>
                      <Badge variant={inOtherGroup.has(mac) ? 'destructive' : 'outline'} className="h-6 rounded pr-0.5" title={inOtherGroup.has(mac) ? `Already in ${inOtherGroup.get(mac)}` : mac}>
                        {nameOf.get(mac) ?? mac}
                        <button type="button" className="rounded p-0.5 hover:bg-muted" aria-label={`Remove ${nameOf.get(mac) ?? mac}`} onClick={() => setMembers((l) => l.filter((m) => m !== mac))}>
                          <X className="size-3" />
                        </button>
                      </Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">No devices yet.</p>
              )}
              {[...inOtherGroup.keys()].some((m) => members.includes(m)) ? (
                <p className="text-xs text-destructive">A device in red is in another group already; remove it there first.</p>
              ) : null}
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            {macInGroup ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive">
                {String(macInGroup.mac ?? 'A device')} is already in {groups.find((g) => g.id === macInGroup.groupId)?.name ?? 'another group'}.
              </p>
            ) : mutation.error ? (
              <RefusalAlert error={mutation.error} />
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : group ? 'Save group' : 'Create group'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
