import { useState } from 'react'
import { Key, PencilSimple, Plus, Trash, UserCircle } from '@phosphor-icons/react'
import { PageHeader } from '@/components/layout/page-header'
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
import { PageSpinner } from '@/components/ui/spinner'
import {
  AdminOnlyNotice,
  Checkbox,
  ConfirmDialog,
  DurationInput,
  ErrorNote,
  FormField,
  PortalSectionNav,
} from '@/components/portal/portal-ui'
import { useConfirm } from '@/hooks/use-confirm'
import { useDeviceGroups } from '@/hooks/use-device-groups'
import {
  useCreatePortalUser,
  useDeletePortalUser,
  useIsPortalAdmin,
  usePortals,
  usePortalUsers,
  useSetPortalUserPassword,
  useUpdatePortalUser,
} from '@/hooks/use-portal'
import {
  formatMinutes,
  kbpsToMbpsText,
  mbpsToKbps,
  rateLabel,
  relativeTime,
  selectClassName,
  splitMinutes,
  toMinutes,
  vineFieldErrors,
  type DurationUnit,
} from '@/lib/portal'
import type { Portal, PortalUser, PortalUserPayload } from '@/types/api'

/** `/portal/users`: username + password logins for guests (not controller users). */
export function PortalUsersPage() {
  const { isAdmin, isPending } = useIsPortalAdmin()
  const users = usePortalUsers({ enabled: isAdmin })
  const portals = usePortals({ enabled: isAdmin })
  const [editing, setEditing] = useState<PortalUser | 'new' | null>(null)
  const [passwordFor, setPasswordFor] = useState<PortalUser | null>(null)
  const remove = useDeletePortalUser()
  const confirmDelete = useConfirm<PortalUser>()

  if (isPending) return <PageSpinner label="Loading portal users" />

  return (
    <div className="flex w-full flex-col gap-5">
      <PageHeader
        title="Portal users"
        crumbs={[{ label: 'Guest portal', to: '/portal' }, { label: 'Portal users' }]}
        description="Sign-in names for guests who come back: staff, residents, members. Separate from Perch’s own accounts."
        actions={
          isAdmin ? (
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus className="size-3.5" />
              New portal user
            </Button>
          ) : null
        }
      />
      <PortalSectionNav />
      {!isAdmin ? (
        <AdminOnlyNotice what="portal users" />
      ) : (
        <Panel title="Accounts" flush>
          {users.isPending ? <p className="px-4 pb-4 text-xs text-muted-foreground">Loading…</p> : null}
          {users.error ? <ErrorNote error={users.error} className="mx-4 mb-4" /> : null}
          {users.data && users.data.length === 0 ? (
            <div className="px-4 pb-4">
              <EmptyState
                icon={<UserCircle className="size-6" />}
                title="No portal users"
                description="Portals that offer “Username and password” sign in with these accounts."
              />
            </div>
          ) : null}
          {users.data && users.data.length > 0 ? (
            <ul className="divide-y divide-border border-t border-border">
              {users.data.map((user) => (
                <li key={user.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-sm font-medium">{user.username}</span>
                      {user.displayName ? <span className="text-xs text-muted-foreground">{user.displayName}</span> : null}
                      {!user.enabled ? (
                        <Badge variant="outline" className="rounded-sm text-muted-foreground">
                          Disabled
                        </Badge>
                      ) : null}
                      {user.activeDevices > 0 ? (
                        <Badge variant="outline" className="rounded-sm border-status-good/30 bg-status-good/10 text-status-good">
                          {user.activeDevices} online
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {userLimits(user, portals.data ?? [])} · last sign-in {relativeTime(user.lastLoginAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <Button size="sm" variant="outline" onClick={() => setEditing(user)}>
                      <PencilSimple className="size-3.5" />
                      Edit
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setPasswordFor(user)}>
                      <Key className="size-3.5" />
                      Password
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={`Delete ${user.username}`}
                      onClick={() => {
                        remove.reset()
                        confirmDelete.open(user)
                      }}
                    >
                      <Trash className="size-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>
      )}

      {editing ? (
        <PortalUserDialog user={editing === 'new' ? null : editing} portals={portals.data ?? []} onClose={() => setEditing(null)} />
      ) : null}
      {passwordFor ? <PasswordDialog user={passwordFor} onClose={() => setPasswordFor(null)} /> : null}
      <ConfirmDialog
        {...confirmDelete.props}
        title={`Delete ${confirmDelete.target?.username ?? ''}?`}
        description="The account goes, and its devices go offline now."
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => {
          if (confirmDelete.target) remove.mutate(confirmDelete.target.id, { onSuccess: () => confirmDelete.close() })
        }}
      />
    </div>
  )
}

function userLimits(user: PortalUser, portals: Portal[]): string {
  const parts = [`${user.maxDevices} device${user.maxDevices === 1 ? '' : 's'}`]
  parts.push(user.sessionMinutes ? `${formatMinutes(user.sessionMinutes)} per sign-in` : 'no time limit')
  const rates = rateLabel(user.downKbps, user.upKbps)
  if (rates) parts.push(rates)
  if (user.portalIds === null) parts.push('every portal')
  else parts.push(user.portalIds.map((id) => portals.find((p) => p.id === id)?.name ?? `portal ${id}`).join(', ') || 'no portal')
  return parts.join(' · ')
}

function PortalUserDialog({ user, portals, onClose }: { user: PortalUser | null; portals: Portal[]; onClose: () => void }) {
  const create = useCreatePortalUser()
  const update = useUpdatePortalUser()
  const mutation = user ? update : create
  const [username, setUsername] = useState(user?.username ?? '')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState(user?.displayName ?? '')
  const [enabled, setEnabled] = useState(user?.enabled ?? true)
  const [maxDevices, setMaxDevices] = useState(String(user?.maxDevices ?? 2))
  const [session, setSession] = useState<{ amount: string; unit: DurationUnit }>(splitMinutes(user?.sessionMinutes ?? null))
  const [down, setDown] = useState(kbpsToMbpsText(user?.downKbps ?? null))
  const [up, setUp] = useState(kbpsToMbpsText(user?.upKbps ?? null))
  const [everyPortal, setEveryPortal] = useState(user ? user.portalIds === null : true)
  const [portalIds, setPortalIds] = useState<number[]>(user?.portalIds ?? [])
  const groups = useDeviceGroups(null)
  const [deviceGroupId, setDeviceGroupId] = useState(user?.deviceGroupId ? String(user.deviceGroupId) : '')
  const fieldErrors = vineFieldErrors(mutation.error)

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const payload: PortalUserPayload = {
      username: username.trim().toLowerCase(),
      displayName: displayName.trim() || null,
      enabled,
      maxDevices: Number(maxDevices),
      sessionMinutes: toMinutes(session.amount, session.unit) ?? null,
      downKbps: mbpsToKbps(down) ?? null,
      upKbps: mbpsToKbps(up) ?? null,
      portalIds: everyPortal ? null : portalIds,
      deviceGroupId: deviceGroupId ? Number(deviceGroupId) : null,
    }
    if (user) update.mutate({ id: user.id, ...payload }, { onSuccess: onClose })
    else create.mutate({ ...payload, password }, { onSuccess: onClose })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>{user ? `Edit ${user.username}` : 'New portal user'}</DialogTitle>
            <DialogDescription>
              {user
                ? 'Changed limits reach devices already online. Disabling ends their access.'
                : 'A guest signs in with this name and password on portals that offer it.'}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Username" htmlFor="pu-username" error={fieldErrors.username} hint="3–32 of a-z, 0-9, “.”, “_”, “-”.">
                <Input id="pu-username" required autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} className="rounded-md font-mono" />
              </FormField>
              {!user ? (
                <FormField label="Password" htmlFor="pu-password" error={fieldErrors.password} hint="8–64 characters.">
                  <Input id="pu-password" type="password" required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="rounded-md" />
                </FormField>
              ) : null}
              <FormField label="Display name" htmlFor="pu-display" error={fieldErrors.displayName}>
                <Input id="pu-display" placeholder="Optional" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="rounded-md" />
              </FormField>
              <FormField label="Devices at once" htmlFor="pu-devices" error={fieldErrors.maxDevices} hint="1–10.">
                <Input id="pu-devices" inputMode="numeric" value={maxDevices} onChange={(e) => setMaxDevices(e.target.value)} className="rounded-md" />
              </FormField>
              <FormField label="Time per sign-in" htmlFor="pu-session" error={fieldErrors.sessionMinutes}>
                <DurationInput id="pu-session" {...session} onChange={setSession} />
              </FormField>
              <FormField label="Download (Mbps)" htmlFor="pu-down" error={fieldErrors.downKbps}>
                <Input id="pu-down" inputMode="decimal" placeholder="No limit" value={down} onChange={(e) => setDown(e.target.value)} className="rounded-md" />
              </FormField>
              <FormField label="Upload (Mbps)" htmlFor="pu-up" error={fieldErrors.upKbps}>
                <Input id="pu-up" inputMode="decimal" placeholder="No limit" value={up} onChange={(e) => setUp(e.target.value)} className="rounded-md" />
              </FormField>
              <FormField
                label="Device group"
                htmlFor="pu-group"
                error={fieldErrors.deviceGroupId}
                hint="Signing in binds the device to it; a group with its own network moves the device there."
              >
                <select id="pu-group" value={deviceGroupId} onChange={(e) => setDeviceGroupId(e.target.value)} className={selectClassName}>
                  <option value="">None</option>
                  {(groups.data ?? []).map((g) => (
                    <option key={g.id} value={String(g.id)}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>
            <Checkbox id="pu-enabled" checked={enabled} onChange={setEnabled} label="Enabled" />
            <fieldset className="space-y-2">
              <legend className="mb-1.5 text-xs font-medium">Portals</legend>
              <Checkbox id="pu-every" checked={everyPortal} onChange={setEveryPortal} label="Every portal" />
              {!everyPortal
                ? portals.map((portal) => (
                    <Checkbox
                      key={portal.id}
                      id={`pu-portal-${portal.id}`}
                      checked={portalIds.includes(portal.id)}
                      onChange={(on) => setPortalIds((ids) => (on ? [...ids, portal.id] : ids.filter((i) => i !== portal.id)))}
                      label={portal.name}
                    />
                  ))
                : null}
              {fieldErrors.portalIds ? <p className="text-xs text-destructive">{fieldErrors.portalIds}</p> : null}
            </fieldset>
            <ErrorNote error={mutation.error && Object.keys(fieldErrors).length === 0 ? mutation.error : null} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : user ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function PasswordDialog({ user, onClose }: { user: PortalUser; onClose: () => void }) {
  const setPassword = useSetPortalUserPassword()
  const [password, setValue] = useState('')
  const fieldErrors = vineFieldErrors(setPassword.error)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            setPassword.mutate({ id: user.id, password }, { onSuccess: onClose })
          }}
        >
          <DialogHeader>
            <DialogTitle>New password for {user.username}</DialogTitle>
            <DialogDescription>Devices already online stay online.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <FormField label="Password" htmlFor="pu-new-password" error={fieldErrors.password} hint="8–64 characters.">
              <Input id="pu-new-password" type="password" required autoComplete="new-password" value={password} onChange={(e) => setValue(e.target.value)} className="rounded-md" />
            </FormField>
            <ErrorNote error={setPassword.error && Object.keys(fieldErrors).length === 0 ? setPassword.error : null} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={setPassword.isPending}>
              Set password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
