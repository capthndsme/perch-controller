import { useLayoutEffect, useRef } from 'react'
import { CircleNotch } from '@phosphor-icons/react'

import { cn } from '@/lib/utils'

/**
 * The app's single spinning-loader glyph. Wraps Phosphor's `CircleNotch`
 * with our spin animation and muted colour so every loading affordance
 * looks identical. Size via `className` (e.g. `size-5`); inherits `size-4`.
 * With reduced motion it stands still.
 */
function Spinner({ className, ...props }: React.ComponentProps<typeof CircleNotch>) {
  return (
    <CircleNotch
      role="status"
      aria-label="Loading"
      weight="bold"
      className={cn('size-4 text-muted-foreground motion-safe:animate-spin', className)}
      {...props}
    />
  )
}

/** Matches the `animation-delay` of `.page-spinner-reveal` in index.css. */
const REVEAL_DELAY_MS = 150
/** A spinner that mounts within this long of a visible one going away takes over from it: no delay. */
const HANDOVER_MS = 100
/** When a page-level spinner that had been on screen last went away. */
let lastVisibleUntil = Number.NEGATIVE_INFINITY

type PageSpinnerProps = {
  /** What is loading, without the ellipsis: read to screen readers, shown as text with reduced motion. */
  label?: string
  /** Centre in the viewport (session checks, sign-in, setup) instead of the content area. */
  fullScreen?: boolean
  className?: string
}

/**
 * Page-level loading state: a page's code, or the data a whole page waits for.
 * It fills the content area (or the screen) so nothing shifts when the page
 * arrives, and stays invisible for the first 150 ms so fast loads don't flash
 * it. One that replaces a visible one (the setup check handing over to the
 * session check, then to the page's code) shows at once instead of blinking.
 * With reduced motion the glyph stands still and the label is shown.
 */
function PageSpinner({ label = 'Loading', fullScreen = false, className }: PageSpinnerProps) {
  const revealRef = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const mountedAt = performance.now()
    const handover = mountedAt - lastVisibleUntil < HANDOVER_MS
    // Before the first paint: fully visible from its first frame, no delay, no fade.
    if (handover && revealRef.current) revealRef.current.style.animation = 'none'
    return () => {
      const now = performance.now()
      if (handover || now - mountedAt >= REVEAL_DELAY_MS) lastVisibleUntil = now
    }
  }, [])

  return (
    <div
      role="status"
      className={cn(
        'flex flex-1 items-center justify-center',
        fullScreen ? 'min-h-svh' : 'py-24',
        className,
      )}
    >
      <span ref={revealRef} className="page-spinner-reveal inline-flex items-center gap-2 text-muted-foreground">
        <CircleNotch aria-hidden weight="bold" className="size-5 motion-safe:animate-spin" />
        <span className="sr-only text-xs motion-reduce:not-sr-only">{label}…</span>
      </span>
    </div>
  )
}

export { PageSpinner, Spinner }
