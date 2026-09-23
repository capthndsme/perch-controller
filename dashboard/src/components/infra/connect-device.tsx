import { useMemo, useRef, useState, type FormEvent } from 'react'
import { PlugsConnected } from '@phosphor-icons/react'
import { DevicePicker, DeviceTypeOffer } from '@/components/infra/device-picker'
import type { InfraNotice, InfraSelection } from '@/components/infra/infra-canvas'
import { Button } from '@/components/ui/button'
import { useSaveDeviceLabel } from '@/hooks/use-device-labels'
import { useCreateInfraNode } from '@/hooks/use-infra'
import { deviceDisplayName } from '@/lib/device-labels'
import {
  describePort,
  infraErrorMessage,
  otherEnd,
  placedDevices,
  placedRefusalNodeId,
  portDisplayName,
  type LayoutIndex,
} from '@/lib/infra'
import type { CreateInfraNodePayload, DeviceSummary, DeviceType, InfraNode, InfraPort } from '@/types/api'

export type SpotNear = (nodeId: number, portId: number | null) => { x: number; y: number } | null

type ConnectDeviceFormProps = {
  /** The free port the device plugs into, and its box. */
  port: InfraPort
  node: InfraNode
  index: LayoutIndex
  /** A free spot on the map next to that box (under the port). */
  spotNear: SpotNear
  onDone: (created: InfraNode | null) => void
  onNotice: (notice: InfraNotice | null) => void
  onSelect: (selection: InfraSelection | null) => void
}

/**
 * A4.1 "Connect a device…": pick a device Perch knows and it gets a box next to
 * this port's device, already cabled to the port, in one request
 * (`POST /infra/nodes` with `linkTo`, no name so the box follows the device).
 * A device without a type can be given one on the way (its label).
 */
export function ConnectDeviceForm({ port, node, index, spotNear, onDone, onNotice, onSelect }: ConnectDeviceFormProps) {
  const create = useCreateInfraNode()
  const saveLabel = useSaveDeviceLabel()
  const [device, setDevice] = useState<DeviceSummary | null>(null)
  const [deviceType, setDeviceType] = useState<DeviceType | ''>('')
  // The refusal itself, worded at render: the layout refetch that follows a
  // refusal can name a box the loaded map did not have yet.
  const [refusal, setRefusal] = useState<unknown>(null)
  const placed = useMemo(() => placedDevices(index), [index])
  const formRef = useRef<HTMLFormElement>(null)
  const where = `${node.name} · ${portDisplayName(port)}`
  const cable = index.linkByPort.get(port.id)
  const error =
    refusal === null
      ? null
      : {
          text: infraErrorMessage(refusal, index, 'Could not connect the device.', { portIds: [port.id] }),
          holderId: placedRefusalNodeId(refusal),
        }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!device) return
    const mac = device.mac.toLowerCase()
    const payload: CreateInfraNodePayload = { kind: 'device', deviceMac: mac, linkTo: { portId: port.id } }
    const at = spotNear(node.id, port.id)
    if (at) payload.position = at
    const type = device.deviceType ? null : deviceType || null
    setRefusal(null)
    create.mutate(payload, {
      onSuccess: ({ node: created, link }) => {
        onNotice({
          tone: 'info',
          text: link ? `Connected ${created.name} to ${where}.` : `Added ${created.name}.`,
        })
        if (type) {
          saveLabel.mutate(
            { mac, payload: { deviceType: type } },
            {
              onError: (cause) =>
                onNotice({
                  tone: 'error',
                  text: `Connected ${created.name} to ${where}, but its type could not be saved: ${cause.message}`,
                }),
            },
          )
        }
        onDone(created)
      },
      onError: (cause) => {
        setRefusal(cause)
        // The picker makes the form tall: bring the refusal and the buttons under it into view.
        window.requestAnimationFrame(() =>
          formRef.current?.querySelector('[data-connect-actions]')?.scrollIntoView({ block: 'nearest' }),
        )
      },
    })
  }

  const holderId = error?.holderId ?? null
  // Named once the layout refetch that follows the refusal has the box.
  const holderName = holderId !== null ? index.nodes.get(holderId)?.name : undefined

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      className="mt-2 space-y-2.5 rounded-md border border-brand/40 bg-brand/[0.03] p-2.5"
      noValidate
      data-connect-form={port.id}
    >
      <p className="flex items-center gap-1.5 text-xs font-semibold">
        <PlugsConnected aria-hidden className="size-4 text-brand" />
        Connect a device to {portDisplayName(port)}
      </p>
      <DevicePicker
        selectedMac={device?.mac ?? null}
        placed={placed}
        autoFocus
        onPick={(picked) => {
          setDevice(picked)
          setDeviceType('')
          setRefusal(null)
        }}
      />
      {device ? (
        <p className="text-[11px] text-muted-foreground" data-connect-summary>
          <span className="font-medium text-foreground">{deviceDisplayName(device)}</span> gets a box next to{' '}
          {node.name}, cabled to {portDisplayName(port)}. The box takes the device&rsquo;s name and follows it.
        </p>
      ) : null}
      {device && !device.deviceType ? (
        <DeviceTypeOffer id={`connect-type-${port.id}`} value={deviceType} onChange={setDeviceType} />
      ) : null}
      {cable && !error ? (
        <p className="text-[11px] text-status-warning">
          {where} has a cable now, to {describePort(index, otherEnd(cable, port.id).portId)}.
        </p>
      ) : null}
      {error ? (
        <div className="space-y-1" role="alert">
          <p className="text-[11px] text-destructive" data-connect-error>
            {error.text}
          </p>
          {holderId !== null ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => {
                onDone(null)
                onSelect({ type: 'node', id: holderId })
              }}
            >
              {holderName ? `Show ${holderName}` : 'Show that box'}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="flex justify-end gap-1.5" data-connect-actions>
        <Button type="button" size="xs" variant="ghost" onClick={() => onDone(null)}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={!device || Boolean(cable) || create.isPending}>
          {create.isPending ? 'Connecting…' : 'Connect'}
        </Button>
      </div>
    </form>
  )
}
