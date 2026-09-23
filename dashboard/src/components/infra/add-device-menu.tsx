import { useState, type FormEvent } from 'react'
import { ArrowLeft, Plus } from '@phosphor-icons/react'
import { DevicePicker, DeviceTypeOffer } from '@/components/infra/device-picker'
import type { InfraNotice } from '@/components/infra/infra-canvas'
import { KindIcon } from '@/components/infra/kind-icon'
import { NativeSelect } from '@/components/infra/native-select'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { useSaveDeviceLabel } from '@/hooks/use-device-labels'
import { useCreateInfraNode } from '@/hooks/use-infra'
import { fieldErrorsFromApi } from '@/lib/api'
import { deviceDisplayName } from '@/lib/device-labels'
import { infraErrorMessage, type LayoutIndex } from '@/lib/infra'
import { cn } from '@/lib/utils'
import type {
  CreateInfraNodePayload,
  DeviceSummary,
  DeviceType,
  InfraKindInfo,
  InfraNode,
  InfraNodeKind,
} from '@/types/api'

const NAME_PLACEHOLDERS: Partial<Record<InfraNodeKind, string>> = {
  switch: 'Garage switch',
  router: 'Upstairs router',
  modem: 'Fibre modem',
  isp: 'ISP line',
  host: 'Home server',
  device: 'NAS',
  access_point: 'Attic AP',
}

function parseCount(value: string, min: number, max: number): number | null {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null
  return parsed
}

type AddDeviceFormProps = {
  info: InfraKindInfo
  hosts: InfraNode[]
  /** The loaded map: devices that already have a box cannot be picked again (A4.2). */
  index: LayoutIndex
  placed: ReadonlyMap<string, InfraNode>
  dropPosition: () => { x: number; y: number } | null
  onBack: () => void
  onCreated: (node: InfraNode) => void
  onNotice: (notice: InfraNotice | null) => void
}

