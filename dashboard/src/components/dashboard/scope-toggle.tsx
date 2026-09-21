import { Button } from '@/components/ui/button'
import type { DashboardScope } from '@/types/api'

const OPTIONS: Array<{ id: DashboardScope; label: string; hint: string }> = [
  { id: 'all', label: 'All', hint: 'WAN + LAN combined' },
  {
    id: 'overlay',
    label: 'Overlay',
    hint: 'WAN as primary; LAN overlaid as a secondary series and surfaced on the cards',
  },
  { id: 'wan', label: 'WAN', hint: 'Only traffic that crossed the gateway' },
  { id: 'lan', label: 'LAN', hint: 'Only LAN-to-LAN flows (Plex, NAS, etc.)' },
]

type ScopeToggleProps = {
  value: DashboardScope
  onChange: (next: DashboardScope) => void
  className?: string
}

/**
 * Four-way scope picker rendered as a segmented control. Sits alongside
 * `TimeControls` in the dashboard header. The `hint` text is exposed via
 * `title` for hover discoverability without bulking the visual layout.
 */
export function ScopeToggle({ value, onChange, className }: ScopeToggleProps) {
  return (
    <div
      className={
        'flex rounded-lg border border-border bg-background p-1 ' + (className ?? '')
      }
      role="radiogroup"
      aria-label="Traffic scope"
    >
      {OPTIONS.map((option) => (
        <Button
          key={option.id}
          type="button"
          size="sm"
          variant={value === option.id ? 'secondary' : 'ghost'}
          onClick={() => onChange(option.id)}
          title={option.hint}
          aria-checked={value === option.id}
          role="radio"
        >
          {option.label}
        </Button>
      ))}
    </div>
  )
}
