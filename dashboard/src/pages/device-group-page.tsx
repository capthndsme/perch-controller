import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Eye, Key, PencilSimple, Plus, Trash, UsersThree, Warning } from '@phosphor-icons/react'
import { DeviceGroupDialog, GroupBadges } from '@/components/device-groups/device-group-ui'
import { groupSpeedText } from '@/lib/device-groups'
import { PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
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
import { PageSpinner } from '@/components/ui/spinner'
import { ConfirmDialog, ErrorNote, Fact, FormField } from '@/components/portal/portal-ui'
import { useProfile } from '@/hooks/use-auth'
import { useConfirm } from '@/hooks/use-confirm'
import {
  revealDeviceGroupKey,
  useAddDeviceGroupMember,
  useCreateDeviceGroupKey,
  useDeleteDeviceGroup,
  useDeleteDeviceGroupKey,
  useDeviceGroup,
  useDeviceGroupSettings,
  useRemoveDeviceGroupMember,
} from '@/hooks/use-device-groups'
import { useGatewayNetworks } from '@/hooks/use-networks'
import { useQosPolicies } from '@/hooks/use-qos'
import { apiErrorCode } from '@/lib/api'
import { errorDetail, normalizeMac, relativeTime } from '@/lib/portal'
import type { DeviceGroupDetail, DeviceGroupKey, DeviceGroupMember } from '@/types/device-groups'

/** `/groups/:id`: one device group, its members and Wi-Fi keys. */
export function DeviceGroupPage() {
  const params = useParams()
  const id = Number(params.id)
  const group = useDeviceGroup(Number.isInteger(id) && id > 0 ? id : null)
  const isAdmin = useProfile().data?.role === 'admin'
  const networks = useGatewayNetworks(group.data?.gatewayId ?? null)
  const policies = useQosPolicies(group.data?.gatewayId ?? null, Boolean(group.data))
  const [editing, setEditing] = useState(false)
  const remove = useDeleteDeviceGroup()
  const confirmDelete = useConfirm<DeviceGroupDetail>()
  const navigate = useNavigate()

  if (group.isPending) return <PageSpinner label="Loading the group" />
  if (group.error || !group.data) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Device group" crumbs={[{ label: 'Device groups', to: '/groups' }, { label: 'Not found' }]} />
        <ErrorNote error={group.error ?? new Error('Not found')} />
      </div>
    )
  }
  const g = group.data
  const speed = groupSpeedText(g, (pid) => policies.data?.find((p) => p.id === pid)?.name)

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={g.name}
        crumbs={[{ label: 'Device groups', to: '/groups' }, { label: g.name }]}
        description={g.notes ?? undefined}
        actions={
          isAdmin ? (
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={!networks.data}>
                <PencilSimple className="size-3.5" />
                Edit
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-destructive"
                onClick={() => {
                  remove.reset()
                  confirmDelete.open(g)
                }}
              >
                <Trash className="size-3.5" />
                Delete
              </Button>
            </div>
          ) : null
        }
      />
      <div className="flex flex-wrap gap-1.5">
        <GroupBadges group={g} />
      </div>
      <Panel title="Settings">
        <div className="grid gap-3 sm:grid-cols-4">
          <Fact label="Network">{g.network ? `${g.network.label}${g.network.vlanId !== null ? ` · VLAN ${g.network.vlanId}` : ''}` : 'None: members by device'}</Fact>
          <Fact label="Speed limit">
            {speed ?? 'None'}
            {g.qos ? <span className="block text-[11px] text-muted-foreground">{g.qos.via === 'network' ? 'Every device on the network' : 'Each bound device'}</span> : null}
          </Fact>
          <Fact label="Internet">{g.internet ? 'Allowed' : 'Blocked'}</Fact>
          <Fact label="Guest portal">{g.network ? '—' : g.portalBypass ? 'Members pass it' : 'Members sign in'}</Fact>
        </div>
      </Panel>

      <MembersPanel group={g} isAdmin={isAdmin} />
      {g.network ? <OnNetworkPanel group={g} /> : null}
      {g.network ? <KeysPanel group={g} isAdmin={isAdmin} /> : null}

      {editing && networks.data ? (
        <DeviceGroupDialog gatewayId={g.gatewayId} group={g} networks={networks.data} onClose={() => setEditing(false)} />
      ) : null}
      <ConfirmDialog
        {...confirmDelete.props}
        title={`Delete ${g.name}?`}
        description="Its bindings, Wi-Fi keys, speed limit and internet block go. Devices on its network stay there."
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => remove.mutate(g.id, { onSuccess: () => navigate('/groups') })}
      />
    </div>
  )
}

