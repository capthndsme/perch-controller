import { useId, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowsClockwise, Info } from '@phosphor-icons/react'
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
import { Checkbox, ErrorNote, FormField, selectClassName } from '@/components/networks/network-ui'
import { IssueList, NetworkWriteResult } from '@/components/networks/network-write-result'
import { useInfraLayout } from '@/hooks/use-infra'
import { useCreateNetwork, useUpdateNetwork } from '@/hooks/use-networks'
import { apiErrorCode } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  L2_MODE_HINTS,
  L2_MODE_LABELS,
  NETWORK_KEY_PATTERN,
  PURPOSES,
  configWriteBlock,
  configWriteHardBlocked,
  networkFieldErrors,
  networkTitle,
  poolRange,
  portSpec,
  refusalIssues,
} from '@/lib/networks'
import type {
  GatewayBrief,
  GatewayNetwork,
  NetworkCreate,
  NetworkDhcpInput,
  NetworkL2Mode,
  NetworkPatch,
  NetworkPort,
  NetworkPurpose,
  NetworkWrite,
} from '@/types/networks'

type PortState = 'none' | 't' | 'u*' | 'u'

function stateOf(port: NetworkPort | undefined): PortState {
  if (!port) return 'none'
  if (port.tagged) return 't'
  return port.pvid ? 'u*' : 'u'
}

function portOf(name: string, state: PortState): NetworkPort | null {
  switch (state) {
    case 't':
      return { port: name, tagged: true, pvid: false }
    case 'u*':
      return { port: name, tagged: false, pvid: true }
    case 'u':
      return { port: name, tagged: false, pvid: false }
    default:
      return null
  }
}

const PORT_STATE_LABELS: Record<PortState, string> = {
  none: 'Not a member',
  t: 'Tagged',
  'u*': 'Untagged (PVID)',
  u: 'Untagged, not PVID',
}

type NetworkFormDialogProps = {
  gateway: GatewayBrief
  /** Every network of the gateway: bridges, ports in use, the conversion check. */
  networks: GatewayNetwork[]
  /** Edit this network; create a new one without. */
  network?: GatewayNetwork
  onClose: () => void
}

/**
 * Create or edit a network (docs/gateway/networks.md section 3.2). Create
 * composes the interface, its L2 sections and the DHCP pool into one draft
 * change and one apply; the first VLAN on an untagged bridge converts it
 * (members to VLAN `untaggedVlan`). Edit sends only what changed. After a
 * write the dialog shows the result: warnings, the conversion and the apply,
 * which the app-wide banner then follows through its confirm.
 */
