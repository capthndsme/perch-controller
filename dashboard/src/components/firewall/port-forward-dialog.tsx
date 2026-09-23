import { useId, useMemo, useState } from 'react'
import { Info, MagnifyingGlass, Warning } from '@phosphor-icons/react'
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
import { Segmented } from '@/components/ui/segmented'
import {
  ApplyNowCheckbox,
  Checkbox,
  ErrorNote,
  FormField,
  WriteResult,
  selectClassName,
} from '@/components/firewall/firewall-ui'
import {
  useCreatePortForward,
  useUpdatePortForward,
  type FirewallDevice,
} from '@/hooks/use-firewall'
import { firewallFieldErrors, formatPorts, formatProto, forwardTitle, overlappingForwards, parsePortRange } from '@/lib/firewall'
import { cn } from '@/lib/utils'
import type { FirewallOverview, FirewallWrite, PortForward, PortForwardInput, PortForwardPatch } from '@/types/firewall'

type ProtoChoice = 'tcp' | 'udp' | 'both'
type TargetMode = 'device' | 'address'

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

function protoChoiceOf(proto: string[]): ProtoChoice {
  const tcp = proto.length === 0 || proto.includes('tcp') || proto.includes('all')
  const udp = proto.length === 0 || proto.includes('udp') || proto.includes('all')
  return tcp && udp ? 'both' : udp ? 'udp' : 'tcp'
}

function protoList(choice: ProtoChoice): Array<'tcp' | 'udp'> {
  return choice === 'both' ? ['tcp', 'udp'] : [choice]
}

/**
 * Create or edit a port forward (firewall.md section 4). The target is a
 * device (Perch forwards to its reserved address and reserves the current one
 * in the same job when it has none) or an address, which must be reserved
 * unless the admin says it is static (`allowUnreserved`).
 */
