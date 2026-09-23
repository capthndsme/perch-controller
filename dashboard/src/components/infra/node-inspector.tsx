import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowSquareOut,
  Eye,
  EyeSlash,
  PencilSimple,
  Plus,
  PlugsConnected,
  Trash,
  Warning,
  WarningCircle,
} from '@phosphor-icons/react'
import { Fact } from '@/components/collectors/fact'
import { ClientInspector } from '@/components/infra/client-inspector'
import { ConnectDeviceForm, type SpotNear } from '@/components/infra/connect-device'
import { DevicePicker } from '@/components/infra/device-picker'
import { DeviceSummary } from '@/components/infra/device-summary'
import { CloseButton, FieldError, Section } from '@/components/infra/inspector-parts'
import { NodeIcon } from '@/components/infra/kind-icon'
import type { InfraNotice, InfraSelection } from '@/components/infra/infra-canvas'
import { NativeSelect } from '@/components/infra/native-select'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  useAddInfraPorts,
  useBindInfraNode,
  useDeleteInfraLink,
  useDeleteInfraNode,
  useDeleteInfraPort,
  useUpdateInfraLink,
  useUpdateInfraNode,
  useUpdateInfraPort,
} from '@/hooks/use-infra'
import { uplinkLine } from '@/lib/attachment'
import { formatLastSeen } from '@/lib/collectors'
import { deviceDisplayName, deviceTypeLabel } from '@/lib/device-labels'
import {
  agentSoftware,
  agentVersionLabel,
  attachmentOnMap,
  bindingTypeFor,
  cabledPortCount,
  canBindDevice,
  describeLink,
  describePort,
  formatPortSpeed,
  inferPortRole,
  infraErrorMessage,
  LINK_MEDIUM_LABELS,
  linkStateText,
  nodeKindWord,
  nodeStatusLabel,
  nodeSummary,
  oldAgentHint,
  otherEnd,
  parsePortKeys,
  placedDevices,
  placedRefusalNodeId,
  PORT_KEY_PATTERN,
  PORT_LED_CLASSES,
  PORT_MEDIUM_LABELS,
  PORT_ROLE_LABELS,
  portDisplayName,
  portLed,
  portStateText,
  presenceWords,
  suggestPortKeys,
  type LayoutIndex,
  type StateIndex,
} from '@/lib/infra'
import type { WifiOverlay } from '@/lib/infra-overlay'
import { connectionLabel } from '@/lib/presence'
import { cn } from '@/lib/utils'
import { formatSignal, formatWifiBand } from '@/lib/wifi'
import type {
  InfraLayoutResponse,
  InfraLink,
  InfraLinkMedium,
  InfraNode,
  InfraPort,
  InfraPortMedium,
  InfraPortRole,
  UpdateInfraLinkPayload,
  UpdateInfraNodePayload,
  UpdateInfraPortPayload,
} from '@/types/api'

export type InspectorProps = {
  selection: InfraSelection
  layout: InfraLayoutResponse
  index: LayoutIndex
  stateIndex: StateIndex
  editing: boolean
  isAdmin: boolean
  /** The node whose "Add ports" form should be open. */
  addPortsNodeId: number | null
  onAddPortsNodeIdChange: (nodeId: number | null) => void
  /** The port whose "Connect a device…" form is open (A4.1). */
  connectPortId: number | null
  onConnectPortIdChange: (portId: number | null) => void
  /** The Wi-Fi overlay while it is on (A4.4), else null. */
  overlay: WifiOverlay | null
  onSelect: (selection: InfraSelection | null) => void
  onNotice: (notice: InfraNotice | null) => void
  outsideFrame: (nodeId: number) => { x: number; y: number } | null
  /** A free spot for a new box next to a node (under one of its ports). */
  spotNear: SpotNear
}

/** Details for what is selected on the map: a device (with its ports), a cable, or a Wi-Fi client. */
export function InfraInspector(props: InspectorProps) {
  const { selection, index, onSelect } = props
  if (selection.type === 'client' || selection.type === 'clients') {
    return <ClientInspector key={selection.type === 'client' ? selection.mac : `ap-${selection.apNodeId}`} {...props} />
  }
  if (selection.type === 'link') {
    const link = index.links.get(selection.id)
    if (!link) {
      return (
        <div className="flex items-start justify-between gap-2 p-4 text-xs text-muted-foreground">
          This cable is no longer on the map.
          <CloseButton onClose={() => onSelect(null)} />
        </div>
      )
    }
    return <CableInspector key={link.id} link={link} {...props} />
  }
  const node = index.nodes.get(selection.id)
  if (!node) {
    return (
      <div className="flex items-start justify-between gap-2 p-4 text-xs text-muted-foreground">
        This device is no longer on the map.
        <CloseButton onClose={() => onSelect(null)} />
      </div>
    )
  }
  return <NodeInspector key={node.id} node={node} {...props} />
}

// ── Device ───────────────────────────────────────────────────────────────

function transportWord(node: InfraNode): string | null {
  const binding = node.binding
  if (!binding) return null
  if (binding.type === 'collector') return binding.transport === 'agent' ? 'socket' : 'polled'
  return binding.transport === 'agent' ? 'agent' : 'scraped'
}