function MembersPanel({ group, isAdmin }: { group: DeviceGroupDetail; isAdmin: boolean }) {
  const add = useAddDeviceGroupMember()
  const remove = useRemoveDeviceGroupMember()
  const [mac, setMac] = useState('')
  const [moveFrom, setMoveFrom] = useState<{ mac: string; groupId: number } | null>(null)
  const normalized = normalizeMac(mac)

  function submit(event: React.FormEvent, move = false) {
    event.preventDefault()
    const target = moveFrom?.mac ?? normalized
    if (!target) return
    add.mutate(
      { id: group.id, mac: target, move },
      {
        onSuccess: () => {
          setMac('')
          setMoveFrom(null)
        },
        onError: (error) => {
          if (apiErrorCode(error) === 'group_mac_taken') {
            setMoveFrom({ mac: target, groupId: errorDetail<number>(error, 'groupId') ?? 0 })
          }
        },
      },
    )
  }

  return (
    <Panel
      flush
      title="Bound devices"
      description={
        group.network
          ? 'Moved into the group’s VLAN on the access points; they keep the SSID’s own passphrase. Portal users of this group bind their devices by signing in.'
          : 'Members by device: the speed limit, internet block and portal bypass apply to them.'
      }
    >
      {isAdmin ? (
        <form onSubmit={(e) => submit(e)} className="flex flex-wrap items-end gap-2 px-4 pb-3">
          <FormField label="Add a device" htmlFor="dg-mac" className="min-w-52 flex-1" hint="Its MAC address.">
            <Input id="dg-mac" value={mac} onChange={(e) => setMac(e.target.value)} placeholder="02:00:00:00:00:01" className="rounded-md font-mono" />
          </FormField>
          <Button type="submit" size="sm" disabled={!normalized || add.isPending}>
            <Plus className="size-3.5" />
            Add
          </Button>
        </form>
      ) : null}
      {moveFrom ? (
        <div className="mx-4 mb-3 flex flex-wrap items-center gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs">
          <Warning className="size-3.5" />
          <span className="flex-1">
            {moveFrom.mac} is in <Link to={`/groups/${moveFrom.groupId}`} className="underline">another group</Link>.
          </span>
          <Button size="xs" variant="outline" onClick={(e) => submit(e as unknown as React.FormEvent, true)}>
            Move it here
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setMoveFrom(null)}>
            Cancel
          </Button>
        </div>
      ) : null}
      {add.error && apiErrorCode(add.error) !== 'group_mac_taken' ? <ErrorNote error={add.error} className="mx-4 mb-3" /> : null}
      {group.members.length === 0 ? (
        <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">No bound devices.</p>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {group.members.map((m: DeviceGroupMember) => (
            <li key={m.mac} className="flex items-center gap-2 px-4 py-2">
              <div className="min-w-0 flex-1">
                <Link to={`/devices/${encodeURIComponent(m.mac)}`} className="font-mono text-xs hover:underline">
                  {m.mac}
                </Link>
                {m.name ? <span className="ml-2 text-xs">{m.name}</span> : null}
                <span className="ml-2 text-[11px] text-muted-foreground">
                  {m.source === 'portal' ? `signed in as ${m.portalUsername ?? 'a portal user'}` : 'added by hand'} · {relativeTime(m.createdAt)}
                </span>
              </div>
              {isAdmin ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${m.mac}`}
                  className="text-muted-foreground hover:text-destructive"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate({ id: group.id, mac: m.mac })}
                >
                  <Trash className="size-3.5" />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function OnNetworkPanel({ group }: { group: DeviceGroupDetail }) {
  return (
    <Panel flush title="On the network" description="Every device the gateway saw on the group’s network this week, whichever key brought it.">
      {group.onNetwork.length === 0 ? (
        <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">None seen yet.</p>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {group.onNetwork.map((d) => (
            <li key={d.mac} className="flex items-center gap-2 px-4 py-2 text-xs">
              <Link to={`/devices/${encodeURIComponent(d.mac)}`} className="font-mono hover:underline">
                {d.mac}
              </Link>
              {d.name ? <span>{d.name}</span> : null}
              <span className="ml-auto text-[11px] text-muted-foreground">{relativeTime(d.lastSeenAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function KeysPanel({ group, isAdmin }: { group: DeviceGroupDetail; isAdmin: boolean }) {
  const settings = useDeviceGroupSettings()
  const [creating, setCreating] = useState(false)
  const [shown, setShown] = useState<Record<number, string>>({})
  const [revealError, setRevealError] = useState<unknown>(null)
  const remove = useDeleteDeviceGroupKey()
  const confirmDelete = useConfirm<DeviceGroupKey>()
  const ssids = settings.data?.settings.ssids ?? []
  const noVlan = group.network?.vlanId === null

  return (
    <Panel
      flush
      title="Wi-Fi keys"
      description={
        ssids.length
          ? `A device that joins ${ssids.join(' or ')} with one of these passphrases lands in the group’s VLAN.`
          : 'Name the shared SSIDs in the Wi-Fi settings first.'
      }
      actions={
        isAdmin ? (
          <Button size="sm" onClick={() => setCreating(true)} disabled={noVlan}>
            <Key className="size-3.5" />
            New key
          </Button>
        ) : null
      }
    >
      {noVlan ? <p className="px-4 pb-3 text-xs text-muted-foreground">The group’s network has no VLAN: keys need one.</p> : null}
      <ErrorNote error={revealError} className="mx-4 mb-3" />
      {group.keys.length === 0 ? (
        <div className="border-t border-border px-4 py-4">
          <EmptyState icon={<UsersThree className="size-6" />} title="No keys" description="Hand a unit its own passphrase: its devices join the shared SSID with it." />
        </div>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {group.keys.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
              <span className="text-sm">{k.label}</span>
              <span className="text-[11px] text-muted-foreground">{relativeTime(k.createdAt)}</span>
              <span className="ml-auto flex items-center gap-1.5">
                {shown[k.id] ? (
                  <>
                    <Badge variant="outline" className="rounded-sm font-mono">
                      {shown[k.id]}
                    </Badge>
                    <CopyButton value={shown[k.id]} />
                  </>
                ) : isAdmin ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      setRevealError(null)
                      revealDeviceGroupKey(group.id, k.id)
                        .then((r) => setShown((s) => ({ ...s, [k.id]: r.passphrase })))
                        .catch(setRevealError)
                    }}
                  >
                    <Eye className="size-3.5" />
                    Show
                  </Button>
                ) : null}
                {isAdmin ? (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete key ${k.label}`}
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => {
                      remove.reset()
                      confirmDelete.open(k)
                    }}
                  >
                    <Trash className="size-3.5" />
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {creating ? <NewKeyDialog groupId={group.id} onClose={() => setCreating(false)} /> : null}
      <ConfirmDialog
        {...confirmDelete.props}
        title={`Delete the key ${confirmDelete.target?.label ?? ''}?`}
        description="Devices joining with it stop landing in the group’s VLAN. Devices already connected stay until they reconnect."
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => {
          if (confirmDelete.target) {
            remove.mutate({ id: group.id, keyId: confirmDelete.target.id }, { onSuccess: () => confirmDelete.close() })
          }
        }}
      />
    </Panel>
  )
}

