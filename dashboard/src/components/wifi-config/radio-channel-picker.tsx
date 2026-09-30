import { Crosshair } from '@phosphor-icons/react'
import { ChipToggle } from '@/components/wifi-config/rows'
import { channelGroups } from '@/lib/wifi-config'
import type { Band, WifiRadio } from '@/types/wifi-config'

type Channel = WifiRadio['options']['channels'][number]

function ChannelChip({
  channel,
  pressed,
  onPressedChange,
  disabled,
  role,
  current,
}: {
  channel: Channel
  pressed: boolean
  onPressedChange: (next: boolean) => void
  disabled?: boolean
  role: 'radio' | 'checkbox'
  current: boolean
}) {
  return (
    <ChipToggle
      role={role}
      pressed={pressed}
      onPressedChange={onPressedChange}
      disabled={disabled}
      className="relative min-w-12 font-mono tabular-nums sm:min-w-11"
      title={
        channel.dfs
          ? `Channel ${channel.channel}: radar check (DFS), up to ${channel.cacSeconds ?? 60} s silent after a change`
          : `Channel ${channel.channel}`
      }
    >
      {channel.channel}
      {channel.dfs ? <Crosshair aria-label="DFS" weight="bold" className="size-3 text-status-warning" /> : null}
      {current ? (
        <span aria-hidden className="absolute -top-1 -right-1 size-2 rounded-full bg-status-good ring-2 ring-card" />
      ) : null}
    </ChipToggle>
  )
}

/**
 * The channel grid of one radio (dashboard.md 1.3): wraps by sub-band on
 * 5 GHz (UNII-1, -2A, -2C, -3), DFS channels marked, the channel the radio
 * runs on now dotted. `single` picks one channel (fixed); otherwise it is
 * the allowed set of Auto (null = every channel).
 */
export function RadioChannelPicker({
  band,
  channels,
  current,
  value,
  onChange,
  allowed,
  onAllowedChange,
  single,
  disabled,
}: {
  band: Band | null
  channels: Channel[]
  current: number | null
  /** The fixed channel (single mode). */
  value?: number | null
  onChange?: (channel: number) => void
  /** Auto's allowed channels; null = all. */
  allowed?: number[] | null
  onAllowedChange?: (allowed: number[] | null) => void
  single: boolean
  disabled?: boolean
}) {
  const groups = channelGroups(band, channels)
  const all = channels.map((c) => c.channel)
  const allowedSet = new Set(allowed ?? all)

  return (
    <div className="space-y-3">
      {!single ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="text-muted-foreground">
            {allowed === null || allowed === undefined
              ? 'Auto may pick any channel.'
              : `Auto picks among ${allowed.length} of ${all.length} channels.`}
          </span>
          <span className="flex gap-3">
            <button
              type="button"
              className="font-medium text-primary underline-offset-2 hover:underline disabled:opacity-50"
              disabled={disabled || allowed === null}
              onClick={() => onAllowedChange?.(null)}
            >
              Allow all
            </button>
            <button
              type="button"
              className="font-medium text-primary underline-offset-2 hover:underline disabled:opacity-50"
              disabled={disabled}
              onClick={() => onAllowedChange?.(channels.filter((c) => !c.dfs).map((c) => c.channel))}
            >
              No radar channels
            </button>
          </span>
        </div>
      ) : null}
      {groups.map((group) => (
        <div key={group.label} className="space-y-1.5">
          <p className="text-[11px] font-medium text-muted-foreground">{group.label}</p>
          <div
            className="flex flex-wrap gap-1.5"
            role={single ? 'radiogroup' : 'group'}
            aria-label={single ? `Channel, ${group.label}` : `Allowed channels, ${group.label}`}
          >
            {group.channels.map((channel) =>
              single ? (
                <ChannelChip
                  key={channel.channel}
                  role="radio"
                  channel={channel}
                  current={channel.channel === current}
                  pressed={value === channel.channel}
                  disabled={disabled}
                  onPressedChange={() => onChange?.(channel.channel)}
                />
              ) : (
                <ChannelChip
                  key={channel.channel}
                  role="checkbox"
                  channel={channel}
                  current={channel.channel === current}
                  pressed={allowedSet.has(channel.channel)}
                  disabled={disabled}
                  onPressedChange={(on) => {
                    const next = on ? [...allowedSet, channel.channel] : [...allowedSet].filter((c) => c !== channel.channel)
                    const sorted = next.sort((a, b) => a - b)
                    onAllowedChange?.(sorted.length === all.length ? null : sorted)
                  }}
                />
              ),
            )}
          </div>
        </div>
      ))}
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Crosshair weight="bold" className="size-3 text-status-warning" />
          Radar check (DFS): the radio listens up to 60 s before it transmits, and moves if it hears radar.
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-full bg-status-good" />
          On the air now
        </span>
      </p>
    </div>
  )
}