function NodeInspector({ node, ...props }: InspectorProps & { node: InfraNode }) {
  const { index, stateIndex, editing, isAdmin, selection, onSelect } = props
  const state = stateIndex.nodes.get(node.id)
  const summary = nodeSummary(node, state, index.kinds)
  const version = state?.version ?? node.binding?.version ?? null
  const hint = oldAgentHint(node, version)
  const parent = node.parentId !== null ? index.nodes.get(node.parentId) : undefined
  const focusedPortId = selection.type === 'node' ? (selection.portId ?? null) : null
  const presence = state?.presence ?? null
  const canAddPorts = !node.binding || node.binding.portsSupported !== true
  const addPortsOpen = props.addPortsNodeId === node.id

  // Under the status line: what it is. The agent build for a bound node (§9:
  // "perch-collector <version>"), the device's type for a box bound to one
  // (A4.2), else the model or the kind.
  const what = node.binding
    ? [agentVersionLabel(node.binding, version), node.model].filter(Boolean).join(' · ')
    : node.device
      ? [deviceTypeLabel(node.device.deviceType) ?? nodeKindWord(node, index.kinds), node.model].filter(Boolean).join(' · ')
      : (node.model ?? nodeKindWord(node, index.kinds))
  // A box bound to a device that is on Wi-Fi right now (known while the overlay is on).
  const wifiClient = node.device ? (props.overlay?.clients.get(node.device.mac.toLowerCase()) ?? null) : null
  // Off Wi-Fi, where the device plugs in, in the device page's words: "Ethernet · Garage switch · port 3 · 1 Gb/s".
  const wiredLine =
    node.device && presence && presence.via !== 'wifi' && !wifiClient
      ? [connectionLabel(presence.via), uplinkLine(attachmentOnMap(node, index, stateIndex))].filter(Boolean).join(' · ')
      : null

  let statusLine: string
  if (node.device && presence) {
    statusLine = presenceWords(presence) ?? ''
  } else {
    statusLine = nodeStatusLabel(summary.status)
    if (node.binding && summary.status !== 'online' && state?.lastSeenAt) {
      statusLine += ` · last report ${formatLastSeen(state.lastSeenAt)}`
    }
  }

  return (
    <div className="flex flex-col pb-2" data-inspector="node">
      <header className="flex items-start gap-2 px-4 pt-3 pb-3">
        <NodeIcon node={node} className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <h2 className="truncate text-sm font-semibold" title={node.name}>
            {node.name}
          </h2>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', summary.dotClass)} />
            <span>{statusLine}</span>
          </p>
          <p className="text-xs text-muted-foreground" data-inspector-subtitle>
            {what}
          </p>
          {node.isRoot ? (
            <span className="inline-block rounded-sm border border-brand/40 bg-brand/10 px-1 text-[9px] font-semibold uppercase leading-4 tracking-wide text-brand">
              Gateway agent
            </span>
          ) : null}
        </div>
        <CloseButton onClose={() => onSelect(null)} />
      </header>

      {node.detached ? <DetachedPanel node={node} {...props} /> : null}

      {hint ? (
        <div className="px-4 pb-3">
          <Alert className="rounded-md border-status-warning/40 bg-status-warning/5">
            <Warning className="size-4 text-status-warning!" />
            <AlertDescription>
              <p data-old-agent-hint>{hint}</p>
              {editing && !addPortsOpen ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="mt-2"
                  onClick={() => props.onAddPortsNodeIdChange(node.id)}
                >
                  <Plus />
                  Add ports
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        </div>
      ) : null}

      {node.device ? (
        <DeviceSummary
          mac={node.device.mac.toLowerCase()}
          wired={wiredLine}
          onWifi={presence?.via === 'wifi' || wifiClient !== null}
        />
      ) : null}

      <Section title="Details">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <Fact label="Kind">{nodeKindWord(node, index.kinds)}</Fact>
          <Fact label="Agent">
            {node.binding
              ? `${node.binding.name} (${agentSoftware(node.binding)}, ${transportWord(node)})`
              : node.detached
                ? 'Removed'
                : 'None: drawn by hand'}
          </Fact>
          {node.binding ? <Fact label="Version">{version ?? 'unknown'}</Fact> : null}
          {node.binding ? <Fact label="Last report">{formatLastSeen(state?.lastSeenAt)}</Fact> : null}
          {node.model ? <Fact label="Model">{node.model}</Fact> : null}
          {parent ? <Fact label="Inside">{parent.name}</Fact> : null}
          {node.device ? (
            <>
              <Fact label="Device">{node.device.name ?? node.device.hostname ?? 'Unnamed'}</Fact>
              <Fact label="MAC" mono>
                {node.device.mac}
              </Fact>
              {node.device.primaryIp ? (
                <Fact label="Address" mono>
                  {node.device.primaryIp}
                </Fact>
              ) : null}
              {node.device.hostname && node.device.hostname !== node.device.name ? (
                <Fact label="Hostname">{node.device.hostname}</Fact>
              ) : null}
              {node.device.deviceType ? <Fact label="Type">{deviceTypeLabel(node.device.deviceType)}</Fact> : null}
              {node.device.connection ? (
                <Fact label="Marked">{connectionLabel(node.device.connection)}</Fact>
              ) : null}
              {wifiClient ? (
                <Fact label="On WiFi">
                  {wifiClient.ap} · {formatWifiBand(wifiClient.band)} · {formatSignal(wifiClient.signalDbm)}
                </Fact>
              ) : null}
            </>
          ) : null}
        </div>
        <NodeLinks node={node} isAdmin={isAdmin} />
      </Section>

      <Section
        title={`Ports (${node.ports.filter((port) => !port.hidden).length})`}
        action={
          editing && canAddPorts && !addPortsOpen ? (
            <Button type="button" size="xs" variant="ghost" onClick={() => props.onAddPortsNodeIdChange(node.id)}>
              <Plus />
              Add ports
            </Button>
          ) : null
        }
      >
        {editing && addPortsOpen ? (
          <AddPortsForm node={node} {...props} onClose={() => props.onAddPortsNodeIdChange(null)} />
        ) : null}
        <PortsList node={node} focusedPortId={focusedPortId} {...props} />
        {editing && node.kind === 'switch' && !node.binding && !node.detached ? (
          <PortCountForm node={node} {...props} />
        ) : null}
      </Section>

      {node.notes && !editing ? (
        <Section title="Notes">
          <p className="whitespace-pre-wrap text-xs">{node.notes}</p>
        </Section>
      ) : null}

      {editing ? (
        <>
          <Section title="Edit">
            {/* Starts over when a binding elsewhere renames the box. */}
            <NodeDetailsForm key={`${node.nameOverride ?? ''}|${node.device?.mac ?? ''}`} node={node} {...props} />
          </Section>
          {node.kind !== 'host' ? (
            <Section title="Inside host">
              <InsideHostSelect node={node} {...props} />
            </Section>
          ) : null}
          {canBindDevice(node) ? (
            <Section title="Device from Perch's list">
              <DeviceBinding node={node} {...props} />
            </Section>
          ) : null}
          <Section title="Remove">
            <RemoveNode node={node} {...props} />
          </Section>
        </>
      ) : null}
    </div>
  )
}

function NodeLinks({ node, isAdmin }: { node: InfraNode; isAdmin: boolean }) {
  const links: Array<{ to: string; label: string }> = []
  if (node.binding?.type === 'ap') links.push({ to: `/wifi/aps/${node.binding.id}`, label: 'Access point page' })
  if (node.binding?.type === 'collector') {
    links.push({ to: '/traffic', label: 'Gateway panel (Traffic)' })
    if (isAdmin) links.push({ to: '/settings/collectors', label: 'Settings → Collectors' })
  }
  if (node.detached && isAdmin) {
    links.push(
      node.kind === 'gateway'
        ? { to: '/settings/collectors', label: 'Settings → Collectors' }
        : { to: '/settings/wifi-sources', label: 'Settings → Wi-Fi sources' },
    )
  }
  if (links.length === 0) return null
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1">
      {links.map((link) => (
        <Link
          key={link.to + link.label}
          to={link.to}
          className="inline-flex items-center gap-1 text-xs text-brand underline-offset-2 hover:underline"
        >
          {link.label}
          <ArrowSquareOut aria-hidden className="size-3" />
        </Link>
      ))}
    </div>
  )
}