function NewKeyDialog({ groupId, onClose }: { groupId: number; onClose: () => void }) {
  const create = useCreateDeviceGroupKey()
  const [label, setLabel] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [created, setCreated] = useState<string | null>(null)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            if (created) return onClose()
            create.mutate(
              { id: groupId, label: label.trim(), passphrase: passphrase || null },
              { onSuccess: (r) => setCreated(r.passphrase) },
            )
          }}
        >
          <DialogHeader>
            <DialogTitle>{created ? 'Key created' : 'New Wi-Fi key'}</DialogTitle>
            <DialogDescription>
              {created
                ? 'Hand this passphrase to the tenant. Admins can show it again later.'
                : 'Leave the passphrase empty for a generated one (three groups of four letters and digits).'}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {created ? (
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="rounded-sm px-3 py-1.5 font-mono text-sm">
                  {created}
                </Badge>
                <CopyButton value={created} />
              </div>
            ) : (
              <>
                <FormField label="Label" htmlFor="key-label" hint="Who has it, e.g. “Unit 101 tenant”.">
                  <Input id="key-label" required maxLength={64} value={label} onChange={(e) => setLabel(e.target.value)} className="rounded-md" />
                </FormField>
                <FormField label="Passphrase" htmlFor="key-pass" hint="8-63 characters, or empty to generate.">
                  <Input id="key-pass" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} className="rounded-md font-mono" autoComplete="off" />
                </FormField>
                <ErrorNote error={create.error} />
              </>
            )}
          </DialogBody>
          <DialogFooter>
            {created ? null : (
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
            )}
            <Button type="submit" disabled={create.isPending}>
              {created ? 'Done' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
