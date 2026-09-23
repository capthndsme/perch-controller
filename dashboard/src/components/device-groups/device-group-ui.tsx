import { useState } from 'react'
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
import { Input } from '@/components/ui/input'
import { Checkbox, ErrorNote, FormField } from '@/components/portal/portal-ui'
import { useCreateDeviceGroup, useUpdateDeviceGroup } from '@/hooks/use-device-groups'
import { useQosPolicies } from '@/hooks/use-qos'
import { kbpsToMbpsText, mbpsToKbps, selectClassName, vineFieldErrors } from '@/lib/portal'
import type { ApGroupState, DeviceGroup, DeviceGroupPayload } from '@/types/device-groups'
import type { GatewayNetwork } from '@/types/networks'

export function GroupBadges({ group }: { group: DeviceGroup }) {
  return (
    <>
      {group.network ? (
        <Badge variant="outline" className="rounded-sm">
          {group.network.label}
          {group.network.vlanId !== null ? ` · VLAN ${group.network.vlanId}` : ''}
        </Badge>
      ) : null}
      {!group.internet ? (
        <Badge
          variant="outline"
          className="rounded-sm border-destructive/30 bg-destructive/10 text-destructive"
          title={group.firewall.state === 'applied' ? 'Blocked on the router' : 'Not on the router yet'}
        >
          No internet{group.firewall.state === 'pending' ? ' (applying)' : ''}
        </Badge>
      ) : null}
      {group.portalBypass ? (
        <Badge variant="outline" className="rounded-sm border-status-good/30 bg-status-good/10 text-status-good">
          Passes the portal
        </Badge>
      ) : null}
      {group.firewall.state === 'conflict' ? (
        <Badge variant="outline" className="rounded-sm border-status-warning/40 bg-status-warning/10">
          Firewall changed on the router
        </Badge>
      ) : null}
    </>
  )
}

const AP_STATE_TEXT: Record<ApGroupState['state'], string> = {
  idle: 'Nothing sent yet',
  sending: 'Sending',
  pending_confirm: 'Applying',
  applied: 'Up to date',
  failed: 'Failed',
  rolled_back: 'Rolled back',
  waiting: 'Waiting',
  offline: 'Offline',
  unsupported: 'Groups off',
}

export function ApStateBadge({ ap }: { ap: ApGroupState }) {
  const tone =
    ap.state === 'applied'
      ? 'border-status-good/30 bg-status-good/10 text-status-good'
      : ap.state === 'failed' || ap.state === 'rolled_back'
        ? 'border-destructive/30 bg-destructive/10 text-destructive'
        : ap.state === 'unsupported' || !ap.online
          ? 'text-muted-foreground'
          : 'border-status-warning/40 bg-status-warning/10'
  return (
    <Badge variant="outline" className={`rounded-sm ${tone}`} title={ap.error ?? undefined}>
      {ap.online ? AP_STATE_TEXT[ap.state] : 'Offline'}
    </Badge>
  )
}

/**
 * Create or edit a group: name, notes, its network, speed limit, internet
 * access and the portal bypass.
 */
