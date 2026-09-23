import { useMemo, useState } from 'react'
import { Devices } from '@phosphor-icons/react'
import { NativeSelect } from '@/components/infra/native-select'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useDevices } from '@/hooks/use-devices'
import { DEVICE_TYPE_OPTIONS, deviceDisplayName, deviceSearchText, deviceTypeMeta } from '@/lib/device-labels'
import type { TimeWindow } from '@/lib/time-window'
import { cn } from '@/lib/utils'
import type { DeviceSummary, DeviceType, InfraNode } from '@/types/api'

const PICKER_WINDOW: TimeWindow = { kind: 'relative', range: '24h' }
const MAX_ROWS = 50

type DevicePickerProps = {
  selectedMac: string | null
  onPick: (device: DeviceSummary) => void
  /** Lowercase MAC → the box it already has (A4.2: one per device): listed as placed, not pickable. */
  placed?: ReadonlyMap<string, Pick<InfraNode, 'id' | 'name' | 'hidden'>>
  /** The box being edited: its own device stays pickable. */
  ownNodeId?: number | null
  autoFocus?: boolean
}

/**
 * Searchable list over `GET /api/v1/devices` (the last 24 h): type icon, name,
 * address and MAC. Devices that already have a box on the map are listed after
 * the others, marked, and cannot be picked.
 */
export function DevicePicker({ selectedMac, onPick, placed, ownNodeId = null, autoFocus = false }: DevicePickerProps) {
  const devices = useDevices({ window: PICKER_WINDOW, refreshInterval: null })
  const [query, setQuery] = useState('')
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const seen = new Set<string>()
    const list: Array<{ device: DeviceSummary; box: Pick<InfraNode, 'id' | 'name' | 'hidden'> | null }> = []
    for (const device of devices.data ?? []) {
      const mac = device.mac.toLowerCase()
      if (seen.has(mac)) continue
      seen.add(mac)
      if (needle && !deviceSearchText(device).includes(needle)) continue
      const box = placed?.get(mac) ?? null
      list.push({ device, box: box && box.id !== ownNodeId ? box : null })
    }
    list.sort(
      (a, b) =>
        Number(Boolean(a.box)) - Number(Boolean(b.box)) ||
        deviceDisplayName(a.device).localeCompare(deviceDisplayName(b.device)),
    )
    return list.slice(0, MAX_ROWS)
  }, [devices.data, query, placed, ownNodeId])

  return (
    <div className="space-y-1.5" data-device-picker>
      <Input
        aria-label="Search devices"
        placeholder="Search by name, address or MAC"
        value={query}
        autoFocus={autoFocus}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="max-h-52 overflow-y-auto rounded-md border border-border" role="listbox" aria-label="Devices">
        {devices.isPending ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">Loading devices…</p>
        ) : devices.error ? (
          <p className="px-2 py-2 text-xs text-destructive">{devices.error.message}</p>
        ) : rows.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">No device matches.</p>
        ) : (
          rows.map(({ device, box }) => {
            const selected = device.mac.toLowerCase() === selectedMac?.toLowerCase()
            const type = deviceTypeMeta(device.deviceType)
            const Icon = type?.Icon ?? Devices
            return (
              <button
                key={device.mac}
                type="button"
                role="option"
                aria-selected={selected}
                aria-disabled={box ? true : undefined}
                disabled={Boolean(box)}
                data-device-mac={device.mac.toLowerCase()}
                data-placed={box ? 'true' : undefined}
                title={box ? `Already on the map as ${box.name}${box.hidden ? ' (hidden)' : ''}` : undefined}
                onClick={() => onPick(device)}
                className={cn(
                  'flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs',
                  box ? 'cursor-not-allowed opacity-60' : 'hover:bg-muted',
                  selected && 'bg-brand/10 text-brand',
                )}
              >
                <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5">
                    <span className="truncate font-medium">{deviceDisplayName(device)}</span>
                    {type ? <span className="shrink-0 text-[10px] text-muted-foreground">{type.label}</span> : null}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-muted-foreground">
                    {device.primaryIp ?? 'no address'} · {device.mac}
                  </span>
                </span>
                {box ? (
                  <span className="shrink-0 rounded-sm border border-border px-1 text-[9px] font-medium uppercase leading-4 tracking-wide text-muted-foreground">
                    On the map
                  </span>
                ) : null}
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

/**
 * A4.1: the device's label has no type yet; offer the label taxonomy. The
 * caller saves a choice with `PATCH /api/v1/devices/:mac/label { deviceType }`.
 */
export function DeviceTypeOffer({
  id,
  value,
  onChange,
}: {
  id: string
  value: DeviceType | ''
  onChange: (value: DeviceType | '') => void
}) {
  const chosen = deviceTypeMeta(value || null)
  return (
    <div className="space-y-1" data-type-offer>
      <Label htmlFor={id}>
        What is it? <span className="text-muted-foreground">(optional)</span>
      </Label>
      <div className="flex items-center gap-2">
        <NativeSelect id={id} value={value} onChange={(event) => onChange(event.target.value as DeviceType | '')}>
          <option value="">Leave it unset</option>
          {DEVICE_TYPE_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
        {chosen ? <chosen.Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" /> : null}
      </div>
      <p className="text-[11px] text-muted-foreground">
        This device has no type yet. The type is saved on the device itself, so every view shows it.
      </p>
    </div>
  )
}
