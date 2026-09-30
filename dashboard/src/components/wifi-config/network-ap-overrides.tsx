import { useId, useState } from 'react'
import { ArrowCounterClockwise } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { ChipToggle } from '@/components/wifi-config/rows'
import { EditorSheet } from '@/components/wifi-config/sheet'
import { BAND_LABEL, BANDS, radioLabel } from '@/lib/wifi-config'
import type { Band, NetworkApPut, NetworkOverrides, WifiNetworkAp, WifiRadio } from '@/types/wifi-config'

type Tri = 'inherit' | 'on' | 'off'

function triOf(value: boolean | undefined): Tri {
  return value === undefined ? 'inherit' : value ? 'on' : 'off'
}

function triValue(tri: Tri): boolean | undefined {
  return tri === 'inherit' ? undefined : tri === 'on'
}

export type NetworkDefaults = {
  enabled: boolean
  hidden: boolean
  isolate: boolean
  bands: Band[]
  maxClients: number | null
  dtimPeriod: number | null
  apNetworkBinding: boolean
}

function TriRow({
  label,
  hint,
  value,
  onChange,
  inherited,
  disabled,
}: {
  label: string
  hint?: string
  value: Tri
  onChange: (tri: Tri) => void
  inherited: boolean
  disabled: boolean
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2">
      <div className="min-w-0">
        <p className="text-[13px] font-medium">{label}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <Segmented
        size="xs"
        ariaLabel={label}
        value={value}
        onChange={(next) => !disabled && onChange(next)}
        options={[
          { id: 'inherit', label: `Network (${inherited ? 'on' : 'off'})` },
          { id: 'on', label: 'On' },
          { id: 'off', label: 'Off' },
        ]}
      />
    </div>
  )
}

function NumberOverride({
  label,
  value,
  onChange,
  inherited,
  disabled,
  max,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  inherited: number | null
  disabled: boolean
  max: number
}) {
  const id = useId()
  const n = Number(value)
  const bad = value !== '' && (!Number.isInteger(n) || n < 1 || n > max)
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2">
      <label htmlFor={id} className="text-[13px] font-medium">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          inputMode="numeric"
          className="h-9 w-24 font-mono"
          placeholder={inherited === null ? 'Default' : String(inherited)}
          value={value}
          disabled={disabled}
          aria-invalid={bad || undefined}
          onChange={(event) => onChange(event.target.value.replace(/[^\d]/g, ''))}
        />
      </div>
      {bad ? <p className="w-full text-xs text-destructive">1–{max}, or empty for the network’s value.</p> : null}
    </div>
  )
}

/**
 * One access point's settings for one network (a bottom sheet on a phone):
 * bands and radios it broadcasts on, a radio switched off, and overrides of
 * the network's switches. "Reset to network settings" drops them all. Done
 * keeps the edit in the page; Save on the page writes it.
 */