export function DeviceGroupDialog({
  gatewayId,
  group,
  networks,
  onClose,
  onSaved,
}: {
  gatewayId: number
  group: DeviceGroup | null
  networks: GatewayNetwork[]
  onClose: () => void
  onSaved?: (id: number) => void
}) {
  const create = useCreateDeviceGroup()
  const update = useUpdateDeviceGroup()
  const mutation = group ? update : create
  const policies = useQosPolicies(gatewayId)
  const [name, setName] = useState(group?.name ?? '')
  const [notes, setNotes] = useState(group?.notes ?? '')
  const [network, setNetwork] = useState(group?.network?.perchId ?? '')
  const [internet, setInternet] = useState(group?.internet ?? true)
  const [bypass, setBypass] = useState(group?.portalBypass ?? false)
  const [policyId, setPolicyId] = useState(group?.qos?.policyId ? String(group.qos.policyId) : '')
  const [down, setDown] = useState(kbpsToMbpsText(group?.qos?.rate?.downloadKbit ?? null))
  const [up, setUp] = useState(kbpsToMbpsText(group?.qos?.rate?.uploadKbit ?? null))
  const fieldErrors = vineFieldErrors(mutation.error)
  const candidates = networks.filter((n) => n.perchId && !n.management)

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const downKbit = mbpsToKbps(down) ?? null
    const upKbit = mbpsToKbps(up) ?? null
    const payload: DeviceGroupPayload = {
      name: name.trim(),
      notes: notes.trim() || null,
      networkPerchId: network || null,
      internet,
      portalBypass: network ? false : bypass,
      qos:
        policyId || downKbit || upKbit
          ? {
              policyId: policyId ? Number(policyId) : null,
              rate: downKbit || upKbit ? { downloadKbit: downKbit, uploadKbit: upKbit } : null,
            }
          : null,
    }
    const done = (saved: { id: number }) => {
      onSaved?.(saved.id)
      onClose()
    }
    if (group) update.mutate({ id: group.id, ...payload }, { onSuccess: done })
    else create.mutate({ ...payload, gatewayId, name: payload.name! }, { onSuccess: done })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>{group ? `Edit ${group.name}` : 'New device group'}</DialogTitle>
            <DialogDescription>
              A unit, a family, the IoT gear: its devices share a network, a speed limit and internet access.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Name" htmlFor="dg-name" error={fieldErrors.name}>
                <Input id="dg-name" required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} className="rounded-md" />
              </FormField>
              <FormField
                label="Network"
                htmlFor="dg-network"
                error={fieldErrors.networkPerchId}
                hint="Its own VLAN: Wi-Fi keys and sign-ins move devices there."
              >
                <select id="dg-network" value={network} onChange={(e) => setNetwork(e.target.value)} className={selectClassName}>
                  <option value="">None (members by device)</option>
                  {candidates.map((n) => (
                    <option key={n.perchId!} value={n.perchId!}>
                      {n.label}
                      {n.vlanId !== null ? ` (VLAN ${n.vlanId})` : ''}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Speed limit policy" htmlFor="dg-policy" hint="A shaping policy (its bucket and per-device caps).">
                <select id="dg-policy" value={policyId} onChange={(e) => setPolicyId(e.target.value)} className={selectClassName}>
                  <option value="">None</option>
                  {(policies.data ?? []).map((p) => (
                    <option key={p.id} value={String(p.id)}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </FormField>
              <div className="grid grid-cols-2 gap-2">
                <FormField label="Down (Mbit/s)" htmlFor="dg-down" hint="Per device.">
                  <Input id="dg-down" inputMode="decimal" placeholder="No cap" value={down} onChange={(e) => setDown(e.target.value)} className="rounded-md" />
                </FormField>
                <FormField label="Up (Mbit/s)" htmlFor="dg-up">
                  <Input id="dg-up" inputMode="decimal" placeholder="No cap" value={up} onChange={(e) => setUp(e.target.value)} className="rounded-md" />
                </FormField>
              </div>
            </div>
            <FormField label="Notes" htmlFor="dg-notes" error={fieldErrors.notes}>
              <Input id="dg-notes" placeholder="Optional" value={notes} onChange={(e) => setNotes(e.target.value)} className="rounded-md" />
            </FormField>
            <Checkbox
              id="dg-internet"
              checked={internet}
              onChange={setInternet}
              label="Internet access"
              description="Off blocks every member from the internet on the gateway (local traffic stays)."
            />
            <Checkbox
              id="dg-bypass"
              checked={bypass && !network}
              disabled={Boolean(network)}
              onChange={setBypass}
              label="Pass the guest portal"
              description={
                network
                  ? 'A group with its own network has no portal to pass.'
                  : 'Members go online on the gateway’s guest portals without signing in.'
              }
            />
            <ErrorNote error={mutation.error && Object.keys(fieldErrors).length === 0 ? mutation.error : null} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : group ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
