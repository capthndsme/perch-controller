import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type SegmentedProps<T extends string> = {
  value: T
  onChange: (next: T) => void
  options: ReadonlyArray<{ id: T; label: string; title?: string }>
  ariaLabel: string
  /** `sm` matches the page-header controls; `xs` the in-panel toggles. */
  size?: 'sm' | 'xs'
  className?: string
}

/** Segmented radio group in the same skin as the dashboard scope / view toggles. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  size = 'sm',
  className,
}: SegmentedProps<T>) {
  return (
    <div
      className={cn(
        'flex rounded-lg border border-border bg-background',
        size === 'sm' ? 'p-1' : 'rounded-md p-0.5',
        className,
      )}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map((option) => (
        <Button
          key={option.id}
          type="button"
          size="sm"
          role="radio"
          aria-checked={value === option.id}
          variant={value === option.id ? 'secondary' : 'ghost'}
          className={size === 'xs' ? 'h-6 px-2 text-xs' : undefined}
          title={option.title}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  )
}
