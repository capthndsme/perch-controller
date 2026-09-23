import { useState } from 'react'
import { Link } from 'react-router-dom'
import { PencilSimple, PushPin, Trash } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Panel } from '@/components/ui/panel'
import { Spinner } from '@/components/ui/spinner'
import { ErrorLine, FactRow, IssueList, ToneBadge } from '@/components/gateway-config/bits'
import { WriteOutcome } from '@/components/gateway-config/dns-panel'
import { useProfile } from '@/hooks/use-auth'
import { useDeleteReservation, useDeviceReservation, useGateways, usePutReservation } from '@/hooks/use-gateways'
import { apiErrorCode } from '@/lib/api'
import { refusalField, refusalMessage, STATUS_META } from '@/lib/gateway-config'
import type { DhcpReservation, Issue } from '@/types/gateway-config'

/**
 * The device's DHCP reservation and DNS name on the managed gateway
 * (config-plane.md section 10.3). Hidden when no gateway is managed.
 */
export function DeviceReservationCard({ mac }: { mac: string }) {
  const isAdmin = useProfile().data?.role === 'admin'
  const [gatewayId, setGatewayId] = useState<number | null>(null)
  const query = useDeviceReservation(mac, gatewayId)
  const gateways = useGateways()
  const code = apiErrorCode(query.error)

  if (!mac || query.isPending) return null
  if (query.error) {
    if (code === 'gateway_ambiguous') {
      const ids = refusalField<number[]>(query.error, 'gatewayIds') ?? []
      return (
        <Panel title="Reservation" description="Several gateways are managed: pick the one this device uses.">
          <div className="flex flex-wrap gap-2">
            {ids.map((id) => (
              <Button key={id} size="xs" variant="outline" onClick={() => setGatewayId(id)}>
                {gateways.data?.find((g) => g.id === id)?.name ?? `Gateway #${id}`}
              </Button>
            ))}
          </div>
        </Panel>
      )
    }
    if (code === 'not_managed' && isAdmin) {
      return (
        <Panel title="Reservation" description="A fixed address and DNS name for this device.">
          <p className="text-xs text-muted-foreground">
            Needs a gateway in managed mode.{' '}
            <Link to="/gateway/config" className="underline underline-offset-2">
              Gateway configuration
            </Link>
          </p>
        </Panel>
      )
    }
    // No managed gateway, or not for this viewer: nothing to show.
    return null
  }

  const view = query.data!
  return (
    <ReservationBody
      mac={mac}
      gatewayId={view.gatewayId}
      reservation={view.reservation}
      dnsName={view.dnsName}
      lease={view.lease}
      isAdmin={isAdmin}
    />
  )
}

