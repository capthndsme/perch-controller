import { ChipRow, FilterChip } from '@/components/alerts/alert-filters'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { CATEGORIES, CATEGORY_SHORT } from '@/lib/alerts'
import type { Category, Filters, Severity } from '@/types/alerts'

const SEVERITY_OPTIONS: ReadonlyArray<{ id: Severity; label: string; title: string }> = [
  { id: 'info', label: 'Everything', title: 'Info, warning and critical' },
  { id: 'warning', label: 'Warning+', title: 'Warning and critical' },
  { id: 'critical', label: 'Critical', title: 'Critical only' },
]

/**
 * What a destination (a device, a webhook) receives: lowest severity, categories, and whether quiet hours
 * hold its messages. Every change goes out at once as a partial `Filters`.
 */
export function FiltersEditor({
  value,
  onChange,
  categories = CATEGORIES,
  disabled = false,
  idPrefix,
}: {
  value: Filters
  onChange: (patch: Partial<Filters>) => void
  categories?: readonly Category[]
  disabled?: boolean
  idPrefix: string
}) {
  const all = value.categories === null
  const toggle = (key: Category) => {
    const current = value.categories ?? []
    const next = current.includes(key) ? current.filter((c) => c !== key) : [...current, key]
    onChange({ categories: next.length === 0 ? null : next })
  }
  return (
    // min-w-0: a fieldset is at least as wide as its content, and the chip row scrolls instead.
    <fieldset disabled={disabled} className="min-w-0 space-y-3 disabled:opacity-60">
      <div className="space-y-1.5">
        <p className="text-xs font-medium">Severity</p>
        <Segmented
          size="xs"
          ariaLabel="Lowest severity sent"
          value={value.minSeverity}
          onChange={(minSeverity) => onChange({ minSeverity })}
          options={SEVERITY_OPTIONS}
          className="w-fit"
        />
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-medium">Categories</p>
        <ChipRow label="Categories">
          <FilterChip pressed={all} onClick={() => onChange({ categories: null })}>
            All
          </FilterChip>
          {categories.map((key) => (
            <FilterChip key={key} pressed={!all && value.categories!.includes(key)} onClick={() => toggle(key)}>
              {CATEGORY_SHORT[key]}
            </FilterChip>
          ))}
        </ChipRow>
      </div>
      <label htmlFor={`${idPrefix}-quiet`} className="flex items-start justify-between gap-4">
        <span className="space-y-0.5">
          <span className="block text-xs font-medium">Hold during quiet hours</span>
          <span className="block text-xs text-muted-foreground">
            Held messages arrive as one summary when quiet hours end; critical ones break through.
          </span>
        </span>
        <Switch
          id={`${idPrefix}-quiet`}
          checked={value.quietHours === 'inherit'}
          onCheckedChange={(on) => onChange({ quietHours: on ? 'inherit' : 'ignore' })}
          disabled={disabled}
        />
      </label>
    </fieldset>
  )
}