export function PortForwardDialog({
  gatewayId,
  overview,
  forward,
  devices,
  onClose,
}: {
  gatewayId: number
  overview: FirewallOverview
  forward?: PortForward
  devices: { list: FirewallDevice[]; byMac: Map<string, FirewallDevice>; byIp: Map<string, FirewallDevice> }
  onClose: () => void
}) {
  const id = useId()
  const editing = Boolean(forward)
  const create = useCreatePortForward(gatewayId)
  const update = useUpdatePortForward(gatewayId)
  const mutation = editing ? update : create
  const [result, setResult] = useState<FirewallWrite<PortForward> | null>(null)

  const [name, setName] = useState(forward?.name ?? '')
  const [proto, setProto] = useState<ProtoChoice>(forward ? protoChoiceOf(forward.proto) : 'tcp')
  const [externalPort, setExternalPort] = useState(forward?.externalPort?.replace(':', '-') ?? '')
  const [mode, setMode] = useState<TargetMode>(forward && !forward.device ? 'address' : 'device')
  const [deviceMac, setDeviceMac] = useState(forward?.device?.mac.toLowerCase() ?? '')
  const [search, setSearch] = useState('')
  const [destIp, setDestIp] = useState(forward?.destIp ?? '')
  const [allowUnreserved, setAllowUnreserved] = useState(false)
  const [destPort, setDestPort] = useState(forward?.destPort?.replace(':', '-') ?? '')
  const [reflection, setReflection] = useState(forward?.reflection ?? true)
  const [enabled, setEnabled] = useState(forward?.enabled ?? true)
  const [srcZone, setSrcZone] = useState(forward?.srcZone ?? (overview.wanZones.includes('wan') ? 'wan' : (overview.wanZones[0] ?? 'wan')))
  const [destZone, setDestZone] = useState(forward?.destZone ?? '')
  const [applyNow, setApplyNow] = useState(true)
  const [touched, setTouched] = useState(false)

  const lanZones = overview.zones.filter((z) => !z.wan).map((z) => z.name)
  const serverErrors = firewallFieldErrors(mutation.error)
  const nameOf = (fid: string) => {
    const f = overview.portForwards.find((x) => x.id === fid)
    return f ? forwardTitle(f) : null
  }

  const errors = useMemo(() => {
    const out: Record<string, string> = {}
    if (!name.trim()) out.name = 'Give it a name.'
    else if (name.trim().length > 64) out.name = 'At most 64 characters.'
    if (!parsePortRange(externalPort)) out.externalPort = 'A port (1–65535) or a range like 8000-8010.'
    if (destPort.trim() && !parsePortRange(destPort)) out.destPort = 'A port (1–65535) or a range.'
    if (mode === 'device' && !deviceMac) out.target = 'Pick the device to forward to.'
    if (mode === 'address' && !IPV4.test(destIp.trim())) out.destIp = 'An IPv4 address, e.g. 192.168.1.30.'
    return out
  }, [name, externalPort, destPort, mode, deviceMac, destIp])

  const overlaps = useMemo(
    () =>
      enabled && parsePortRange(externalPort)
        ? overlappingForwards(
            { id: forward?.id, proto: protoList(proto), externalPort: externalPort.trim(), srcZone },
            overview.portForwards,
          )
        : [],
    [enabled, externalPort, proto, srcZone, forward?.id, overview.portForwards],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = q
      ? devices.list.filter(
          (d) => d.name.toLowerCase().includes(q) || d.mac.includes(q) || d.ips.some((ip) => ip.includes(q)),
        )
      : devices.list
    return list.slice(0, 60)
  }, [devices.list, search])

  const selected = deviceMac ? devices.byMac.get(deviceMac) : undefined
  const ipOwner = mode === 'address' && IPV4.test(destIp.trim()) ? devices.byIp.get(destIp.trim()) : undefined

  function body(): PortForwardInput {
    const out: PortForwardInput = {
      name: name.trim(),
      proto: protoList(proto),
      externalPort: externalPort.trim(),
      destPort: destPort.trim() === '' ? null : destPort.trim(),
      reflection,
      enabled,
      srcZone,
    }
    if (destZone) out.destZone = destZone
    if (mode === 'device') out.deviceMac = deviceMac
    else {
      out.destIp = destIp.trim()
      if (allowUnreserved) out.allowUnreserved = true
    }
    return out
  }

  /** Only what changed: edits of an imported forward keep every option they do not name. */
  function patch(f: PortForward): PortForwardPatch {
    const next = body()
    const out: PortForwardPatch = {}
    if (next.name !== (f.name ?? '')) out.name = next.name
    if (protoChoiceOf(f.proto) !== proto) out.proto = next.proto
    if (next.externalPort !== (f.externalPort ?? '').replace(':', '-')) out.externalPort = next.externalPort
    if ((next.destPort ?? null) !== (f.destPort ? f.destPort.replace(':', '-') : null)) out.destPort = next.destPort
    if (next.reflection !== f.reflection) out.reflection = next.reflection
    if (next.enabled !== f.enabled) out.enabled = next.enabled
    if (next.srcZone !== f.srcZone) out.srcZone = next.srcZone
    if (destZone && destZone !== f.destZone) out.destZone = destZone
    if (mode === 'device') {
      if (deviceMac !== f.device?.mac.toLowerCase()) out.deviceMac = deviceMac
    } else if (next.destIp !== f.destIp || allowUnreserved) {
      out.destIp = next.destIp
      if (allowUnreserved) out.allowUnreserved = true
    }
    return out
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setTouched(true)
    if (Object.keys(errors).length > 0) return
    if (forward) {
      const p = patch(forward)
      if (Object.keys(p).length === 0) {
        onClose()
        return
      }
      update.mutate({ id: forward.id, body: p, apply: applyNow }, { onSuccess: setResult })
    } else {
      create.mutate({ body: body(), apply: applyNow }, { onSuccess: setResult })
    }
  }

  const err = (key: string) => (touched ? errors[key] : undefined) ?? serverErrors[key]

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>
            {result ? (editing ? 'Port forward saved' : 'Port forward created') : editing ? `Edit ${forwardTitle(forward!)}` : 'New port forward'}
          </DialogTitle>
          <DialogDescription>
            {result
              ? 'The change is in Perch’s draft and, unless you kept it there, on its way to the router.'
              : 'Lets a service on your network be reached from the internet on a port of your public address.'}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <>
            <DialogBody>
              {result.object ? (
                <p className="text-[12.5px]">
                  <span className="font-medium">{forwardTitle(result.object)}</span>:{' '}
                  {formatProto(result.object.proto)} {formatPorts(result.object.externalPort)} →{' '}
                  {result.object.device
                    ? (devices.byMac.get(result.object.device.mac.toLowerCase())?.name ?? result.object.device.name ?? result.object.device.mac)
                    : result.object.destIp}{' '}
                  <span className="font-mono text-muted-foreground">
                    ({result.object.destIp}
                    {result.object.destPort ? `:${formatPorts(result.object.destPort)}` : ''})
                  </span>
                </p>
              ) : null}
              <WriteResult
                gatewayId={gatewayId}
                issues={result.issues}
                apply={result.apply}
                applyError={result.applyError}
              />
            </DialogBody>
            <DialogFooter>
              <Button size="sm" onClick={onClose}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col" noValidate>
            <DialogBody>
              <FormField label="Name" htmlFor={`${id}-name`} error={err('name')}>
                <Input
                  id={`${id}-name`}
                  value={name}
                  maxLength={64}
                  placeholder="e.g. NAS HTTPS"
                  onChange={(e) => setName(e.target.value)}
                  aria-invalid={Boolean(err('name'))}
                />
              </FormField>

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Protocol">
                  <Segmented
                    size="xs"
                    ariaLabel="Protocol"
                    value={proto}
                    onChange={setProto}
                    options={[
                      { id: 'tcp', label: 'TCP' },
                      { id: 'udp', label: 'UDP' },
                      { id: 'both', label: 'TCP + UDP' },
                    ]}
                    className="w-fit"
                  />
                </FormField>
                <FormField
                  label="External port"
                  htmlFor={`${id}-ext`}
                  error={err('externalPort')}
                  hint="On the router’s public address. A range: 8000-8010."
                >
                  <Input
                    id={`${id}-ext`}
                    value={externalPort}
                    inputMode="numeric"
                    placeholder="443"
                    className="font-mono"
                    onChange={(e) => setExternalPort(e.target.value)}
                    aria-invalid={Boolean(err('externalPort'))}
                  />
                </FormField>
              </div>

              {overlaps.length > 0 ? (
                <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs">
                  <Warning className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <div className="space-y-1">
                    <p className="font-medium text-destructive">That port is already forwarded</p>
                    <ul className="space-y-0.5 text-foreground/80">
                      {overlaps.slice(0, 4).map((f) => (
                        <li key={f.id}>
                          {forwardTitle(f)}: {formatProto(f.proto)} {formatPorts(f.externalPort)} → {f.destIp ?? '?'}
                        </li>
                      ))}
                    </ul>
                    <p className="text-muted-foreground">
                      The router would only ever use the first one, so Perch refuses a second enabled forward on the same
                      port. Pick another port, or save this one disabled.
                    </p>
                  </div>
                </div>
              ) : null}

              <FormField label="Forward to" error={err('target')}>
                <Segmented
                  size="xs"
                  ariaLabel="Forward to"
                  value={mode}
                  onChange={setMode}
                  options={[
                    { id: 'device', label: 'A device' },
                    { id: 'address', label: 'An address' },
                  ]}
                  className="w-fit"
                />
              </FormField>

              {mode === 'device' ? (
                <div className="space-y-2">
                  <div className="relative">
                    <MagnifyingGlass className="pointer-events-none absolute top-2 left-2 size-4 text-muted-foreground" />
                    <Input
                      aria-label="Search devices"
                      value={search}
                      placeholder="Search by name, MAC or address"
                      className="pl-8"
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  <ul
                    role="listbox"
                    aria-label="Devices"
                    className="max-h-48 overflow-y-auto rounded-md border border-border"
                  >
                    {filtered.length === 0 ? (
                      <li className="px-3 py-2 text-muted-foreground">
                        {devices.list.length === 0 ? 'No devices known yet.' : 'No device matches.'}
                      </li>
                    ) : (
                      filtered.map((d) => (
                        <li key={d.mac}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={d.mac === deviceMac}
                            onClick={() => setDeviceMac(d.mac)}
                            className={cn(
                              'flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left hover:bg-muted',
                              d.mac === deviceMac && 'bg-primary/10',
                            )}
                          >
                            <span className="min-w-0 truncate font-medium">{d.name}</span>
                            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                              {d.ips[0] ?? d.mac}
                            </span>
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                  {selected || deviceMac ? (
                    <p className="text-[12px]">
                      Forwarding to <span className="font-medium">{selected?.name ?? deviceMac}</span>{' '}
                      <span className="font-mono text-muted-foreground">{deviceMac}</span>
                    </p>
                  ) : null}
                  <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-2.5 text-[11.5px]">
                    <Info className="mt-0.5 size-4 shrink-0 text-primary" />
                    <span className="text-muted-foreground">
                      Perch forwards to the device’s reserved address. If it has no reservation yet, Perch reserves the
                      address it has now in the same change (the DHCP reservation first, then the forward: one confirm,
                      one rollback), so the forward keeps pointing at this device.
                    </span>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <FormField label="Address" htmlFor={`${id}-ip`} error={err('destIp')}>
                    <Input
                      id={`${id}-ip`}
                      value={destIp}
                      placeholder="192.168.1.30"
                      className="font-mono"
                      onChange={(e) => setDestIp(e.target.value)}
                      aria-invalid={Boolean(err('destIp'))}
                    />
                  </FormField>
                  {ipOwner ? (
                    <p className="text-[11.5px] text-muted-foreground">
                      That is {ipOwner.name}’s current address.{' '}
                      <button
                        type="button"
                        className="text-primary underline underline-offset-2"
                        onClick={() => {
                          setDeviceMac(ipOwner.mac)
                          setMode('device')
                        }}
                      >
                        Forward to the device instead
                      </button>{' '}
                      so Perch reserves it.
                    </p>
                  ) : null}
                  <Checkbox
                    id={`${id}-unreserved`}
                    checked={allowUnreserved}
                    onChange={setAllowUnreserved}
                    label="The address is static (not handed out by DHCP)"
                    description="Perch normally forwards only to an address a DHCP reservation holds: otherwise the device can get another address one day and the forward points at nothing, or at someone else. Tick this when the device’s address is set by hand on the device itself."
                  />
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  label="Internal port"
                  htmlFor={`${id}-int`}
                  error={err('destPort')}
                  hint="Empty: the same as the external port."
                >
                  <Input
                    id={`${id}-int`}
                    value={destPort}
                    inputMode="numeric"
                    placeholder={externalPort || 'same'}
                    className="font-mono"
                    onChange={(e) => setDestPort(e.target.value)}
                    aria-invalid={Boolean(err('destPort'))}
                  />
                </FormField>
                <FormField label="From zone" htmlFor={`${id}-src`} hint="Where the traffic comes in; normally the WAN.">
                  <select
                    id={`${id}-src`}
                    className={selectClassName}
                    value={srcZone}
                    onChange={(e) => setSrcZone(e.target.value)}
                  >
                    {overview.zones.map((z) => (
                      <option key={z.name} value={z.name}>
                        {z.name}
                        {z.wan ? ' (WAN)' : ''}
                      </option>
                    ))}
                  </select>
                </FormField>
              </div>

              <details className="rounded-md border border-border px-3 py-2">
                <summary className="cursor-pointer text-xs font-medium">More options</summary>
                <div className="mt-3 space-y-3">
                  <FormField
                    label="Destination zone"
                    htmlFor={`${id}-dest`}
                    hint="Empty: the zone of the network holding the address (else lan)."
                  >
                    <select
                      id={`${id}-dest`}
                      className={selectClassName}
                      value={destZone}
                      onChange={(e) => setDestZone(e.target.value)}
                    >
                      <option value="">Automatic</option>
                      {lanZones.map((z) => (
                        <option key={z} value={z}>
                          {z}
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <Checkbox
                    id={`${id}-reflection`}
                    checked={reflection}
                    onChange={setReflection}
                    label="Reachable from inside too (NAT loopback)"
                    description="Devices at home can use the public address and port as well."
                  />
                </div>
              </details>

              <Checkbox id={`${id}-enabled`} checked={enabled} onChange={setEnabled} label="Enabled" />

              <ErrorNote error={mutation.error} nameOf={nameOf} />
            </DialogBody>
            <DialogFooter>
              <div className="mr-auto">
                <ApplyNowCheckbox id={`${id}-apply`} checked={applyNow} onChange={setApplyNow} />
              </div>
              <Button type="button" size="sm" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={mutation.isPending}>
                {mutation.isPending ? 'Saving…' : editing ? 'Save' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