function DetachedPanel({ node, index, editing, onNotice, onSelect }: InspectorProps & { node: InfraNode }) {
  const bind = useBindInfraNode()
  const type = bindingTypeFor(node.kind)
  const candidates = type
    ? [...index.nodes.values()].filter((other) => other.id !== node.id && other.binding?.type === type)
    : []
  const [target, setTarget] = useState('')
  const [error, setError] = useState<string | null>(null)
  const what = type === 'collector' ? 'collector' : 'access point'

  function onBind() {
    const chosen = candidates.find((candidate) => String(candidate.binding?.id) === target)
    if (!chosen?.binding) return
    setError(null)
    bind.mutate(
      {
        id: node.id,
        payload: chosen.binding.type === 'collector' ? { collectorId: chosen.binding.id } : { apId: chosen.binding.id },
      },
      {
        onSuccess: ({ replacedNodeId }) => {
          onNotice({
            tone: 'info',
            text: `Bound to ${chosen.binding!.name}.${replacedNodeId !== null ? ' Its own box on the map was replaced by this one.' : ''}`,
          })
          onSelect({ type: 'node', id: node.id })
        },
        onError: (cause) => setError(infraErrorMessage(cause, index, 'Could not bind this device.', { nodeId: node.id })),
      },
    )
  }

  return (
    <div className="px-4 pb-3">
      <Alert className="rounded-md border-muted-foreground/30 bg-muted/40" data-detached-panel>
        <WarningCircle className="size-4" />
        <AlertTitle>Agent removed</AlertTitle>
        <AlertDescription>
          <p>
            The {what} this box was bound to is gone (deleted in Settings, or purged). Its ports and cables stay as
            they were last reported; they no longer light up.
          </p>
          {editing && type ? (
            candidates.length > 0 ? (
              <div className="mt-2 space-y-1">
                <div className="flex gap-2">
                  <NativeSelect
                    aria-label="Bind to"
                    value={target}
                    onChange={(event) => setTarget(event.target.value)}
                  >
                    <option value="">Bind to…</option>
                    {candidates.map((candidate) => {
                      const cables = cabledPortCount(candidate, index)
                      return (
                        <option key={candidate.id} value={candidate.binding!.id}>
                          {candidate.binding!.name}
                          {cables > 0 ? ` (its box has ${cables} ${cables === 1 ? 'cable' : 'cables'})` : ''}
                        </option>
                      )
                    })}
                  </NativeSelect>
                  <Button type="button" size="sm" disabled={!target || bind.isPending} onClick={onBind}>
                    {bind.isPending ? 'Binding…' : 'Bind'}
                  </Button>
                </div>
                <p className="text-[11px]">
                  The {what}&rsquo;s own box, if it has no cables, is replaced by this one; its ports light up again
                  from the next report.
                </p>
              </div>
            ) : (
              <p className="mt-2">
                No {what} to bind it to. Add it again in Settings, then bind this box to it, or delete the box.
              </p>
            )
          ) : null}
          <FieldError message={error} />
        </AlertDescription>
      </Alert>
    </div>
  )
}