export function ApOverridesSheet({
  open,
  onOpenChange,
  apName,
  saved,
  edit,
  radios,
  defaults,
  apNetworks,
  disabled,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  apName: string
  saved: WifiNetworkAp | null
  edit: NetworkApPut | null
  /** This AP's present radios. */
  radios: WifiRadio[]
  defaults: NetworkDefaults
  apNetworks: string[]
  disabled: boolean
  onDone: (edit: NetworkApPut) => void
}) {
  const base = {
    bands: edit && 'bands' in edit ? (edit.bands ?? null) : (saved?.bands ?? null),
    radios: edit && 'radios' in edit ? (edit.radios ?? null) : (saved?.radios ?? null),
    overrides: edit?.overrides ?? saved?.overrides ?? {},
    radioOverrides: edit?.radioOverrides ?? saved?.radioOverrides ?? {},
  }
  const [bands, setBands] = useState<Band[] | null>(base.bands)
  const [pickRadios, setPickRadios] = useState<string[] | null>(base.radios)
  const [radioOff, setRadioOff] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(Object.entries(base.radioOverrides).map(([k, v]) => [k, v.enabled === false])),
  )
  const [enabled, setEnabled] = useState<Tri>(triOf(base.overrides.enabled))
  const [hidden, setHidden] = useState<Tri>(triOf(base.overrides.hidden))
  const [isolate, setIsolate] = useState<Tri>(triOf(base.overrides.isolate))
  const [maxClients, setMaxClients] = useState(base.overrides.maxClients?.toString() ?? '')
  const [dtim, setDtim] = useState(base.overrides.dtimPeriod?.toString() ?? '')
  const [apNetwork, setApNetwork] = useState(base.overrides.apNetwork ?? '')
  const keepKey = base.overrides.keepKey === true

  const apBands = BANDS.filter((b) => radios.some((r) => r.band === b))
  const effectiveBands = bands ?? defaults.bands
  const radiosOnBands = radios.filter((r) => r.band && effectiveBands.includes(r.band))

  function reset() {
    setBands(null)
    setPickRadios(null)
    setRadioOff({})
    setEnabled('inherit')
    setHidden('inherit')
    setIsolate('inherit')
    setMaxClients('')
    setDtim('')
    if (!defaults.apNetworkBinding) setApNetwork('')
  }

  function done() {
    const overrides: NetworkOverrides = {}
    const e = triValue(enabled)
    const h = triValue(hidden)
    const i = triValue(isolate)
    if (e !== undefined) overrides.enabled = e
    if (h !== undefined) overrides.hidden = h
    if (i !== undefined) overrides.isolate = i
    if (maxClients !== '') overrides.maxClients = Number(maxClients)
    if (dtim !== '') overrides.dtimPeriod = Number(dtim)
    if (apNetwork.trim() !== '') overrides.apNetwork = apNetwork.trim()
    if (keepKey) overrides.keepKey = true
    const radioOverrides: Record<string, { enabled?: boolean }> = {}
    for (const [radio, off] of Object.entries(radioOff)) if (off) radioOverrides[radio] = { enabled: false }
    onDone({ bands, radios: pickRadios, overrides, radioOverrides })
    onOpenChange(false)
  }

  return (
    <EditorSheet
      open={open}
      onOpenChange={onOpenChange}
      title={`${apName}`}
      description="Settings of this network on this access point only."
      footer={
        <>
          <Button variant="outline" onClick={reset} disabled={disabled}>
            <ArrowCounterClockwise />
            Reset to network settings
          </Button>
          <Button onClick={done} disabled={disabled}>
            Done
          </Button>
        </>
      }
    >
      <section className="space-y-2">
        <p className="section-label">Bands here</p>
        <Segmented
          size="xs"
          ariaLabel="Bands here"
          value={bands === null ? 'network' : 'custom'}
          onChange={(next) => !disabled && setBands(next === 'network' ? null : [...defaults.bands])}
          options={[
            { id: 'network', label: 'Same as the network' },
            { id: 'custom', label: 'Choose' },
          ]}
        />
        {bands !== null ? (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Bands on this access point">
            {apBands.map((band) => (
              <ChipToggle
                key={band}
                pressed={bands.includes(band)}
                disabled={disabled}
                onPressedChange={(on) => setBands(on ? [...bands, band] : bands.filter((b) => b !== band))}
              >
                {BAND_LABEL[band]}
              </ChipToggle>
            ))}
          </div>
        ) : null}
      </section>

      <section className="space-y-2">
        <p className="section-label">Radios</p>
        <Segmented
          size="xs"
          ariaLabel="Radios"
          value={pickRadios === null ? 'bands' : 'pick'}
          onChange={(next) =>
            !disabled && setPickRadios(next === 'bands' ? null : radiosOnBands.map((r) => r.section))
          }
          options={[
            { id: 'bands', label: 'Every radio of those bands' },
            { id: 'pick', label: 'Pick radios' },
          ]}
        />
        <ul className="divide-y divide-border/70 rounded-md border border-border">
          {radios.map((radio) => {
            const onBand = radio.band !== null && effectiveBands.includes(radio.band)
            const picked = pickRadios === null ? onBand : pickRadios.includes(radio.section)
            return (
              <li key={radio.section} className="flex items-center justify-between gap-3 px-3 py-2">
                <label className="flex min-w-0 items-center gap-2 text-xs">
                  {pickRadios !== null ? (
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--brand)]"
                      checked={picked}
                      disabled={disabled}
                      onChange={(event) =>
                        setPickRadios(
                          event.target.checked
                            ? [...pickRadios, radio.section]
                            : pickRadios.filter((s) => s !== radio.section),
                        )
                      }
                    />
                  ) : null}
                  <span className={picked ? '' : 'text-muted-foreground'}>{radioLabel(radio)}</span>
                  {radio.channel || radio.current.channel ? (
                    <span className="font-mono text-[11px] text-muted-foreground">
                      ch {radio.current.channel ?? radio.channel}
                    </span>
                  ) : null}
                </label>
                {picked ? (
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    On
                    <Switch
                      checked={!radioOff[radio.section]}
                      disabled={disabled}
                      onCheckedChange={(on) => setRadioOff((cur) => ({ ...cur, [radio.section]: !on }))}
                      aria-label={`Broadcast on ${radio.section}`}
                    />
                  </span>
                ) : (
                  <span className="text-[11px] text-muted-foreground">Not on this band</span>
                )}
              </li>
            )
          })}
          {radios.length === 0 ? <li className="px-3 py-2 text-xs text-muted-foreground">No radios reported.</li> : null}
        </ul>
      </section>

      <section className="space-y-1">
        <p className="section-label">Overrides</p>
        <div className="divide-y divide-border/70">
          <TriRow label="Broadcasting" value={enabled} onChange={setEnabled} inherited={defaults.enabled} disabled={disabled} />
          <TriRow label="Hidden" value={hidden} onChange={setHidden} inherited={defaults.hidden} disabled={disabled} />
          <TriRow
            label="Client isolation"
            value={isolate}
            onChange={setIsolate}
            inherited={defaults.isolate}
            disabled={disabled}
          />
          <NumberOverride
            label="Max clients"
            value={maxClients}
            onChange={setMaxClients}
            inherited={defaults.maxClients}
            disabled={disabled}
            max={512}
          />
          <NumberOverride label="DTIM period" value={dtim} onChange={setDtim} inherited={defaults.dtimPeriod} disabled={disabled} max={255} />
          {defaults.apNetworkBinding ? (
            <div className="flex flex-wrap items-center justify-between gap-2 py-2">
              <p className="text-[13px] font-medium">Network on this AP</p>
              <select
                className="h-9 rounded-md border border-input bg-transparent px-2 font-mono text-xs"
                value={apNetwork}
                disabled={disabled}
                onChange={(event) => setApNetwork(event.target.value)}
              >
                {[...new Set([apNetwork, ...apNetworks].filter(Boolean))].map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {keepKey ? (
            <p className="py-2 text-xs text-muted-foreground">
              This access point keeps its own passphrase for this network (kept when a change on it was made in LuCI).
            </p>
          ) : null}
        </div>
      </section>
    </EditorSheet>
  )
}
