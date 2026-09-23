import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Panel } from '@/components/ui/panel'
import { ErrorNote } from '@/components/portal/portal-ui'
import { GroupBadges } from '@/components/device-groups/device-group-ui'
import { useProfile } from '@/hooks/use-auth'
import {
  useAddDeviceGroupMember,
  useDeviceGroupOf,
  useDeviceGroups,
  useRemoveDeviceGroupMember,
} from '@/hooks/use-device-groups'
import { selectClassName } from '@/lib/portal'

/**
 * "Device group" on the device page (docs/gateway/device-groups.md): the
 * group the device is bound to, or whose network it is on; admins bind it
 * to a group or take it out. Hidden while no gateway has groups.
 */
export function DeviceGroupCard({ mac }: { mac: string }) {
  const isAdmin = useProfile().data?.role === 'admin'
  const of = useDeviceGroupOf(mac)
  const groups = useDeviceGroups(null)
  const add = useAddDeviceGroupMember()
  const remove = useRemoveDeviceGroupMember()
  const [target, setTarget] = useState('')

  if (!mac || of.isPending || groups.isPending) return null
  const list = groups.data ?? []
  const current = of.data
  if (!current && list.length === 0) return null

  return (
    <Panel
      title="Device group"
      description={
        current
          ? current.via === 'bound'
            ? 'Bound to this group: its network, speed limit and internet access apply.'
            : 'On this group’s network (by its Wi-Fi key or a binding elsewhere).'
          : 'In no group.'
      }
    >
      {current ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Link to={`/groups/${current.group.id}`} className="text-sm font-medium hover:underline">
            {current.group.name}
          </Link>
          <GroupBadges group={current.group} />
          {isAdmin && current.via === 'bound' ? (
            <Button
              size="xs"
              variant="outline"
              className="ml-auto"
              disabled={remove.isPending}
              onClick={() => remove.mutate({ id: current.group.id, mac })}
            >
              Take out
            </Button>
          ) : null}
        </div>
      ) : null}
      {isAdmin && list.length > 0 && current?.via !== 'bound' ? (
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (target) add.mutate({ id: Number(target), mac, move: true }, { onSuccess: () => setTarget('') })
          }}
        >
          <select aria-label="Group" value={target} onChange={(e) => setTarget(e.target.value)} className={selectClassName}>
            <option value="">Bind to a group…</option>
            {list.map((g) => (
              <option key={g.id} value={String(g.id)}>
                {g.name}
              </option>
            ))}
          </select>
          <Button type="submit" size="sm" disabled={!target || add.isPending}>
            Bind
          </Button>
        </form>
      ) : null}
      <ErrorNote error={add.error ?? remove.error} className="mt-2" />
    </Panel>
  )
}