export function NetworkFormDialog({ gateway, networks, network, onClose }: NetworkFormDialogProps) {
  const uid = useId()
  const editing = Boolean(network)
  const create = useCreateNetwork(gateway.id)
  const update = useUpdateNetwork(gateway.id)
  const mutation = editing ? update : create
  const layout = useInfraLayout()

  const [l2Mode, setL2Mode] = useState<NetworkL2Mode>(network?.l2Mode ?? 'bridge_vlan')
  const [key, setKey] = useState(network?.key ?? '')
  const [label, setLabel] = useState(network?.label ?? '')
  const [purpose, setPurpose] = useState<NetworkPurpose>(network?.purpose ?? 'custom')
  const [purposeTouched, setPurposeTouched] = useState(editing)
  const [bridgeName, setBridgeName] = useState(network?.bridge ?? '')
  const [vlanText, setVlanText] = useState(network?.vlanId ? String(network.vlanId) : '')
  const [parentDevice, setParentDevice] = useState(network?.parentDevice ?? network?.device ?? '')
  const [ports, setPorts] = useState<Record<string, PortState>>(() =>
    Object.fromEntries((network?.ports ?? []).map((p) => [p.port, stateOf(p)])),
  )
  const [extraPort, setExtraPort] = useState('')
  const [ipv4, setIpv4] = useState(network?.ipv4 ?? '')
  const [dhcpOn, setDhcpOn] = useState(network ? Boolean(network.dhcp?.enabled) : true)
  const [dhcpStart, setDhcpStart] = useState(String(network?.dhcp?.start ?? 100))
  const [dhcpLimit, setDhcpLimit] = useState(String(network?.dhcp?.limit ?? 150))
  const [dhcpLease, setDhcpLease] = useState(network?.dhcp?.leaseTime ?? '12h')
  const [untaggedText, setUntaggedText] = useState('1')
  const [zone, setZone] = useState(network?.firewallZone ?? '')
  const [capture, setCapture] = useState(true)
  const [captureTouched, setCaptureTouched] = useState(false)
  const [applyNow, setApplyNow] = useState(true)
  const [localError, setLocalError] = useState<string | null>(null)
  const [result, setResult] = useState<NetworkWrite | null>(null)

  const blockText = configWriteBlock(gateway)
  const hardBlocked = configWriteHardBlocked(gateway)
  const networkManaged = !network || network.owner === 'perch'
  const configDisabled = hardBlocked || !networkManaged
  const bridgeDefault = `br-${key || '<key>'}`

  // Bridges: those the gateway's networks ride on.
  const bridges = useMemo(() => {
    const out = new Map<string, { filtering: boolean; networks: string[] }>()
    for (const n of networks) {
      if (!n.bridge || (n.l2Mode !== 'bridge' && n.l2Mode !== 'bridge_vlan')) continue
      const entry = out.get(n.bridge) ?? { filtering: false, networks: [] }
      if (n.l2Mode === 'bridge_vlan') entry.filtering = true
      entry.networks.push(n.key)
      out.set(n.bridge, entry)
    }
    return out
  }, [networks])
  const bridge = bridgeName || (l2Mode === 'bridge_vlan' ? ([...bridges.keys()][0] ?? '') : '')
  const conversion =
    !editing && l2Mode === 'bridge_vlan' && bridge !== '' && bridges.has(bridge) && !bridges.get(bridge)!.filtering

  // Ports: the gateway node's agent ports (infrastructure view), plus those the networks name.
  const portChoices = useMemo(() => {
    const names = new Map<string, string | null>()
    const node = layout.data?.nodes.find(
      (n) => n.binding?.type === 'collector' && n.binding.id === gateway.collectorId,
    )
    for (const p of node?.ports ?? []) {
      // WAN ports never join a LAN bridge; the operator can still type one below.
      if (p.present && !p.hidden && p.role !== 'wan') names.set(p.key, p.label !== p.key ? p.label : null)
    }
    for (const n of networks) for (const p of n.ports) if (!names.has(p.port)) names.set(p.port, null)
    for (const p of Object.keys(ports)) if (!names.has(p)) names.set(p, null)
    return [...names.entries()].map(([port, portLabel]) => ({ port, label: portLabel }))
  }, [layout.data, gateway.collectorId, networks, ports])
  const reportedPorts = useMemo(() => {
    const node = layout.data?.nodes.find(
      (n) => n.binding?.type === 'collector' && n.binding.id === gateway.collectorId,
    )
    return new Set((node?.ports ?? []).filter((p) => p.present).map((p) => p.key))
  }, [layout.data, gateway.collectorId])

  // What the other networks on the same bridge do with each port.
  const portUsage = useMemo(() => {
    const usage = new Map<string, string[]>()
    for (const n of networks) {
      if (n.id === network?.id) continue
      if (l2Mode === 'bridge_vlan' ? n.bridge !== bridge : n.l2Mode !== 'bridge') continue
      for (const p of n.ports) {
        const list = usage.get(p.port) ?? []
        list.push(n.l2Mode === 'bridge_vlan' ? `${n.key} ${portSpec(p).split(':')[1]}` : n.key)
        usage.set(p.port, list)
      }
    }
    return usage
  }, [networks, network?.id, l2Mode, bridge])

  const hasPorts = l2Mode === 'bridge' || l2Mode === 'bridge_vlan'
  const hasVlan = l2Mode === 'bridge_vlan' || l2Mode === '8021q'
  const fieldErrors = networkFieldErrors(mutation.error)
  const issues = refusalIssues(mutation.error)
  const vlanId = Number(vlanText)
  const range = dhcpOn ? poolRange(ipv4.trim() || null, Number(dhcpStart), Number(dhcpLimit)) : null

  function portList(): NetworkPort[] {
    return Object.entries(ports)
      .map(([name, state]) => portOf(name, l2Mode === 'bridge' && state !== 'none' ? 'u*' : state))
      .filter((p): p is NetworkPort => p !== null)
  }

  function dhcpInput(): NetworkDhcpInput | null {
    return {
      enabled: dhcpOn,
      start: Number(dhcpStart),
      limit: Number(dhcpLimit),
      leaseTime: dhcpLease.trim(),
    }
  }

  function validate(): string | null {
    if (!editing && !NETWORK_KEY_PATTERN.test(key)) {
      return 'The key must start with a letter and use a–z, 0–9 and _ (at most 15 characters).'
    }
    if (hasVlan && (!editing || network?.vlanId !== null)) {
      if (!Number.isInteger(vlanId) || vlanId < 1 || vlanId > 4094) return 'VLAN ids run from 1 to 4094.'
    }
    if (!editing && l2Mode === 'bridge_vlan' && !bridge) return 'Choose the bridge the VLAN rides on.'
    if (!editing && (l2Mode === '8021q' || l2Mode === 'device') && !parentDevice.trim()) {
      return l2Mode === '8021q' ? 'Choose the parent device.' : 'Name the device.'
    }
    if (dhcpOn && !ipv4.trim()) return 'A DHCP pool needs the network to have an IPv4 address.'
    if (dhcpOn && (!Number.isInteger(Number(dhcpStart)) || !Number.isInteger(Number(dhcpLimit)))) {
      return 'The DHCP start and size are whole numbers.'
    }
    if (conversion) {
      const u = Number(untaggedText)
      if (!Number.isInteger(u) || u < 1 || u > 4094 || u === vlanId) {
        return 'The VLAN for the existing members must be 1–4094 and differ from the new one.'
      }
    }
    return null
  }

  function createBody(): NetworkCreate {
    const body: NetworkCreate = { key, l2Mode, purpose, capture }
    if (label.trim()) body.label = label.trim()
    if (l2Mode === 'bridge_vlan') body.bridge = bridge
    if (l2Mode === 'bridge' && bridgeName.trim()) body.bridge = bridgeName.trim()
    if (hasVlan) body.vlanId = vlanId
    if (l2Mode === '8021q' || l2Mode === 'device') body.parentDevice = parentDevice.trim()
    if (hasPorts) body.ports = portList()
    body.ipv4 = ipv4.trim() || null
    if (dhcpOn && ipv4.trim()) body.dhcp = dhcpInput()
    if (conversion) body.untaggedVlan = Number(untaggedText)
    if (zone.trim()) body.firewallZone = zone.trim()
    return body
  }

  function patchBody(n: GatewayNetwork): NetworkPatch {
    const patch: NetworkPatch = {}
    if (label.trim() && label.trim() !== n.label) patch.label = label.trim()
    if (purpose !== n.purpose) patch.purpose = purpose
    if ((zone.trim() || null) !== n.firewallZone) patch.firewallZone = zone.trim() || null
    if (configDisabled) return patch
    if ((ipv4.trim() || null) !== n.ipv4) patch.ipv4 = ipv4.trim() || null
    if (hasVlan && n.vlanId !== null && vlanId !== n.vlanId) patch.vlanId = vlanId
    if (hasPorts) {
      const next = portList().map(portSpec).sort().join(' ')
      const before = n.ports.map(portSpec).sort().join(' ')
      if (next !== before) patch.ports = portList()
    }
    const pool = n.dhcp
    if (!dhcpOn && pool && pool.enabled) {
      // Off keeps the pool section, ignored; "Remove" below deletes it.
      patch.dhcp = { ...dhcpInput()!, enabled: false }
    } else if (dhcpOn) {
      const next = dhcpInput()!
      if (
        !pool ||
        !pool.enabled ||
        pool.start !== next.start ||
        pool.limit !== next.limit ||
        (pool.leaseTime ?? '') !== next.leaseTime
      ) {
        patch.dhcp = next
      }
    }
    return patch
  }

  function submit(options: { removePool?: boolean } = {}) {
    setLocalError(null)
    const problem = options.removePool ? null : validate()
    if (problem) {
      setLocalError(problem)
      return
    }
    if (network) {
      const patch = options.removePool ? { dhcp: null } : patchBody(network)
      if (Object.keys(patch).length === 0) {
        onClose()
        return
      }
      update.mutate(
        { networkId: network.id, patch, apply: applyNow },
        { onSuccess: (data) => setResult(data) },
      )
    } else {
      create.mutate({ body: createBody(), apply: applyNow }, { onSuccess: (data) => setResult(data) })
    }
  }

  function onPurpose(next: NetworkPurpose) {
    setPurpose(next)
    setPurposeTouched(true)
    if (!editing && !captureTouched) setCapture(next !== 'guest')
  }

  function onKey(next: string) {
    const clean = next.toLowerCase()
    setKey(clean)
    if (!purposeTouched) {
      const guessed: NetworkPurpose = clean.startsWith('guest')
        ? 'guest'
        : clean.startsWith('iot')
          ? 'iot'
          : clean === 'mgmt' || clean.startsWith('manage')
            ? 'management'
            : 'custom'
      setPurpose(guessed)
      if (!captureTouched) setCapture(guessed !== 'guest')
    }
  }

  const title = editing ? `Edit ${networkTitle(network!)}` : `New network on ${gateway.name}`

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{result ? (editing ? 'Network saved' : 'Network created') : title}</DialogTitle>
          <DialogDescription>
            {result
              ? 'What the write did. The banner at the top follows the apply through its confirm.'
              : editing
                ? 'Only what you change is sent. Config changes go into the draft and, unless you keep them there, out in one apply.'
                : 'The interface, its bridge VLAN or device, and the DHCP pool go out together in one apply.'}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <>
            <DialogBody>
              <NetworkWriteResult result={result} gatewayId={gateway.id} />
              {!result.apply && !result.applyError && !result.converted && result.issues.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {applyNow ? 'Saved.' : 'Saved to the draft; apply it from the pending changes when you are ready.'}
                </p>
              ) : null}
            </DialogBody>
            <DialogFooter>
              {!editing && result.object ? (
                <Button asChild variant="outline" size="sm">
                  <Link to={`/networks/${gateway.id}/${result.object.id}`} onClick={onClose}>
                    Open the network
                  </Link>
                </Button>
              ) : null}
              <Button size="sm" onClick={onClose}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogBody>
              {blockText && (configDisabled || !editing) ? (
                <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-2.5 text-xs text-muted-foreground">
                  <Info className="mt-0.5 size-4 shrink-0" />
                  <span>{blockText}</span>
                </div>
              ) : null}
              {editing && !networkManaged ? (
                <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-2.5 text-xs text-muted-foreground">
                  <Info className="mt-0.5 size-4 shrink-0" />
                  <span>
                    {network!.owner === null
                      ? 'Perch knows this network from the collector’s report only; its config is not modeled. Label and purpose still work.'
                      : 'Perch mirrors this network but does not manage it (its sections are excluded or not synced). Include them under Gateway config → Sections to edit the config here.'}
                  </span>
                </div>
              ) : null}

              {!editing ? (
                <FormField label="Kind" hint={L2_MODE_HINTS[l2Mode]}>
                  <Segmented
                    value={l2Mode}
                    onChange={setL2Mode}
                    ariaLabel="Kind of network"
                    size="xs"
                    className="w-fit flex-wrap"
                    options={(['bridge_vlan', 'bridge', '8021q', 'device'] as const).map((m) => ({
                      id: m,
                      label: L2_MODE_LABELS[m],
                    }))}
                  />
                </FormField>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2">
                {!editing ? (
                  <FormField
                    label="Key"
                    htmlFor={`${uid}-key`}
                    hint="The interface name on the router (guest, iot, vlan30). It never changes."
                    error={fieldErrors.key}
                  >
                    <Input
                      id={`${uid}-key`}
                      value={key}
                      onChange={(e) => onKey(e.target.value)}
                      placeholder="guest"
                      maxLength={15}
                      autoComplete="off"
                      className="font-mono"
                    />
                  </FormField>
                ) : null}
                <FormField label="Label" htmlFor={`${uid}-label`} hint="Perch’s name for it; never written to the router.">
                  <Input
                    id={`${uid}-label`}
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder={key || 'Guest Wi-Fi'}
                    maxLength={80}
                  />
                </FormField>
                <FormField label="Purpose" htmlFor={`${uid}-purpose`}>
                  <select
                    id={`${uid}-purpose`}
                    className={selectClassName}
                    value={purpose}
                    onChange={(e) => onPurpose(e.target.value as NetworkPurpose)}
                  >
                    {PURPOSES.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </FormField>
              </div>

              <fieldset disabled={configDisabled} className="space-y-4 disabled:opacity-60">
                {l2Mode === 'bridge_vlan' ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField
                      label="Bridge"
                      htmlFor={`${uid}-bridge`}
                      hint={editing ? 'A network’s bridge does not change.' : undefined}
                    >
                      <select
                        id={`${uid}-bridge`}
                        className={selectClassName}
                        value={bridge}
                        disabled={editing}
                        onChange={(e) => setBridgeName(e.target.value)}
                      >
                        {bridges.size === 0 ? <option value="">No bridge found</option> : null}
                        {[...bridges.entries()].map(([name, info]) => (
                          <option key={name} value={name}>
                            {name} ({info.networks.join(', ')}){info.filtering ? '' : ' · untagged'}
                          </option>
                        ))}
                      </select>
                    </FormField>
                    <FormField label="VLAN id" htmlFor={`${uid}-vid`} error={fieldErrors.vlanId}>
                      <Input
                        id={`${uid}-vid`}
                        inputMode="numeric"
                        value={vlanText}
                        onChange={(e) => setVlanText(e.target.value.replace(/\D/g, ''))}
                        placeholder="30"
                      />
                    </FormField>
                  </div>
                ) : null}

                {conversion ? (
                  <div className="space-y-2 rounded-md border border-status-warning/40 bg-status-warning/10 p-3 text-xs">
                    <p className="flex items-center gap-1.5 font-medium">
                      <ArrowsClockwise className="size-4 text-status-warning" />
                      First VLAN on {bridge}: it becomes VLAN-filtering
                    </p>
                    <p className="text-muted-foreground">
                      {bridge} carries {bridges.get(bridge)!.networks.join(', ')} untagged today. In the same apply Perch
                      adds VLAN {untaggedText || '1'} with every current member as its untagged port (except the ports
                      you make this VLAN’s untagged ports below) and moves{' '}
                      {bridges.get(bridge)!.networks.join(', ')} to {bridge}.{untaggedText || '1'}. Devices on those
                      ports keep working unchanged. When {bridge} is the way the gateway reaches Perch, that part goes
                      out as a protected apply with a longer confirm window, and the router rolls it back by itself if
                      the gateway does not come back.
                    </p>
                    <FormField
                      label="VLAN for the existing members"
                      htmlFor={`${uid}-untagged`}
                      className="max-w-56"
                    >
                      <Input
                        id={`${uid}-untagged`}
                        inputMode="numeric"
                        value={untaggedText}
                        onChange={(e) => setUntaggedText(e.target.value.replace(/\D/g, ''))}
                      />
                    </FormField>
                  </div>
                ) : null}

                {l2Mode === 'bridge' && !editing ? (
                  <FormField
                    label="Bridge name"
                    htmlFor={`${uid}-brname`}
                    hint={`Leave empty for ${bridgeDefault}. A new bridge; its ports must not be in another bridge.`}
                  >
                    <Input
                      id={`${uid}-brname`}
                      value={bridgeName}
                      onChange={(e) => setBridgeName(e.target.value)}
                      placeholder={bridgeDefault}
                      maxLength={15}
                      className="font-mono"
                    />
                  </FormField>
                ) : null}

                {l2Mode === '8021q' || l2Mode === 'device' ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField
                      label={l2Mode === '8021q' ? 'Parent device' : 'Device'}
                      htmlFor={`${uid}-parent`}
                      hint={l2Mode === '8021q' ? `The VLAN device is ${parentDevice || 'eth1'}.${vlanText || '<vid>'}.` : undefined}
                    >
                      <Input
                        id={`${uid}-parent`}
                        value={parentDevice}
                        onChange={(e) => setParentDevice(e.target.value)}
                        placeholder="eth1"
                        disabled={editing}
                        list={`${uid}-ports`}
                        className="font-mono"
                      />
                      <datalist id={`${uid}-ports`}>
                        {portChoices.map((p) => (
                          <option key={p.port} value={p.port} />
                        ))}
                      </datalist>
                    </FormField>
                    {l2Mode === '8021q' ? (
                      <FormField label="VLAN id" htmlFor={`${uid}-vid8`} error={fieldErrors.vlanId}>
                        <Input
                          id={`${uid}-vid8`}
                          inputMode="numeric"
                          value={vlanText}
                          onChange={(e) => setVlanText(e.target.value.replace(/\D/g, ''))}
                          placeholder="40"
                        />
                      </FormField>
                    ) : null}
                  </div>
                ) : null}

                {hasPorts ? (
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium">{l2Mode === 'bridge_vlan' ? 'Ports (VLAN members)' : 'Ports'}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {l2Mode === 'bridge_vlan'
                        ? 'Tagged for a trunk to a switch or an AP; untagged (PVID) for a plain device on that port. A port is the untagged port of one VLAN at most.'
                        : 'The ports that join this bridge.'}{' '}
                      From the gateway’s ports on the infrastructure map.
                    </p>
                    {portChoices.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        The gateway reports no ports; add one by name below.
                      </p>
                    ) : (
                      <div className="divide-y divide-border rounded-md border border-border">
                        {portChoices.map(({ port, label: portLabel }) => {
                          const state = ports[port] ?? 'none'
                          const usage = portUsage.get(port)
                          return (
                            <div key={port} className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5">
                              <div className="min-w-0">
                                <span className="font-mono text-xs">{port}</span>
                                {portLabel ? <span className="ml-1.5 text-[11px] text-muted-foreground">{portLabel}</span> : null}
                                {!reportedPorts.has(port) && reportedPorts.size > 0 ? (
                                  <span className="ml-1.5 text-[11px] text-status-warning">not reported by the gateway</span>
                                ) : null}
                                {usage ? (
                                  <span className="block text-[11px] text-muted-foreground">Also: {usage.join(', ')}</span>
                                ) : null}
                              </div>
                              {l2Mode === 'bridge' ? (
                                <input
                                  type="checkbox"
                                  className="size-3.5 accent-primary"
                                  aria-label={`${port} is a member`}
                                  checked={state !== 'none'}
                                  onChange={(e) => setPorts((p) => ({ ...p, [port]: e.target.checked ? 'u*' : 'none' }))}
                                />
                              ) : (
                                <select
                                  aria-label={`${port} membership`}
                                  className={cn(selectClassName, 'h-7 w-44')}
                                  value={state}
                                  onChange={(e) => setPorts((p) => ({ ...p, [port]: e.target.value as PortState }))}
                                >
                                  {(['none', 't', 'u*', 'u'] as const)
                                    .filter((s) => s !== 'u' || state === 'u')
                                    .map((s) => (
                                      <option key={s} value={s}>
                                        {PORT_STATE_LABELS[s]}
                                      </option>
                                    ))}
                                </select>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <Input
                        aria-label="Another port by name"
                        value={extraPort}
                        onChange={(e) => setExtraPort(e.target.value.trim())}
                        placeholder="Another port (lan4)"
                        maxLength={15}
                        className="h-7 max-w-48 font-mono"
                      />
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={!/^[A-Za-z0-9_.@-]{1,15}$/.test(extraPort) || extraPort in ports}
                        onClick={() => {
                          setPorts((p) => ({ ...p, [extraPort]: l2Mode === 'bridge' ? 'u*' : 't' }))
                          setExtraPort('')
                        }}
                      >
                        Add
                      </Button>
                    </div>
                  </div>
                ) : null}

                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField
                    label="IPv4 address"
                    htmlFor={`${uid}-ipv4`}
                    hint="The router’s address with the prefix. Empty = no address (proto none)."
                    error={fieldErrors.ipv4}
                  >
                    <Input
                      id={`${uid}-ipv4`}
                      value={ipv4}
                      onChange={(e) => setIpv4(e.target.value.trim())}
                      placeholder="192.168.30.1/24"
                      className="font-mono"
                    />
                  </FormField>
                  <FormField
                    label="Firewall zone"
                    htmlFor={`${uid}-zone`}
                    hint="Firewall management comes later: leave this empty and put the network into a zone on the router (LuCI) for now."
                  >
                    <Input
                      id={`${uid}-zone`}
                      value={zone}
                      onChange={(e) => setZone(e.target.value)}
                      placeholder="guest"
                      className="font-mono"
                    />
                  </FormField>
                </div>

                <div className="space-y-2 rounded-md border border-border p-3">
                  <Checkbox
                    id={`${uid}-dhcp`}
                    checked={dhcpOn}
                    onChange={setDhcpOn}
                    disabled={network?.dhcp?.owner === 'router'}
                    label="DHCP server on this network"
                    description={
                      network?.dhcp?.owner === 'router'
                        ? 'The router owns this pool (not synced): Perch leaves it alone.'
                        : 'dnsmasq hands out addresses from the pool below.'
                    }
                  />
                  {dhcpOn ? (
                    <div className="grid gap-3 sm:grid-cols-3">
                      <FormField label="Start" htmlFor={`${uid}-start`} hint="Offset from the network address." error={fieldErrors['dhcp.start']}>
                        <Input
                          id={`${uid}-start`}
                          inputMode="numeric"
                          value={dhcpStart}
                          onChange={(e) => setDhcpStart(e.target.value.replace(/\D/g, ''))}
                        />
                      </FormField>
                      <FormField label="Size" htmlFor={`${uid}-limit`} hint="How many leases." error={fieldErrors['dhcp.limit']}>
                        <Input
                          id={`${uid}-limit`}
                          inputMode="numeric"
                          value={dhcpLimit}
                          onChange={(e) => setDhcpLimit(e.target.value.replace(/\D/g, ''))}
                        />
                      </FormField>
                      <FormField label="Lease time" htmlFor={`${uid}-lease`} hint="12h, 30m, infinite." error={fieldErrors['dhcp.leaseTime']}>
                        <Input
                          id={`${uid}-lease`}
                          value={dhcpLease}
                          onChange={(e) => setDhcpLease(e.target.value)}
                          className="font-mono"
                        />
                      </FormField>
                    </div>
                  ) : null}
                  {range ? <p className="font-mono text-[11px] text-muted-foreground">Pool: {range}</p> : null}
                  {editing && network?.dhcp && network.dhcp.owner === 'perch' ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={mutation.isPending}
                      onClick={() => submit({ removePool: true })}
                    >
                      Remove the pool
                    </Button>
                  ) : null}
                </div>
              </fieldset>

              {!editing ? (
                <Checkbox
                  id={`${uid}-capture`}
                  checked={capture}
                  onChange={(next) => {
                    setCapture(next)
                    setCaptureTouched(true)
                  }}
                  label="Capture its traffic in Perch"
                  description="Off: Perch records no devices, destinations or protocols for this network. Guest networks start off (privacy; you decide)."
                />
              ) : null}

              <Checkbox
                id={`${uid}-apply`}
                checked={applyNow}
                onChange={setApplyNow}
                disabled={configDisabled}
                label="Apply now"
                description="Off keeps the change in the draft; apply it later from the gateway’s pending changes."
              />

              {localError ? <p className="text-xs text-destructive">{localError}</p> : null}
              <ErrorNote error={mutation.error} />
              {issues.length > 0 ? <IssueList issues={issues} /> : null}
              {apiErrorCode(mutation.error) === 'firewall_not_managed' ? (
                <Button type="button" size="xs" variant="outline" onClick={() => setZone(network?.firewallZone ?? '')}>
                  Clear the zone
                </Button>
              ) : null}
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={mutation.isPending || (!editing && configDisabled)}
                onClick={() => submit()}
              >
                {mutation.isPending ? 'Saving…' : editing ? 'Save' : applyNow ? 'Create and apply' : 'Create as draft'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