function PortsList({
  node,
  focusedPortId,
  index,
  stateIndex,
  editing,
  connectPortId,
  onConnectPortIdChange,
  spotNear,
  onSelect,
  onNotice,
}: InspectorProps & { node: InfraNode; focusedPortId: number | null }) {
  const [editingPortId, setEditingPortId] = useState<number | null>(null)
  const update = useUpdateInfraPort()
  const visible = node.ports.filter((port) => !port.hidden)
  const hidden = node.ports.filter((port) => port.hidden)

  useEffect(() => {
    if (focusedPortId === null) return
    document.querySelector(`[data-port-row="${focusedPortId}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [focusedPortId])

  if (node.ports.length === 0) {
    return <p className="text-xs text-muted-foreground">No ports.</p>
  }
  return (
    <div className="space-y-2">
      {visible.length > 0 ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {visible.map((port) => {
            const state = stateIndex.ports.get(port.id)
            const led = portLed(port, state)
            const link = index.linkByPort.get(port.id)
            const facts = [
              port.role ? PORT_ROLE_LABELS[port.role] : null,
              port.medium ? PORT_MEDIUM_LABELS[port.medium] : null,
              port.origin === 'manual' ? 'added by hand' : null,
            ].filter(Boolean)
            return (
              <li
                key={port.id}
                data-port-row={port.id}
                className={cn('px-2.5 py-2 text-xs', focusedPortId === port.id && 'bg-brand/5')}
              >
                <div className="flex items-start gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      'relative mt-0.5 inline-block h-[14px] w-[18px] shrink-0 rounded-[3px] border bg-muted/80',
                      led === 'missing' ? 'border-dashed border-status-critical' : 'border-foreground/30',
                    )}
                  >
                    <span
                      className={cn('absolute inset-x-[2px] top-[2px] h-[3px] rounded-full', PORT_LED_CLASSES[led])}
                    />
                  </span>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="flex flex-wrap items-baseline gap-x-1.5">
                      <span className="font-mono font-medium">{port.label}</span>
                      {port.label !== port.key ? (
                        <span className="font-mono text-[11px] text-muted-foreground">{port.key}</span>
                      ) : null}
                      {facts.length > 0 ? (
                        <span className="text-[11px] text-muted-foreground">{facts.join(' · ')}</span>
                      ) : null}
                    </p>
                    <p className={led === 'missing' ? 'text-status-critical' : 'text-muted-foreground'}>
                      {portStateText(port, state)}
                    </p>
                    {link ? (
                      <button
                        type="button"
                        className="text-left text-brand underline-offset-2 hover:underline"
                        onClick={() => onSelect({ type: 'link', id: link.id })}
                      >
                        → {describePort(index, otherEnd(link, port.id).portId)}
                      </button>
                    ) : (
                      <p className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
                        No cable
                        {editing && port.present && connectPortId !== port.id ? (
                          <button
                            type="button"
                            data-connect-action={port.id}
                            className="inline-flex items-center gap-1 text-brand underline-offset-2 hover:underline"
                            onClick={() => onConnectPortIdChange(port.id)}
                          >
                            <PlugsConnected aria-hidden className="size-3" />
                            Connect a device…
                          </button>
                        ) : null}
                      </p>
                    )}
                  </div>
                  {editing ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Edit port ${port.label}`}
                      aria-expanded={editingPortId === port.id}
                      onClick={() => setEditingPortId((current) => (current === port.id ? null : port.id))}
                    >
                      <PencilSimple />
                    </Button>
                  ) : null}
                </div>
                {editing && editingPortId === port.id ? (
                  <PortEditor
                    port={port}
                    cabled={Boolean(link)}
                    index={index}
                    onNotice={onNotice}
                    onDone={() => setEditingPortId(null)}
                  />
                ) : null}
                {editing && connectPortId === port.id ? (
                  <ConnectDeviceForm
                    port={port}
                    node={node}
                    index={index}
                    spotNear={spotNear}
                    onNotice={onNotice}
                    onSelect={onSelect}
                    onDone={(created) => {
                      onConnectPortIdChange(null)
                      if (created) onSelect({ type: 'node', id: created.id })
                    }}
                  />
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
      {hidden.length > 0 ? (
        <div className="space-y-1 text-xs">
          <p className="text-muted-foreground">
            Hidden: {hidden.map((port) => port.label).join(', ')}
          </p>
          {editing ? (
            <div className="flex flex-wrap gap-1.5">
              {hidden.map((port) => (
                <Button
                  key={port.id}
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={update.isPending}
                  onClick={() =>
                    update.mutate(
                      { id: port.id, payload: { hidden: false } },
                      {
                        onError: (cause) =>
                          onNotice({
                            tone: 'error',
                            text: infraErrorMessage(cause, index, 'Could not show the port.'),
                          }),
                      },
                    )
                  }
                >
                  Show {port.label}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function PortEditor({
  port,
  cabled,
  index,
  onNotice,
  onDone,
}: {
  port: InfraPort
  cabled: boolean
  index: LayoutIndex
  onNotice: (notice: InfraNotice | null) => void
  onDone: () => void
}) {
  const update = useUpdateInfraPort()
  const remove = useDeleteInfraPort()
  const manual = port.origin === 'manual'
  const [key, setKey] = useState(port.key)
  const [label, setLabel] = useState(port.labelOverride ?? '')
  const [role, setRole] = useState<string>(port.roleOverride ?? '')
  const [medium, setMedium] = useState<string>(port.medium ?? (port.origin === 'manual' ? 'copper' : ''))
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const deletable = manual || !port.present

  function onSave(event: FormEvent) {
    event.preventDefault()
    const payload: UpdateInfraPortPayload = {}
    const nextKey = key.trim()
    if (manual && nextKey !== port.key) {
      if (!PORT_KEY_PATTERN.test(nextKey)) {
        setError('A port name is letters, digits and . _ @ : - (up to 32), starting with a letter or digit.')
        return
      }
      payload.key = nextKey
    }
    const nextLabel = label.trim() || null
    if (nextLabel && nextLabel.length > 48) {
      setError('A label is at most 48 characters.')
      return
    }
    if (nextLabel !== port.labelOverride) payload.label = nextLabel
    const nextRole = (role || null) as InfraPortRole | null
    if (nextRole !== port.roleOverride) payload.role = nextRole
    if (medium !== (port.medium ?? (manual ? 'copper' : ''))) {
      // An agent port's medium can go back to what the agent reads (A3.1).
      payload.medium = medium ? (medium as InfraPortMedium) : null
    }
    if (Object.keys(payload).length === 0) {
      onDone()
      return
    }
    setError(null)
    update.mutate(
      { id: port.id, payload },
      {
        onSuccess: () => {
          onNotice({ tone: 'info', text: `Port ${nextLabel ?? port.label} saved.` })
          onDone()
        },
        onError: (cause) => setError(infraErrorMessage(cause, index, 'Could not save the port.')),
      },
    )
  }

  return (
    <form onSubmit={onSave} className="mt-2 space-y-2 rounded-md bg-muted/40 p-2" noValidate>
      <div className="grid grid-cols-2 gap-2">
        {manual ? (
          <div className="space-y-1">
            <Label htmlFor={`port-key-${port.id}`}>Name</Label>
            <Input id={`port-key-${port.id}`} value={key} maxLength={32} onChange={(e) => setKey(e.target.value)} />
          </div>
        ) : null}
        <div className="space-y-1">
          <Label htmlFor={`port-label-${port.id}`}>Label</Label>
          <Input
            id={`port-label-${port.id}`}
            value={label}
            maxLength={48}
            placeholder={port.labelOverride ? port.key : port.label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`port-role-${port.id}`}>Role</Label>
          <NativeSelect id={`port-role-${port.id}`} value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">{manual ? 'None' : 'As the agent reports it'}</option>
            <option value="wan">WAN</option>
            <option value="lan">LAN</option>
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`port-medium-${port.id}`}>Medium</Label>
          <NativeSelect id={`port-medium-${port.id}`} value={medium} onChange={(e) => setMedium(e.target.value)}>
            {manual ? null : <option value="">As the agent reads it</option>}
            {(Object.keys(PORT_MEDIUM_LABELS) as InfraPortMedium[]).map((value) => (
              <option key={value} value={value}>
                {PORT_MEDIUM_LABELS[value]}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      <FieldError message={error} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={cabled || update.isPending}
            title={cabled ? 'Remove its cable first' : undefined}
            onClick={() =>
              update.mutate(
                { id: port.id, payload: { hidden: true } },
                {
                  onSuccess: () => {
                    onNotice({ tone: 'info', text: `Port ${port.label} is hidden.` })
                    onDone()
                  },
                  onError: (cause) => setError(infraErrorMessage(cause, index, 'Could not hide the port.')),
                },
              )
            }
          >
            <EyeSlash />
            Hide
          </Button>
          {deletable ? (
            <Button type="button" size="xs" variant="destructive" onClick={() => setConfirmDelete(true)}>
              <Trash />
              Delete
            </Button>
          ) : null}
        </div>
        <div className="flex gap-1.5">
          <Button type="button" size="xs" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" size="xs" disabled={update.isPending}>
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
      {cabled ? <p className="text-[11px] text-muted-foreground">It has a cable: remove the cable to hide the port.</p> : null}
      {!deletable ? (
        <p className="text-[11px] text-muted-foreground">The agent still reports this port; hide it instead.</p>
      ) : null}
      {confirmDelete ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-[11px]">
          <span className="flex-1">
            Delete port {port.label}
            {cabled ? ' and its cable' : ''}?
          </span>
          <Button
            type="button"
            size="xs"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(port.id, {
                onSuccess: () => {
                  onNotice({ tone: 'info', text: `Port ${port.label} deleted.` })
                  onDone()
                },
                onError: (cause) => {
                  setConfirmDelete(false)
                  setError(infraErrorMessage(cause, index, 'Could not delete the port.'))
                },
              })
            }
          >
            {remove.isPending ? 'Deleting…' : 'Delete port'}
          </Button>
          <Button type="button" size="xs" variant="outline" onClick={() => setConfirmDelete(false)}>
            Keep it
          </Button>
        </div>
      ) : null}
    </form>
  )
}

function AddPortsForm({
  node,
  index,
  onNotice,
  onClose,
}: InspectorProps & { node: InfraNode; onClose: () => void }) {
  const add = useAddInfraPorts()
  const [text, setText] = useState(() => suggestPortKeys(node).join(', '))
  const [medium, setMedium] = useState<InfraPortMedium>('copper')
  const [error, setError] = useState<string | null>(null)
  const agentNode = node.binding !== null || node.detached

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    const keys = parsePortKeys(text)
    if (keys.length === 0) {
      setError('Type at least one port name.')
      return
    }
    const invalid = keys.find((key) => !PORT_KEY_PATTERN.test(key))
    if (invalid) {
      setError(`"${invalid}" is not a port name: letters, digits and . _ @ : - (up to 32), starting with a letter or digit.`)
      return
    }
    const taken = keys.filter((key) => node.ports.some((port) => port.key === key))
    if (taken.length > 0) {
      setError(`${taken.join(', ')} ${taken.length === 1 ? 'is' : 'are'} already on this device.`)
      return
    }
    setError(null)
    add.mutate(
      {
        nodeId: node.id,
        ports: keys.map((key) => ({ key, role: inferPortRole(key), medium })),
      },
      {
        onSuccess: ({ ports }) => {
          onNotice({
            tone: 'info',
            text: `Added ${ports.length} ${ports.length === 1 ? 'port' : 'ports'} to ${node.name}.`,
          })
          onClose()
        },
        onError: (cause) => setError(infraErrorMessage(cause, index, 'Could not add the ports.')),
      },
    )
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2 rounded-md border border-border p-2.5" noValidate data-add-ports-form>
      <div className="grid grid-cols-[1fr_7rem] gap-2">
        <div className="space-y-1">
          <Label htmlFor={`add-ports-${node.id}`}>Port names</Label>
          <Input
            id={`add-ports-${node.id}`}
            autoFocus
            value={text}
            placeholder="wan, lan1, lan2"
            onChange={(event) => setText(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`add-ports-medium-${node.id}`}>Medium</Label>
          <NativeSelect
            id={`add-ports-medium-${node.id}`}
            value={medium}
            onChange={(event) => setMedium(event.target.value as InfraPortMedium)}
          >
            {(Object.keys(PORT_MEDIUM_LABELS) as InfraPortMedium[]).map((value) => (
              <option key={value} value={value}>
                {PORT_MEDIUM_LABELS[value]}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {agentNode
          ? 'Use the names the agent will report, as LuCI shows them (wan, lan1, lan2…): when the agent is upgraded it adopts these ports, cables and all.'
          : 'Separate names with commas. Names starting with wan or lan get that role.'}
      </p>
      <FieldError message={error} />
      <div className="flex justify-end gap-1.5">
        <Button type="button" size="xs" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={add.isPending}>
          {add.isPending ? 'Adding…' : 'Add ports'}
        </Button>
      </div>
    </form>
  )
}

function PortCountForm({ node, index, onNotice }: InspectorProps & { node: InfraNode }) {
  const update = useUpdateInfraNode()
  const numbered = node.ports.filter((port) => /^\d+$/.test(port.key)).length
  const [value, setValue] = useState(String(numbered))
  const [error, setError] = useState<string | null>(null)

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    const count = Number(value)
    if (!Number.isInteger(count) || count < 1 || count > 64) {
      setError('Between 1 and 64.')
      return
    }
    if (count === numbered) return
    setError(null)
    update.mutate(
      { id: node.id, payload: { portCount: count } },
      {
        onSuccess: () => onNotice({ tone: 'info', text: `${node.name} now has ${count} numbered ports.` }),
        onError: (cause) => setError(infraErrorMessage(cause, index, 'Could not change the port count.')),
      },
    )
  }

  return (
    <form onSubmit={onSubmit} className="space-y-1 pt-1" noValidate>
      <Label htmlFor={`port-count-${node.id}`}>Numbered ports</Label>
      <div className="flex gap-2">
        <Input
          id={`port-count-${node.id}`}
          type="number"
          inputMode="numeric"
          min={1}
          max={64}
          value={value}
          className="w-24"
          onChange={(event) => setValue(event.target.value)}
        />
        <Button type="submit" size="sm" variant="outline" disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Apply'}
        </Button>
      </div>
      <FieldError message={error} />
    </form>
  )
}

function NodeDetailsForm({ node, index, onNotice }: InspectorProps & { node: InfraNode }) {
  const update = useUpdateInfraNode()
  const followsAgent = node.source === 'agent'
  // A4.3: a manual box bound to a device may go nameless and follow the device's name.
  const followsDevice = !followsAgent && node.device !== null
  const followsSomething = followsAgent || followsDevice
  const [name, setName] = useState(node.nameOverride ?? (followsSomething ? '' : node.name))
  const [model, setModel] = useState(node.model ?? '')
  const [notes, setNotes] = useState(node.notes ?? '')
  const [virtual, setVirtual] = useState(node.virtual)
  const [error, setError] = useState<string | null>(null)
  const withVirtual = node.kind === 'switch' || node.kind === 'host'
  const followedName = followsAgent
    ? (node.binding?.name ?? node.name)
    : (node.device?.name ?? node.device?.hostname ?? node.device?.mac ?? node.name)

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    const payload: UpdateInfraNodePayload = {}
    const nextName = name.trim() || null
    if (!nextName && !followsSomething) {
      setError('Give it a name.')
      return
    }
    if ((nextName?.length ?? 0) > 80 || model.trim().length > 80) {
      setError('Names and models are at most 80 characters.')
      return
    }
    if (notes.trim().length > 500) {
      setError('Notes are at most 500 characters.')
      return
    }
    const currentName = node.nameOverride ?? (followsSomething ? null : node.name)
    if (nextName !== currentName) payload.name = nextName
    const nextModel = model.trim() || null
    if (nextModel !== node.model) payload.model = nextModel
    const nextNotes = notes.trim() || null
    if (nextNotes !== node.notes) payload.notes = nextNotes
    if (withVirtual && virtual !== node.virtual) payload.virtual = virtual
    if (Object.keys(payload).length === 0) return
    setError(null)
    update.mutate(
      { id: node.id, payload },
      {
        onSuccess: ({ node: saved }) => onNotice({ tone: 'info', text: `${saved.name} saved.` }),
        onError: (cause) => setError(infraErrorMessage(cause, index, 'Could not save the changes.')),
      },
    )
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2" noValidate data-node-form>
      <div className="space-y-1">
        <Label htmlFor={`node-name-${node.id}`}>Name</Label>
        <Input
          id={`node-name-${node.id}`}
          value={name}
          maxLength={80}
          placeholder={followsSomething ? followedName : undefined}
          onChange={(event) => setName(event.target.value)}
        />
        {followsSomething ? (
          <p className="text-[11px] text-muted-foreground">
            Leave empty to use the {followsAgent ? 'agent' : 'device'}&rsquo;s name.
          </p>
        ) : null}
      </div>
      <div className="space-y-1">
        <Label htmlFor={`node-model-${node.id}`}>Model</Label>
        <Input
          id={`node-model-${node.id}`}
          value={model}
          maxLength={80}
          onChange={(event) => setModel(event.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`node-notes-${node.id}`}>Notes</Label>
        <textarea
          id={`node-notes-${node.id}`}
          value={notes}
          maxLength={500}
          rows={3}
          className="w-full min-w-0 resize-y rounded-none border border-input bg-transparent px-2.5 py-1.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30"
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>
      {withVirtual ? (
        <label className="flex items-center justify-between gap-3 text-xs">
          {node.kind === 'switch' ? 'Bridge / vSwitch' : 'Virtual machine'}
          <Switch
            checked={virtual}
            onCheckedChange={setVirtual}
            aria-label={node.kind === 'switch' ? 'Bridge / vSwitch' : 'Virtual machine'}
          />
        </label>
      ) : null}
      <FieldError message={error} />
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  )
}

function InsideHostSelect({ node, layout, index, onNotice, outsideFrame }: InspectorProps & { node: InfraNode }) {
  const update = useUpdateInfraNode()
  const hosts = layout.nodes.filter((other) => other.kind === 'host' && other.id !== node.id)
  const [error, setError] = useState<string | null>(null)

  if (hosts.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No host on the map. Add one (Add device → {index.kinds.find((kind) => kind.kind === 'host')?.label ?? 'Host'}) to
        draw a server with the gateway and bridges inside it.
      </p>
    )
  }

  function onChange(value: string) {
    const next = value ? Number(value) : null
    if (next === node.parentId) return
    setError(null)
    let payload: UpdateInfraNodePayload
    if (next === null) {
      // Out of the frame: just right of it, at the same height.
      const at = outsideFrame(node.id)
      payload = { parentId: null, position: at }
    } else {
      // Into a frame: the page lays it out inside until someone moves it.
      payload = { parentId: next, position: null }
    }
    update.mutate(
      { id: node.id, payload },
      {
        onSuccess: () =>
          onNotice({
            tone: 'info',
            text:
              next === null
                ? `${node.name} is no longer inside a host.`
                : `${node.name} is now inside ${index.nodes.get(next)?.name ?? 'the host'}.`,
          }),
        onError: (cause) => setError(infraErrorMessage(cause, index, 'Could not move it.')),
      },
    )
  }

  return (
    <div className="space-y-1">
      <NativeSelect
        aria-label="Inside host"
        value={node.parentId ?? ''}
        disabled={update.isPending}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Not inside a host</option>
        {hosts.map((host) => (
          <option key={host.id} value={host.id}>
            {host.name}
          </option>
        ))}
      </NativeSelect>
      <p className="text-[11px] text-muted-foreground">
        A gateway in a container or VM, and the bridges it plugs into, sit inside their host&rsquo;s frame.
      </p>
      <FieldError message={error} />
    </div>
  )
}

/**
 * A4.1 "Bind to a device…": any manual box but an ISP line can stand for a
 * device Perch knows; it then shows the device's presence (and its name, when
 * the box has none of its own).
 */
function DeviceBinding({ node, index, onNotice, onSelect }: InspectorProps & { node: InfraNode }) {
  const update = useUpdateInfraNode()
  const [picking, setPicking] = useState(false)
  // A box named by hand keeps its name unless asked; a plain device box usually is the device.
  const [takeName, setTakeName] = useState(node.kind === 'device')
  const [refusal, setRefusal] = useState<unknown>(null)
  const placed = useMemo(() => placedDevices(index), [index])
  const containerRef = useRef<HTMLDivElement>(null)
  const holderId = placedRefusalNodeId(refusal)
  // Named once the layout refetch that follows the refusal has the box.
  const holderName = holderId !== null ? index.nodes.get(holderId)?.name : undefined

  function save(deviceMac: string | null, label: string | null) {
    setRefusal(null)
    const payload: UpdateInfraNodePayload = { deviceMac }
    if (deviceMac && takeName && node.nameOverride !== null) payload.name = null
    const before = node.name
    update.mutate(
      { id: node.id, payload },
      {
        onSuccess: ({ node: saved }) => {
          setPicking(false)
          onNotice({
            tone: 'info',
            text: deviceMac
              ? `${before} is bound to ${label ?? deviceMac}${saved.name !== before ? ` and is now called ${saved.name}` : ''}.`
              : `${before} is no longer bound to a device.`,
          })
        },
        onError: (cause) => {
          setRefusal(cause)
          window.requestAnimationFrame(() =>
            containerRef.current?.querySelector('[data-binding-error]')?.scrollIntoView({ block: 'nearest' }),
          )
        },
      },
    )
  }

  return (
    <div ref={containerRef} className="space-y-2 text-xs" data-device-binding>
      {node.device ? (
        <p>
          {node.device.name ?? node.device.hostname ?? 'Unnamed device'}{' '}
          <span className="font-mono text-muted-foreground">{node.device.mac}</span>
        </p>
      ) : (
        <p className="text-muted-foreground">Not bound: the box shows no presence.</p>
      )}
      <div className="flex flex-wrap gap-1.5">
        <Button
          type="button"
          size="xs"
          variant="outline"
          aria-expanded={picking}
          onClick={() => setPicking((value) => !value)}
        >
          {node.device ? 'Change device…' : 'Bind to a device…'}
        </Button>
        {node.device ? (
          <Button type="button" size="xs" variant="ghost" disabled={update.isPending} onClick={() => save(null, null)}>
            Unbind
          </Button>
        ) : null}
      </div>
      {picking ? (
        <div className="space-y-2">
          <DevicePicker
            selectedMac={node.device?.mac ?? null}
            placed={placed}
            ownNodeId={node.id}
            autoFocus
            onPick={(device) => save(device.mac.toLowerCase(), deviceDisplayName(device))}
          />
          {node.nameOverride !== null ? (
            <label className="flex items-center justify-between gap-3">
              <span>
                Use the device&rsquo;s name
                <span className="block text-[11px] text-muted-foreground">
                  Instead of &ldquo;{node.nameOverride}&rdquo;; the box then follows the device.
                </span>
              </span>
              <Switch checked={takeName} onCheckedChange={setTakeName} aria-label="Use the device's name" />
            </label>
          ) : null}
        </div>
      ) : null}
      {refusal !== null ? (
        <div className="space-y-1.5" role="alert" data-binding-error>
          <FieldError message={infraErrorMessage(refusal, index, 'Could not change the device.', { nodeId: node.id })} />
          {holderId !== null ? (
            <Button type="button" size="xs" variant="outline" onClick={() => onSelect({ type: 'node', id: holderId })}>
              {holderName ? `Show ${holderName}` : 'Show that box'}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function RemoveNode({ node, index, onNotice, onSelect }: InspectorProps & { node: InfraNode }) {
  const update = useUpdateInfraNode()
  const remove = useDeleteInfraNode()
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bound = node.binding !== null
  const cables = cabledPortCount(node, index)
  const inside = [...index.nodes.values()].filter((other) => other.parentId === node.id).length

  function setHidden(hidden: boolean) {
    setError(null)
    update.mutate(
      { id: node.id, payload: { hidden } },
      {
        onSuccess: () => {
          if (hidden) {
            onNotice({ tone: 'info', text: `${node.name} is hidden. Bring it back from Hidden in the header.` })
            onSelect(null)
          } else {
            onNotice({ tone: 'info', text: `${node.name} is back on the map.` })
          }
        },
        onError: (cause) => setError(infraErrorMessage(cause, index, hidden ? 'Could not hide it.' : 'Could not show it.')),
      },
    )
  }

  function destroy() {
    setError(null)
    remove.mutate(node.id, {
      onSuccess: () => {
        onNotice({ tone: 'info', text: `${node.name} deleted.` })
        onSelect(null)
      },
      onError: (cause) => {
        setConfirm(false)
        setError(infraErrorMessage(cause, index, 'Could not delete it.', { nodeId: node.id }))
      },
    })
  }

  const parts = [
    node.ports.length > 0 ? `${node.ports.length} ${node.ports.length === 1 ? 'port' : 'ports'}` : null,
    cables > 0 ? `${cables} ${cables === 1 ? 'cable' : 'cables'}` : null,
  ].filter((part): part is string => part !== null)
  const single = parts.length === 1 && (node.ports.length === 1 || (node.ports.length === 0 && cables === 1))
  const consequences = parts.length > 0 ? `Its ${parts.join(' and ')} ${single ? 'goes' : 'go'} with it` : null

  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap gap-1.5">
        {node.hidden ? (
          <Button type="button" size="xs" variant="outline" disabled={update.isPending} onClick={() => setHidden(false)}>
            <Eye />
            Show on the map
          </Button>
        ) : (
          <Button type="button" size="xs" variant="outline" disabled={update.isPending} onClick={() => setHidden(true)}>
            <EyeSlash />
            Hide from the map
          </Button>
        )}
        {!bound ? (
          <Button type="button" size="xs" variant="destructive" onClick={() => setConfirm(true)}>
            <Trash />
            Delete
          </Button>
        ) : null}
      </div>
      {bound ? (
        <p className="text-[11px] text-muted-foreground">
          {node.binding!.type === 'collector'
            ? `This is the Gateway agent ${node.binding!.name}: deleted here, it would come straight back. Remove the collector in Settings → Collectors, or hide it here.`
            : `This is the AP ${node.binding!.name}: deleted here, it would come straight back. Remove it in Settings → Wi-Fi sources, or hide it here.`}
        </p>
      ) : null}
      {confirm ? (
        <Alert variant="destructive" className="rounded-md border-destructive/30 bg-destructive/5" data-delete-confirm>
          <WarningCircle className="size-4" />
          <AlertTitle>Delete {node.name}?</AlertTitle>
          <AlertDescription>
            <p>
              {consequences ? `${consequences}${inside > 0 ? '; ' : '. '}` : ''}
              {inside > 0
                ? `${consequences ? 'the' : 'The'} ${inside} ${inside === 1 ? 'device' : 'devices'} inside it ${inside === 1 ? 'stays' : 'stay'} on the map. `
                : ''}
              This cannot be undone.
            </p>
            <div className="mt-2 flex gap-1.5">
              <Button type="button" size="xs" variant="destructive" disabled={remove.isPending} onClick={destroy}>
                {remove.isPending ? 'Deleting…' : 'Delete'}
              </Button>
              <Button type="button" size="xs" variant="outline" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
      <FieldError message={error} />
    </div>
  )
}

// ── Cable ────────────────────────────────────────────────────────────────

function CableEnd({
  end,
  index,
  stateIndex,
  onSelect,
}: {
  end: InfraLink['a']
  index: LayoutIndex
  stateIndex: StateIndex
  onSelect: (selection: InfraSelection | null) => void
}) {
  const port = index.ports.get(end.portId)
  const node = index.nodes.get(end.nodeId)
  if (!port || !node) return <p className="text-xs text-muted-foreground">A port that is gone</p>
  const state = stateIndex.ports.get(port.id)
  const led = portLed(port, state)
  return (
    <button
      type="button"
      className="flex w-full items-start gap-2 rounded-md border border-border px-2.5 py-2 text-left text-xs hover:bg-muted/50"
      onClick={() => onSelect({ type: 'node', id: node.id, portId: port.id })}
    >
      <span
        aria-hidden
        className={cn(
          'relative mt-0.5 inline-block h-[14px] w-[18px] shrink-0 rounded-[3px] border bg-muted/80',
          led === 'missing' ? 'border-dashed border-status-critical' : 'border-foreground/30',
        )}
      >
        <span className={cn('absolute inset-x-[2px] top-[2px] h-[3px] rounded-full', PORT_LED_CLASSES[led])} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">
          {node.name} · {portDisplayName(port)}
        </span>
        <span className={cn('block', led === 'missing' ? 'text-status-critical' : 'text-muted-foreground')}>
          {portStateText(port, state)}
        </span>
      </span>
    </button>
  )
}

function mismatchExplanation(link: InfraLink, index: LayoutIndex, stateIndex: StateIndex, detail: string | null) {
  const a = describePort(index, link.a.portId)
  const b = describePort(index, link.b.portId)
  const aState = stateIndex.ports.get(link.a.portId)
  const bState = stateIndex.ports.get(link.b.portId)
  if (detail === 'speed') {
    const aSpeed = formatPortSpeed(aState?.speedMbps) ?? 'one speed'
    const bSpeed = formatPortSpeed(bState?.speedMbps) ?? 'another'
    return `${a} runs at ${aSpeed} and ${b} at ${bSpeed}. Check which ports this cable really joins, or the cable itself.`
  }
  const [up, down] = aState?.up ? [a, b] : [b, a]
  return `${up} has a link and ${down} has none: this cable is probably not between these two ports. Drag an end of the cable to the port it really uses.`
}

function CableInspector({ link, ...props }: InspectorProps & { link: InfraLink }) {
  const { index, stateIndex, editing, onSelect, onNotice } = props
  const linkState = stateIndex.links.get(link.id)
  const update = useUpdateInfraLink()
  const remove = useDeleteInfraLink()
  const [medium, setMedium] = useState<InfraLinkMedium>(link.medium)
  const [label, setLabel] = useState(link.label ?? '')
  const [notes, setNotes] = useState(link.notes ?? '')
  const [error, setError] = useState<string | null>(null)
  const mismatch = linkState?.state === 'mismatch'

  function onSave(event: FormEvent) {
    event.preventDefault()
    const payload: UpdateInfraLinkPayload = {}
    if (medium !== link.medium) payload.medium = medium
    const nextLabel = label.trim() || null
    if (nextLabel && nextLabel.length > 48) {
      setError('A label is at most 48 characters.')
      return
    }
    if (nextLabel !== link.label) payload.label = nextLabel
    const nextNotes = notes.trim() || null
    if (nextNotes !== link.notes) payload.notes = nextNotes
    if (Object.keys(payload).length === 0) return
    setError(null)
    update.mutate(
      { id: link.id, payload },
      {
        onSuccess: () => onNotice({ tone: 'info', text: 'Cable saved.' }),
        onError: (cause) => setError(infraErrorMessage(cause, index, 'Could not save the cable.')),
      },
    )
  }

  function destroy() {
    const text = describeLink(index, link.id)
    remove.mutate(link.id, {
      onSuccess: () => onNotice({ tone: 'info', text: `Cable removed: ${text}.` }),
      onError: (cause) => setError(infraErrorMessage(cause, index, 'Could not remove the cable.')),
    })
    onSelect(null)
  }

  return (
    <div className="flex flex-col pb-2" data-inspector="link">
      <header className="flex items-start gap-2 px-4 pt-3 pb-3">
        <PlugsConnected aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <h2 className="text-sm font-semibold">Cable</h2>
          <p className="text-xs text-muted-foreground">
            {LINK_MEDIUM_LABELS[link.medium]}
            {link.label ? ` · ${link.label}` : ''}
          </p>
          <p className={cn('text-xs', mismatch ? 'font-medium text-status-critical' : 'text-muted-foreground')}>
            {linkStateText(linkState)}
          </p>
        </div>
        <CloseButton onClose={() => onSelect(null)} />
      </header>
      {mismatch ? (
        <div className="px-4 pb-3">
          <Alert variant="destructive" className="rounded-md border-status-critical/40 bg-status-critical/5">
            <Warning className="size-4" />
            <AlertTitle>{linkState?.detail === 'speed' ? 'Speed mismatch' : 'Carrier mismatch'}</AlertTitle>
            <AlertDescription>{mismatchExplanation(link, index, stateIndex, linkState?.detail ?? null)}</AlertDescription>
          </Alert>
        </div>
      ) : null}
      <Section title="Ends">
        <div className="space-y-1.5">
          <CableEnd end={link.a} index={index} stateIndex={stateIndex} onSelect={onSelect} />
          <CableEnd end={link.b} index={index} stateIndex={stateIndex} onSelect={onSelect} />
        </div>
      </Section>
      {!editing && link.notes ? (
        <Section title="Notes">
          <p className="whitespace-pre-wrap text-xs">{link.notes}</p>
        </Section>
      ) : null}
      {editing ? (
        <Section title="Edit">
          <form onSubmit={onSave} className="space-y-2" noValidate>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor={`link-medium-${link.id}`}>Medium</Label>
                <NativeSelect
                  id={`link-medium-${link.id}`}
                  value={medium}
                  onChange={(event) => setMedium(event.target.value as InfraLinkMedium)}
                >
                  {(Object.keys(LINK_MEDIUM_LABELS) as InfraLinkMedium[]).map((value) => (
                    <option key={value} value={value}>
                      {LINK_MEDIUM_LABELS[value]}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`link-label-${link.id}`}>Label</Label>
                <Input
                  id={`link-label-${link.id}`}
                  value={label}
                  maxLength={48}
                  placeholder="Run to the garage"
                  onChange={(event) => setLabel(event.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`link-notes-${link.id}`}>Notes</Label>
              <textarea
                id={`link-notes-${link.id}`}
                value={notes}
                maxLength={500}
                rows={2}
                className="w-full min-w-0 resize-y rounded-none border border-input bg-transparent px-2.5 py-1.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30"
                onChange={(event) => setNotes(event.target.value)}
              />
            </div>
            <FieldError message={error} />
            <div className="flex justify-between gap-2">
              <Button type="button" size="sm" variant="destructive" disabled={remove.isPending} onClick={destroy}>
                <Trash />
                Remove cable
              </Button>
              <Button type="submit" size="sm" disabled={update.isPending}>
                {update.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              To move an end, drag it on the map from its port to another port while the cable is selected. The Delete key
              removes the selected cable too.
            </p>
          </form>
        </Section>
      ) : null}
    </div>
  )
}