function AddDeviceForm({ info, hosts, index, placed, dropPosition, onBack, onCreated, onNotice }: AddDeviceFormProps) {
  const create = useCreateInfraNode()
  const saveLabel = useSaveDeviceLabel()
  const [name, setName] = useState('')
  const [portCount, setPortCount] = useState(String(info.ports.default))
  const [sfpPorts, setSfpPorts] = useState('0')
  const [virtual, setVirtual] = useState(false)
  const [model, setModel] = useState('')
  const [parentId, setParentId] = useState('')
  const [device, setDevice] = useState<DeviceSummary | null>(null)
  const [deviceType, setDeviceType] = useState<DeviceType | ''>('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  // The catalog decides (A3.10: switches and hosts have SFP cages).
  const withSfp = info.supportsSfp
  const fixedCount = info.ports.min === info.ports.max
  const withVirtual = info.kind === 'switch' || info.kind === 'host'
  const withParent = info.kind !== 'host' && hosts.length > 0
  const withDevice = info.kind === 'device'
  // A4.3: a box bound to a device may go without a name; it then follows the device's.
  const nameOptional = withDevice && device !== null

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    const nextErrors: Record<string, string> = {}
    const trimmed = name.trim()
    if (!trimmed && !nameOptional) {
      nextErrors.name = withDevice ? 'Give it a name, or pick a device from the list.' : 'Give it a name.'
    } else if (trimmed.length > 80) nextErrors.name = 'At most 80 characters.'
    const ports = parseCount(portCount, info.ports.min, info.ports.max)
    if (ports === null) nextErrors.portCount = `Between ${info.ports.min} and ${info.ports.max}.`
    const sfp = withSfp ? parseCount(sfpPorts, 0, 8) : 0
    if (sfp === null) nextErrors.sfpPorts = 'Between 0 and 8.'
    if (model.trim().length > 80) nextErrors.model = 'At most 80 characters.'
    setErrors(nextErrors)
    setFormError(null)
    if (Object.keys(nextErrors).length > 0) return

    const payload: CreateInfraNodePayload = {
      kind: info.kind as CreateInfraNodePayload['kind'],
      portCount: ports!,
    }
    if (trimmed) payload.name = trimmed
    if (withSfp && sfp) payload.sfpPorts = sfp
    if (withVirtual && virtual) payload.virtual = true
    if (model.trim()) payload.model = model.trim()
    if (withDevice && device) payload.deviceMac = device.mac.toLowerCase()
    if (withParent && parentId) {
      payload.parentId = Number(parentId)
    } else {
      // A new box lands in the middle of what is on screen; inside a host the page places it.
      const at = dropPosition()
      if (at) payload.position = at
    }
    const type = withDevice && device && !device.deviceType ? deviceType || null : null
    create.mutate(payload, {
      onSuccess: ({ node }) => {
        if (type && device) {
          saveLabel.mutate(
            { mac: device.mac.toLowerCase(), payload: { deviceType: type } },
            {
              onError: (cause) =>
                onNotice({ tone: 'error', text: `Added ${node.name}, but its type could not be saved: ${cause.message}` }),
            },
          )
        }
        onCreated(node)
      },
      onError: (error) => {
        setErrors(fieldErrorsFromApi(error))
        setFormError(infraErrorMessage(error, index, 'Could not add the device.'))
      },
    })
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3" noValidate>
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Back to the list" onClick={onBack}>
          <ArrowLeft />
        </Button>
        <KindIcon kind={info.kind} className="size-4 text-muted-foreground" />
        <p className="text-[13px] font-semibold">{info.label}</p>
      </div>

      {withDevice ? (
        // A4.1: "Add device → Device" starts with the device picker.
        <div className="space-y-1">
          <p className="text-xs">
            Device from Perch&rsquo;s list <span className="text-muted-foreground">(optional)</span>
          </p>
          <DevicePicker
            selectedMac={device?.mac ?? null}
            placed={placed}
            autoFocus
            onPick={(picked) => {
              setDevice(picked)
              setDeviceType('')
              if (errors.name) setErrors((current) => ({ ...current, name: '' }))
            }}
          />
          {device ? (
            <p className="text-[11px] text-muted-foreground">
              Bound to <span className="font-mono">{device.mac}</span>: the box shows its name, type and whether it is
              connected.
            </p>
          ) : null}
        </div>
      ) : null}

      {withDevice && device && !device.deviceType ? (
        <DeviceTypeOffer id="infra-add-type" value={deviceType} onChange={setDeviceType} />
      ) : null}

      <div className="space-y-1">
        <Label htmlFor="infra-add-name">
          Name {nameOptional ? <span className="text-muted-foreground">(optional)</span> : null}
        </Label>
        <Input
          id="infra-add-name"
          autoFocus={!withDevice}
          value={name}
          maxLength={80}
          placeholder={nameOptional && device ? deviceDisplayName(device) : (NAME_PLACEHOLDERS[info.kind] ?? info.label)}
          aria-invalid={Boolean(errors.name)}
          onChange={(event) => {
            setName(event.target.value)
            if (errors.name) setErrors((current) => ({ ...current, name: '' }))
          }}
        />
        {errors.name ? <p className="text-[11px] text-destructive">{errors.name}</p> : null}
        {nameOptional ? (
          <p className="text-[11px] text-muted-foreground">Leave it empty and the box follows the device&rsquo;s name.</p>
        ) : null}
      </div>

      <div className={cn('grid gap-2', withSfp && !fixedCount ? 'grid-cols-2' : 'grid-cols-1')}>
        <div className={cn('space-y-1', fixedCount && 'hidden')}>
          <Label htmlFor="infra-add-ports">{info.kind === 'host' ? 'Ports (its NICs)' : 'Ports'}</Label>
          <Input
            id="infra-add-ports"
            type="number"
            inputMode="numeric"
            min={info.ports.min}
            max={info.ports.max}
            value={portCount}
            aria-invalid={Boolean(errors.portCount)}
            onChange={(event) => {
              setPortCount(event.target.value)
              if (errors.portCount) setErrors((current) => ({ ...current, portCount: '' }))
            }}
          />
          {errors.portCount ? <p className="text-[11px] text-destructive">{errors.portCount}</p> : null}
        </div>
        {withSfp ? (
          <div className="space-y-1">
            <Label htmlFor="infra-add-sfp">SFP ports</Label>
            <Input
              id="infra-add-sfp"
              type="number"
              inputMode="numeric"
              min={0}
              max={8}
              value={sfpPorts}
              aria-invalid={Boolean(errors.sfpPorts)}
              onChange={(event) => setSfpPorts(event.target.value)}
            />
            {errors.sfpPorts ? <p className="text-[11px] text-destructive">{errors.sfpPorts}</p> : null}
          </div>
        ) : null}
      </div>

      {withVirtual ? (
        <label className="flex items-center justify-between gap-3 text-xs">
          <span>
            {info.kind === 'switch' ? 'Bridge / vSwitch' : 'Virtual machine'}
            <span className="block text-[11px] text-muted-foreground">
              {info.kind === 'switch' ? 'A Linux bridge or vSwitch inside a host' : 'A VM rather than hardware'}
            </span>
          </span>
          <Switch
            checked={virtual}
            onCheckedChange={setVirtual}
            aria-label={info.kind === 'switch' ? 'Bridge / vSwitch' : 'Virtual machine'}
          />
        </label>
      ) : null}

      <div className="space-y-1">
        <Label htmlFor="infra-add-model">
          Model <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id="infra-add-model"
          value={model}
          maxLength={80}
          placeholder={info.kind === 'switch' ? '8-port desktop switch' : undefined}
          onChange={(event) => setModel(event.target.value)}
        />
        {errors.model ? <p className="text-[11px] text-destructive">{errors.model}</p> : null}
      </div>

      {withParent ? (
        <div className="space-y-1">
          <Label htmlFor="infra-add-parent">Inside host</Label>
          <NativeSelect
            id="infra-add-parent"
            value={parentId}
            onChange={(event) => setParentId(event.target.value)}
          >
            <option value="">Not inside a host</option>
            {hosts.map((host) => (
              <option key={host.id} value={host.id}>
                {host.name}
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : null}

      {formError ? <p className="text-xs text-destructive">{formError}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onBack}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={create.isPending}>
          {create.isPending ? 'Adding…' : 'Add'}
        </Button>
      </div>
    </form>
  )
}

type AddDeviceMenuProps = {
  kinds: InfraKindInfo[]
  hosts: InfraNode[]
  index: LayoutIndex
  placed: ReadonlyMap<string, InfraNode>
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The kind whose form is open, or null for the list. */
  kind: InfraNodeKind | null
  onKindChange: (kind: InfraNodeKind | null) => void
  dropPosition: () => { x: number; y: number } | null
  onCreated: (node: InfraNode) => void
  onNotice: (notice: InfraNotice | null) => void
  disabledReason?: string | null
}

/** §8.5 "Add device": a menu built from the API's kinds catalog, then a short form per kind. */
export function AddDeviceMenu({
  kinds,
  hosts,
  index,
  placed,
  open,
  onOpenChange,
  kind,
  onKindChange,
  dropPosition,
  onCreated,
  onNotice,
  disabledReason,
}: AddDeviceMenuProps) {
  const manual = kinds.filter((entry) => entry.manual && entry.kind !== 'gateway')
  const info = kind ? manual.find((entry) => entry.kind === kind) ?? null : null
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) onKindChange(null)
      }}
    >
      <PopoverTrigger asChild>
        <Button type="button" size="sm" disabled={Boolean(disabledReason)} title={disabledReason ?? undefined}>
          <Plus />
          Add device
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[min(80svh,760px)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto">
        {info ? (
          <AddDeviceForm
            key={info.kind}
            info={info}
            hosts={hosts}
            index={index}
            placed={placed}
            dropPosition={dropPosition}
            onBack={() => onKindChange(null)}
            onNotice={onNotice}
            onCreated={(node) => {
              onOpenChange(false)
              onKindChange(null)
              onCreated(node)
            }}
          />
        ) : (
          <div className="space-y-1">
            <p className="px-1 pb-1 text-[11px] text-muted-foreground">
              What to add to the map. Nothing here changes the device itself.
            </p>
            {manual.map((entry) => (
              <button
                key={entry.kind}
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-muted"
                onClick={() => onKindChange(entry.kind)}
              >
                <KindIcon kind={entry.kind} className="size-4 text-muted-foreground" />
                {entry.label}
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
