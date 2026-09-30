import { useId, type ReactNode } from 'react'
import { ArrowsSplit } from '@phosphor-icons/react'
import { ToneBadge } from '@/components/gateway-config/bits'
import { TONE_CLASS, type Tone } from '@/lib/gateway-config'
import { cn } from '@/lib/utils'

/**
 * The Wi-Fi pages' form rhythm, UniFi style: settings in grouped cards, one
 * row per setting with the label and its explanation on the left and the
 * control on the right (a switch stays beside its label on a phone; wide
 * controls drop below it).
 */
export function SettingsGroup({
  title,
  description,
  actions,
  children,
  id,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  id?: string
  className?: string
}) {
  return (
    <section id={id} className={cn('scroll-mt-24 space-y-2', className)}>
      <div className="flex items-end justify-between gap-3 px-1">
        <div className="min-w-0">
          <h2 className="section-label">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      <div className="card-surface divide-y divide-border/70">{children}</div>
    </section>
  )
}

export function SettingRow({
  label,
  description,
  control,
  children,
  stack = false,
  htmlFor,
  marker,
  disabled = false,
  className,
}: {
  label: ReactNode
  description?: ReactNode
  /** The control on the right (a switch, a short select). */
  control?: ReactNode
  /** Wider content under the label (segmented controls, inputs, chip grids). */
  children?: ReactNode
  /** Put `control` under the label on every width. */
  stack?: boolean
  htmlFor?: string
  /** An override marker ("Different on Porch AP"). */
  marker?: ReactNode
  disabled?: boolean
  className?: string
}) {
  const LabelTag = htmlFor ? 'label' : 'p'
  return (
    <div className={cn('px-4 py-3', disabled && 'text-muted-foreground', className)}>
      <div className={cn('flex gap-3', stack ? 'flex-col' : 'items-start justify-between')}>
        <div className="min-w-0 space-y-0.5">
          <LabelTag htmlFor={htmlFor} className="block text-[13px] font-medium">
            {label}
          </LabelTag>
          {description ? <div className="text-xs text-muted-foreground">{description}</div> : null}
          {marker ? <div className="pt-1">{marker}</div> : null}
        </div>
        {control ? <div className={cn('shrink-0', !stack && 'pt-0.5')}>{control}</div> : null}
      </div>
      {children ? <div className="mt-3">{children}</div> : null}
    </div>
  )
}

/** "Different on Porch AP": a per-AP override of the field above it. */
export function OverrideMarker({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex max-w-full items-center gap-1 rounded-sm border border-status-serious/40 bg-status-serious/10 px-1.5 py-0.5 text-[11px] font-medium"
    >
      <ArrowsSplit aria-hidden className="size-3 shrink-0 text-status-serious" />
      <span className="truncate">{children}</span>
    </span>
  )
}

/**
 * A chip that toggles (bands, channels). 44 px tall on touch screens below
 * sm, compact from sm up; the press tint lands with the finger.
 */
export function ChipToggle({
  pressed,
  onPressedChange,
  children,
  disabled,
  title,
  className,
  role = 'checkbox',
}: {
  pressed: boolean
  onPressedChange: (next: boolean) => void
  children: ReactNode
  disabled?: boolean
  title?: string
  className?: string
  /** `radio` inside a radiogroup (one channel), `checkbox` otherwise. */
  role?: 'checkbox' | 'radio'
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={pressed}
      disabled={disabled}
      title={title}
      onClick={() => onPressedChange(!pressed)}
      className={cn(
        'inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-md border px-3 text-xs font-medium select-none sm:min-h-8 sm:min-w-9 sm:px-2.5',
        'transition-colors duration-base active:duration-0 [-webkit-touch-callout:none] disabled:cursor-not-allowed disabled:border-dashed disabled:bg-muted/30 disabled:text-muted-foreground/60',
        pressed
          ? 'border-brand/60 bg-brand/10 text-foreground ring-1 ring-brand/30'
          : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted',
        className,
      )}
    >
      {children}
    </button>
  )
}

/** A radio card: a choice with a title and one line of explanation. */
export function ChoiceCard({
  selected,
  onSelect,
  title,
  hint,
  disabled,
  badge,
  footnote,
}: {
  selected: boolean
  onSelect: () => void
  title: ReactNode
  hint?: ReactNode
  disabled?: boolean
  badge?: ReactNode
  footnote?: ReactNode
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex w-full flex-col gap-1 rounded-lg border p-3 text-left text-xs select-none',
        'transition-colors duration-base active:duration-0 disabled:cursor-not-allowed',
        selected ? 'border-brand/60 bg-brand/5 ring-1 ring-brand/30' : 'border-border hover:bg-muted/40 active:bg-muted/60',
        // Disabled without opacity: a translucent layer here repaints badly under the phone's blurred top bar.
        disabled && !selected && 'border-dashed bg-muted/30 text-muted-foreground',
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[13px] font-medium">
          <span
            aria-hidden
            className={cn(
              'grid size-4 shrink-0 place-items-center rounded-full border',
              selected ? 'border-brand bg-brand' : 'border-muted-foreground/50',
            )}
          >
            {selected ? <span className="size-1.5 rounded-full bg-brand-foreground" /> : null}
          </span>
          {title}
        </span>
        {badge}
      </span>
      {/* On a phone only the chosen card explains itself: the others stay one tappable line. */}
      {hint ? <span className={cn('pl-6 text-muted-foreground', !selected && !footnote && 'max-sm:hidden')}>{hint}</span> : null}
      {footnote ? <span className="pl-6 text-[11px] text-status-serious">{footnote}</span> : null}
    </button>
  )
}

/** A status pill with a dot (network, AP, rollout states). */
export function StatusPill({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <ToneBadge tone={tone} dot title={title}>
      {children}
    </ToneBadge>
  )
}

/** Small counters in a row ("Drafts 2 · Conflicts 0 …"); non-zero alarm counts in red. */
export function CountGrid({
  items,
  className,
}: {
  items: Array<{ label: string; value: number; alarm?: boolean }>
  className?: string
}) {
  return (
    <dl className={cn('grid grid-cols-3 gap-2 text-xs sm:grid-cols-6', className)}>
      {items.map((item) => (
        <div key={item.label} className="rounded-md border border-border px-2 py-1.5">
          <dt className="truncate text-[11px] text-muted-foreground">{item.label}</dt>
          <dd className={cn('font-mono text-sm tabular-nums', item.alarm && item.value > 0 && 'text-status-critical')}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** A callout box in a tone, with an optional action on the right. */
export function Callout({
  tone,
  icon,
  title,
  children,
  action,
  className,
}: {
  tone: Tone
  icon?: ReactNode
  title: ReactNode
  children?: ReactNode
  action?: ReactNode
  className?: string
}) {
  const id = useId()
  return (
    <section
      aria-labelledby={id}
      className={cn('flex flex-col gap-2 rounded-lg border px-3 py-2.5 text-xs sm:flex-row sm:items-center', TONE_CLASS[tone], className)}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        {icon ? <span className="mt-px shrink-0">{icon}</span> : null}
        <div className="min-w-0 space-y-0.5">
          <p id={id} className="text-[13px] font-semibold text-foreground">
            {title}
          </p>
          {children ? <div className="text-muted-foreground">{children}</div> : null}
        </div>
      </div>
      {action ? <div className="flex shrink-0 flex-wrap items-center gap-2 pl-6 sm:pl-0">{action}</div> : null}
    </section>
  )
}
