import { useState } from 'react'
import { Link } from 'react-router-dom'
import { GearSix, PencilSimple, Plus, UsersThree } from '@phosphor-icons/react'
import { ApStateBadge, DeviceGroupDialog, GroupBadges } from '@/components/device-groups/device-group-ui'
import { groupSpeedText } from '@/lib/device-groups'
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
import { ErrorNote, FormField } from '@/components/portal/portal-ui'
import { useProfile } from '@/hooks/use-auth'
import { useApGroupStates, useDeviceGroups, useDeviceGroupSettings, useSetApTrunk } from '@/hooks/use-device-groups'
import { useGatewayNetworks, useNetworkGateways } from '@/hooks/use-networks'
import { useQosPolicies } from '@/hooks/use-qos'
import { relativeTime } from '@/lib/portal'
import type { ApGroupState } from '@/types/device-groups'
import type { GatewayBrief } from '@/types/networks'

/**
 * `/groups`: device groups per gateway (docs/gateway/device-groups.md): an
 * apartment unit, a family, the IoT gear. Each shares a network, a speed
 * limit, internet access and a portal bypass; the access points carry the
 * groups' Wi-Fi keys and VLANs.
 */
export function DeviceGroupsPage() {
  const gateways = useNetworkGateways()
  const list = gateways.data ?? []
  const isAdmin = useProfile().data?.role === 'admin'

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Device groups"
        description="Units, families, IoT gear: devices that share a network, a speed limit, internet access and Wi-Fi keys."
        actions={
          isAdmin ? (
            <Button asChild size="sm" variant="outline">
              <Link to="/settings/device-groups">
                <GearSix className="size-3.5" />
                Wi-Fi settings
              </Link>
            </Button>
          ) : null
        }
      />
      {gateways.isPending ? (
        <p className="text-sm text-muted-foreground">Loading gateways…</p>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<UsersThree className="size-6" />}
          title="No gateway yet"
          description="Device groups live on a gateway: once the collector on your router connects, its groups show up here."
        />
      ) : (
        list.map((gateway) => <GatewayGroupsPanel key={gateway.id} gateway={gateway} isAdmin={isAdmin} />)
      )}
      <AccessPointsPanel isAdmin={isAdmin} />
    </div>
  )
}

function GatewayGroupsPanel({ gateway, isAdmin }: { gateway: GatewayBrief; isAdmin: boolean }) {
  const groups = useDeviceGroups(gateway.id)
  const networks = useGatewayNetworks(gateway.id)
  const policies = useQosPolicies(gateway.id)
  const [creating, setCreating] = useState(false)
  const policyName = (id: number) => policies.data?.find((p) => p.id === id)?.name

  return (
    <Panel
      flush
      title={gateway.name}
      description={gateway.mode === 'managed' ? undefined : 'Speed limits and internet blocks need the gateway in managed mode.'}
      actions={
        isAdmin ? (
          <Button size="sm" onClick={() => setCreating(true)} disabled={!networks.data}>
            <Plus className="size-3.5" />
            New group
          </Button>
        ) : null
      }
    >
      {groups.error ? <ErrorNote error={groups.error} className="mx-4 mb-4" /> : null}
      {groups.data && groups.data.length === 0 ? (
        <div className="px-4 pb-4">
          <EmptyState
            icon={<UsersThree className="size-6" />}
            title="No groups"
            description="Give each apartment unit its own group and VLAN, or group devices by hand (the kids' tablets, the cameras)."
          />
        </div>
      ) : null}
      {groups.data && groups.data.length > 0 ? (
        <ul className="divide-y divide-border border-t border-border">
          {groups.data.map((group) => {
            const speed = groupSpeedText(group, policyName)
            return (
              <li key={group.id} className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Link to={`/groups/${group.id}`} className="text-sm font-medium hover:underline">
                      {group.name}
                    </Link>
                    <GroupBadges group={group} />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {group.counts.bound} bound
                    {group.network ? ` · ${group.counts.onNetwork} on the network` : ''}
                    {group.network ? ` · ${group.counts.keys} Wi-Fi key${group.counts.keys === 1 ? '' : 's'}` : ''}
                    {speed ? ` · ${speed}` : ''}
                    {group.notes ? ` · ${group.notes}` : ''}
                  </p>
                </div>
                <Button asChild size="sm" variant="outline" className="shrink-0">
                  <Link to={`/groups/${group.id}`}>
                    <PencilSimple className="size-3.5" />
                    Open
                  </Link>
                </Button>
              </li>
            )
          })}
        </ul>
      ) : null}
      {creating && networks.data ? (
        <DeviceGroupDialog gatewayId={gateway.id} group={null} networks={networks.data} onClose={() => setCreating(false)} />
      ) : null}
    </Panel>
  )
}

