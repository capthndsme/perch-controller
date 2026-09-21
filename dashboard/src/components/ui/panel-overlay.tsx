import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

type PanelOverlayProps = {
  /** When true the scrim + spinner fade in over the panel. */
  show: boolean
  /** Optional caption beside the spinner (e.g. "Updating…"). */
  label?: string
  className?: string
}

/**
 * Drop-in loading scrim for a data panel. Render it as the LAST child of a
 * `relative` container (a `<section>`/`<Card>` that holds a chart, table, or
 * stat) and pass `show={query.isPlaceholderData}` — so it marks a *window /
 * scope switch* where we're still showing the previous data (the
 * `keepPreviousData` case: changing the range, dragging the mini-map). It
 * deliberately does NOT key on `isFetching`, so the periodic auto-refresh
 * poll updates in place without flashing the overlay; the first-paint empty
 * state keeps its own placeholder.
 *
 * It's `pointer-events-none` and fades, so it never blocks interaction or
 * flashes on fast switches — just a faint, consistent "this is updating"
 * cue. See STYLEGUIDE.md › Loading states.
 */
function PanelOverlay({ show, label, className }: PanelOverlayProps) {
  return (
    <div
      aria-hidden={!show}
      className={cn(
        'pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2',
        'bg-card/40 backdrop-blur-[1px] transition-opacity duration-200',
        show ? 'opacity-100' : 'opacity-0',
        className,
      )}
    >
      <Spinner className="size-5" />
      {label ? <span className="text-xs text-muted-foreground">{label}</span> : null}
    </div>
  )
}

export { PanelOverlay }
