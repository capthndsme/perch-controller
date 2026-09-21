import { cn } from '@/lib/utils'

type SwitchProps = {
  checked: boolean
  onCheckedChange: (next: boolean) => void
  id?: string
  disabled?: boolean
  className?: string
  'aria-label'?: string
}

/**
 * Minimal accessible toggle. Mirrors the shadcn/Radix Switch surface
 * (`role="switch"` + `aria-checked`) without pulling in
 * `@radix-ui/react-switch` for a single switch in the dashboard. Animated
 * thumb uses a CSS transform so there's no layout thrash.
 */
export function Switch({
  checked,
  onCheckedChange,
  id,
  disabled,
  className,
  'aria-label': ariaLabel,
}: SwitchProps) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => !disabled && onCheckedChange(!checked)}
      className={cn(
        'inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-input',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'block size-4 rounded-full bg-background shadow-sm transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}