function ReservationBody({
  mac,
  gatewayId,
  reservation,
  dnsName,
  lease,
  isAdmin,
}: {
  mac: string
  gatewayId: number
  reservation: DhcpReservation | null
  dnsName: string | null
  lease: { ipv4: string | null; hostname: string | null } | null
  isAdmin: boolean
}) {
  const put = usePutReservation(mac)
  const remove = useDeleteReservation(mac)
  const [editing, setEditing] = useState(false)
  const [ip, setIp] = useState(reservation?.ip ?? lease?.ipv4 ?? '')
  const [hostname, setHostname] = useState(reservation?.hostname ?? '')
  const [publishDns, setPublishDns] = useState(reservation?.publishDns ?? true)
  const [leaseTime, setLeaseTime] = useState(reservation?.leaseTime ?? '')
  const routerOwned = reservation?.owner === 'router'
  const error = put.error ?? remove.error
  const refusedIssues = refusalField<Issue[]>(put.error, 'issues')
  const result = put.data ?? remove.data
  const status = reservation ? STATUS_META[reservation.status] : null

  function startEdit() {
    setIp(reservation?.ip ?? lease?.ipv4 ?? '')
    setHostname(reservation?.hostname ?? lease?.hostname ?? '')
    setPublishDns(reservation?.publishDns ?? true)
    setLeaseTime(reservation?.leaseTime ?? '')
    put.reset()
    setEditing(true)
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    try {
      await put.mutateAsync({
        gatewayId,
        ip: ip.trim() === '' ? null : ip.trim(),
        hostname: hostname.trim() === '' ? null : hostname.trim(),
        publishDns,
        leaseTime: leaseTime.trim() === '' ? null : leaseTime.trim(),
      })
      setEditing(false)
    } catch {
      // shown
    }
  }

  return (
    <Panel
      title="Reservation"
      description="A fixed address and DNS name for this device on the gateway."
      actions={
        reservation ? (
          <span className="flex items-center gap-1.5">
            {status ? <ToneBadge tone={status.tone} dot>{reservation.applied ? status.label : 'Not applied yet'}</ToneBadge> : null}
            {routerOwned ? <ToneBadge tone="neutral">Router’s</ToneBadge> : null}
          </span>
        ) : null
      }
    >
      <div className="space-y-2 text-xs" data-testid="reservation-card">
        {editing ? (
          <form onSubmit={save} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="res-ip">IPv4 address</Label>
              <div className="flex gap-2">
                <Input id="res-ip" className="font-mono" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="empty = name only" />
                {lease?.ipv4 ? (
                  <Button type="button" size="sm" variant="outline" onClick={() => setIp(lease.ipv4!)}>
                    Current
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="res-name">Host name</Label>
              <Input id="res-name" className="font-mono" value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="e.g. printer" />
            </div>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={publishDns} onChange={(e) => setPublishDns(e.target.checked)} />
              Answer DNS for this name with the address
            </label>
            <div className="space-y-1.5">
              <Label htmlFor="res-lease">Lease time</Label>
              <Input id="res-lease" className="font-mono" value={leaseTime} onChange={(e) => setLeaseTime(e.target.value)} placeholder="default (e.g. 12h, infinite)" />
            </div>
            <ErrorLine message={error ? refusalMessage(error) : null} />
            {refusedIssues ? <IssueList issues={refusedIssues} /> : null}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={put.isPending}>
                {put.isPending ? <Spinner className="size-3.5 text-current" /> : null}
                Save and apply
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : reservation ? (
          <>
            <div className="divide-y divide-border/70">
              <FactRow label="Address">
                <span className="font-mono">{reservation.ip ?? 'dynamic'}</span>
              </FactRow>
              <FactRow label="Host name">
                <span className="font-mono">{reservation.hostname ?? '—'}</span>
              </FactRow>
              <FactRow label="DNS name">
                <span className="font-mono">{dnsName ?? '—'}</span>
              </FactRow>
              {reservation.leaseTime ? (
                <FactRow label="Lease time">
                  <span className="font-mono">{reservation.leaseTime}</span>
                </FactRow>
              ) : null}
              {lease?.ipv4 && lease.ipv4 !== reservation.ip ? (
                <FactRow label="Current lease">
                  <span className="font-mono">{lease.ipv4}</span>
                </FactRow>
              ) : null}
            </div>
            {reservation.conflict ? (
              <p className="text-status-critical">
                In conflict with a router edit.{' '}
                <Link to={`/gateway/config/${gatewayId}?tab=conflicts`} className="underline underline-offset-2">
                  Resolve
                </Link>
              </p>
            ) : null}
            {routerOwned ? (
              <p className="text-muted-foreground">
                The router owns this host entry (excluded or not modeled): change it in LuCI, or include it on the gateway’s
                Sections tab.
              </p>
            ) : null}
            {isAdmin && !routerOwned ? (
              <div className="flex gap-2 pt-1">
                <Button size="xs" variant="outline" onClick={startEdit}>
                  <PencilSimple />
                  Edit
                </Button>
                <Button size="xs" variant="ghost" onClick={() => remove.mutate(gatewayId)} disabled={remove.isPending}>
                  <Trash />
                  Remove
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <p className="text-muted-foreground">
              No reservation{lease?.ipv4 ? `; it currently has ${lease.ipv4} from DHCP` : ''}.
            </p>
            {isAdmin ? (
              <div className="flex flex-wrap gap-2">
                {lease?.ipv4 ? (
                  <Button
                    size="xs"
                    onClick={() => put.mutate({ gatewayId, ip: 'current', hostname: lease.hostname ?? undefined, publishDns: true })}
                    disabled={put.isPending}
                  >
                    {put.isPending ? <Spinner className="size-3 text-current" /> : <PushPin />}
                    Keep {lease.ipv4}
                  </Button>
                ) : null}
                <Button size="xs" variant="outline" onClick={startEdit}>
                  Reserve…
                </Button>
              </div>
            ) : null}
          </>
        )}
        {!editing ? <ErrorLine message={error ? refusalMessage(error) : null} /> : null}
        {result ? (
          <>
            {result.apply ? <p className="text-muted-foreground">Applying to the router; the banner at the top follows it.</p> : null}
            <WriteOutcome gatewayId={gatewayId} issues={result.issues} applyError={result.applyError} />
          </>
        ) : null}
        {!editing && apiErrorCode(put.error) === 'dhcp_host_exists' ? (
          <p className="text-muted-foreground">Include the router’s host on the Sections tab to manage it here.</p>
        ) : null}
      </div>
    </Panel>
  )
}
