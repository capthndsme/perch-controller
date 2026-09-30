import { CaretRight, UsersThree, Warning } from '@phosphor-icons/react'
import { ToneBadge } from '@/components/gateway-config/bits'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { ChipToggle, OverrideMarker, SettingRow, SettingsGroup } from '@/components/wifi-config/rows'
import { AP_MODE_META, BAND_LABEL, BANDS, SLOT_STATE_META } from '@/lib/wifi-config'
import { cn } from '@/lib/utils'
import type { ApMode, Band, WifiNetworkAp } from '@/types/wifi-config'

export type BroadcastApRow = {
  apId: number
  name: string
  online: boolean
  mode: ApMode
  included: boolean
  /** The saved per-AP row (null for a network not saved yet). */
  saved: WifiNetworkAp | null
  /** Overrides differ from the network (saved or in this edit). */
  customised: boolean
  /** Bands present on this AP. */
  bands: Band[]
}

function ApRow({
  row,
  disabled,
  onToggle,
  onCustomize,
}: {
  row: BroadcastApRow
  disabled: boolean
  onToggle: (included: boolean) => void
  onCustomize: () => void
}) {
  const slots = row.saved?.slots ?? []
  const unsupported = row.saved?.unsupported ?? []
  const off = row.mode === 'off'
  return (
    <div className={cn('flex items-start gap-3 px-4 py-3', !row.included && 'bg-muted/20')} data-testid="broadcast-ap">
      <Switch
        checked={row.included}
        onCheckedChange={onToggle}
        disabled={disabled || off}
        aria-label={`Broadcast on ${row.name}`}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium">{row.name}</span>
          <span
            aria-label={row.online ? 'Online' : 'Offline'}
            className={cn('size-1.5 rounded-full', row.online ? 'bg-status-good' : 'bg-muted-foreground/50')}
          />
          {row.mode !== 'managed' ? (
            <ToneBadge tone={AP_MODE_META[row.mode].tone} title={AP_MODE_META[row.mode].hint}>
              {AP_MODE_META[row.mode].label}
            </ToneBadge>
          ) : null}
          {row.customised ? <OverrideMarker>Customised</OverrideMarker> : null}
        </div>
        {off ? (
          <p className="text-xs text-muted-foreground">Perch does not read this access point’s Wi-Fi. Turn it on under Sync.</p>
        ) : row.included && slots.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {slots.map((slot) => {
              const meta = SLOT_STATE_META[slot.state]
              return (
                <li key={slot.radio}>
                  <ToneBadge tone={meta.tone} dot title={`${slot.radio}: ${meta.label}`}>
                    {slot.band ? BAND_LABEL[slot.band] : slot.radio}
                    {slot.clients !== null && slot.clients > 0 ? (
                      <span className="inline-flex items-center gap-0.5 text-muted-foreground">
                        <UsersThree aria-hidden className="size-3" />
                        {slot.clients}
                      </span>
                    ) : null}
                  </ToneBadge>
                </li>
              )
            })}
          </ul>
        ) : row.included ? (
          <p className="text-xs text-muted-foreground">
            {row.mode === 'observe' ? 'Goes on the air once this access point is managed.' : 'Added with the next rollout.'}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">Not broadcast here.</p>
        )}
        {row.included && unsupported.length > 0 ? (
          <ul className="space-y-0.5">
            {unsupported.map((u) => (
              <li key={u.code} className="flex items-start gap-1.5 text-xs">
                <Warning weight="fill" className="mt-px size-3.5 shrink-0 text-status-warning" />
                {u.message}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {!off ? (
        <button
          type="button"
          onClick={onCustomize}
          className="-my-1 -mr-2 inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors duration-base hover:bg-muted hover:text-foreground active:bg-muted active:duration-0 sm:min-h-8"
          aria-label={`Settings for ${row.name}`}
        >
          <span className="hidden sm:inline">{disabled ? 'Details' : 'Customize'}</span>
          <CaretRight className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}

/**
 * The Broadcasting group (dashboard.md 1.2 item 4): bands, then "All" or
 * "Selected" access points with a row each: its switch, the slots it runs
 * (band, state, clients) and Customize for per-AP settings.
 */
export function BroadcastSection({
  bands,
  onBandsChange,
  availableBands,
  bandsMarker,
  apScope,
  onScopeChange,
  rows,
  onToggleAp,
  onCustomize,
  disabled,
}: {
  bands: Band[]
  onBandsChange: (bands: Band[]) => void
  availableBands: Band[]
  bandsMarker: string | null
  apScope: 'all' | 'selected'
  onScopeChange: (scope: 'all' | 'selected') => void
  rows: BroadcastApRow[]
  onToggleAp: (apId: number, included: boolean) => void
  onCustomize: (apId: number) => void
  disabled: boolean
}) {
  const included = rows.filter((r) => r.included).length
  return (
    <SettingsGroup title="Broadcasting" id="broadcast">
      <SettingRow
        label="Bands"
        description="The network goes on every radio of these bands, unless an access point says otherwise."
        stack
        marker={bandsMarker ? <OverrideMarker>{bandsMarker}</OverrideMarker> : null}
      >
        <div className="flex flex-wrap gap-2" role="group" aria-label="Bands">
          {BANDS.map((band) => {
            const available = availableBands.includes(band)
            return (
              <ChipToggle
                key={band}
                pressed={bands.includes(band)}
                disabled={disabled || (!available && !bands.includes(band))}
                title={available ? undefined : 'No access point has a radio on this band'}
                onPressedChange={(on) => onBandsChange(on ? [...bands, band] : bands.filter((b) => b !== band))}
              >
                {BAND_LABEL[band]}
              </ChipToggle>
            )
          })}
        </div>
        {bands.length === 0 ? <p className="mt-1.5 text-xs text-destructive">Pick at least one band.</p> : null}
      </SettingRow>
      <SettingRow
        label="Access points"
        description={
          apScope === 'all'
            ? 'Every managed access point, including ones added later. Switch one off to leave it out.'
            : 'Only the access points switched on below.'
        }
        control={
          <Segmented
            size="xs"
            ariaLabel="Access points"
            value={apScope}
            onChange={(next) => !disabled && onScopeChange(next)}
            options={[
              { id: 'all', label: 'All' },
              { id: 'selected', label: 'Selected' },
            ]}
          />
        }
      />
      {rows.map((row) => (
        <ApRow
          key={row.apId}
          row={row}
          disabled={disabled}
          onToggle={(on) => onToggleAp(row.apId, on)}
          onCustomize={() => onCustomize(row.apId)}
        />
      ))}
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-xs text-muted-foreground">No access point runs a Perch agent with WiFi management yet.</p>
      ) : (
        <p className="px-4 py-2.5 text-[11px] text-muted-foreground">
          On {included} of {rows.length} access points.
        </p>
      )}
    </SettingsGroup>
  )
}
