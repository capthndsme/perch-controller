import { useId } from 'react'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { txPresetDbm, type TxPreset } from '@/lib/wifi-config'

export type TxDraft = { preset: TxPreset; dbm: number | null }

/**
 * Transmit power (dashboard.md 1.3): Auto, High (the radio's maximum),
 * Medium (max − 6 dB), Low (max − 12 dB) or a custom dBm. Lower power makes
 * smaller cells, so devices roam to a closer access point sooner.
 */
export function RadioPower({
  value,
  onChange,
  maxDbm,
  disabled,
}: {
  value: TxDraft
  onChange: (value: TxDraft) => void
  maxDbm: number | null
  disabled?: boolean
}) {
  const id = useId()
  const options: Array<{ id: TxPreset; label: string; title?: string }> = [{ id: 'auto', label: 'Auto' }]
  if (maxDbm !== null) {
    options.push(
      { id: 'high', label: 'High', title: `${txPresetDbm('high', maxDbm)} dBm` },
      { id: 'medium', label: 'Medium', title: `${txPresetDbm('medium', maxDbm)} dBm` },
      { id: 'low', label: 'Low', title: `${txPresetDbm('low', maxDbm)} dBm` },
    )
  }
  options.push({ id: 'custom', label: 'Custom' })
  const bad = value.preset === 'custom' && (value.dbm === null || value.dbm < 1 || (maxDbm !== null && value.dbm > maxDbm))

  return (
    <div className="space-y-2">
      <div className="-mx-1 overflow-x-auto px-1 [scrollbar-width:none]">
        <Segmented
          size="xs"
          ariaLabel="Transmit power"
          value={value.preset}
          className="w-fit"
          onChange={(preset) => {
            if (disabled) return
            if (preset === 'auto') onChange({ preset, dbm: null })
            else if (preset === 'custom') onChange({ preset, dbm: value.dbm ?? maxDbm ?? 20 })
            else onChange({ preset, dbm: maxDbm !== null ? txPresetDbm(preset, maxDbm) : null })
          }}
          options={options}
        />
      </div>
      {value.preset === 'custom' ? (
        <div className="flex items-center gap-2 text-xs">
          <label htmlFor={id} className="text-muted-foreground">
            Power
          </label>
          <Input
            id={id}
            inputMode="numeric"
            className="h-9 w-20 font-mono"
            value={value.dbm ?? ''}
            disabled={disabled}
            aria-invalid={bad || undefined}
            onChange={(event) => {
              const digits = event.target.value.replace(/[^\d]/g, '')
              onChange({ preset: 'custom', dbm: digits === '' ? null : Number(digits) })
            }}
          />
          <span className="text-muted-foreground">dBm{maxDbm !== null ? ` (up to ${maxDbm})` : ''}</span>
        </div>
      ) : value.preset !== 'auto' && value.dbm !== null ? (
        <p className="text-xs text-muted-foreground">{value.dbm} dBm{maxDbm !== null ? ` of ${maxDbm} dBm` : ''}</p>
      ) : (
        <p className="text-xs text-muted-foreground">The radio’s driver and the country’s limit decide.</p>
      )}
      {bad ? <p className="text-xs text-destructive">1–{maxDbm ?? 30} dBm.</p> : null}
    </div>
  )
}
