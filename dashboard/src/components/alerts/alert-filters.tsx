import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** A toggle chip (filters): pill, a tint the moment it is pressed, filled while on. */
export function FilterChip({
  pressed,
  onClick,
  children,
  className,
  title,
}: {
  pressed: boolean
  onClick: () => void
  children: ReactNode
  className?: string
  title?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={title}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium whitespace-nowrap select-none sm:h-7',
        'transition-colors duration-base active:duration-0 focus-visible:outline-2 focus-visible:outline-offset-2',
        pressed
          ? 'border-foreground/80 bg-foreground text-background active:bg-foreground/85'
          : 'border-border bg-background text-foreground hover:bg-muted active:bg-muted',
        className,
      )}
    >
      {children}
    </button>
  )
}

/**
 * A row of chips that scrolls sideways on a phone (no wrapping into a wall of pills) and wraps from `sm`.
 * The bleed keeps the first chip on the page's gutter while the row scrolls under the edges.
 */
export function ChipRow({ children, label, className }: { children: ReactNode; label: string; className?: string }) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        '-mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden',
        className,
      )}
    >
      {children}
    </div>
  )
}