function AccessPointsPanel({ isAdmin }: { isAdmin: boolean }) {
  const aps = useApGroupStates()
  const settings = useDeviceGroupSettings()
  const [trunkFor, setTrunkFor] = useState<ApGroupState | null>(null)
  const ssids = settings.data?.settings.ssids ?? []
  if (!aps.data || aps.data.length === 0) return null
  return (
    <Panel
      flush
      title="Access points"
      description={
        ssids.length
          ? `Group keys and bindings on ${ssids.join(', ')}. An AP takes part with option wifi_groups '1' in /etc/config/perch-apd.`
          : 'No group SSIDs yet: name them in the Wi-Fi settings.'
      }
    >
      <ul className="divide-y divide-border border-t border-border">
        {aps.data.map((ap) => (
          <li key={ap.apId} className="flex flex-col gap-1.5 px-4 py-2.5 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <Link to={`/wifi/aps/${ap.apId}`} className="text-sm font-medium hover:underline">
                  {ap.name}
                </Link>
                <ApStateBadge ap={ap} />
                {ap.converted ? (
                  <Badge variant="outline" className="rounded-sm" title="Its bridge was converted to VLAN filtering">
                    Bridge converted
                  </Badge>
                ) : null}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {ap.supported
                  ? `Trunk ${ap.trunkOverride ?? ap.trunkPort ?? 'unknown'}${ap.trunkOverride ? ' (set by hand)' : ''} · ${ap.stations.length} client${ap.stations.length === 1 ? '' : 's'} on group VLANs · revision ${ap.appliedRevision ?? '—'} · reported ${relativeTime(ap.reportedAt)}`
                  : 'Device groups are off on this AP (perch-apd option wifi_groups).'}
              </p>
              {ap.error ? <p className="text-[11px] text-destructive">{ap.error}</p> : null}
            </div>
            {isAdmin && ap.supported ? (
              <Button size="sm" variant="outline" className="shrink-0" onClick={() => setTrunkFor(ap)}>
                Trunk port
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {trunkFor ? <TrunkDialog ap={trunkFor} onClose={() => setTrunkFor(null)} /> : null}
    </Panel>
  )
}

function TrunkDialog({ ap, onClose }: { ap: ApGroupState; onClose: () => void }) {
  const setTrunk = useSetApTrunk()
  const [value, setValue] = useState(ap.trunkOverride ?? '')
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            setTrunk.mutate({ apId: ap.apId, trunk: value.trim() || null }, { onSuccess: onClose })
          }}
        >
          <DialogHeader>
            <DialogTitle>Trunk port of {ap.name}</DialogTitle>
            <DialogDescription>
              The port that leads to the gateway: it carries the group VLANs tagged. Empty lets the AP find it
              {ap.trunkPort ? ` (it found ${ap.trunkPort})` : ''}.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <FormField label="Port" htmlFor="ap-trunk" hint="e.g. wan, lan1, eth0">
              <Input id="ap-trunk" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Detect" className="rounded-md font-mono" />
            </FormField>
            <ErrorNote error={setTrunk.error} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={setTrunk.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
