import { useId, useState } from 'react'
import { BellRinging, CaretRight, WebhooksLogo } from '@phosphor-icons/react'
import { NumberField } from '@/components/alerts/number-field'
import { SeverityIcon } from '@/components/alerts/severity-icon'
import { Button } from '@/components/ui/button'
import { DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Drawer, DrawerContent } from '@/components/ui/drawer'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { useUpdateAlertSettings } from '@/hooks/use-alert-settings'
import { useRetained } from '@/hooks/use-retained'
import { fieldErrorsFromApi } from '@/lib/api'
import { intProblem, ruleLimit } from '@/lib/alert-settings'
import { CATEGORY_LABEL, formatDuration, SEVERITY_LABEL } from '@/lib/alerts'
import { cn } from '@/lib/utils'
import type { AlertSettingsView, AlertTypeView, Category, ParamDef, Rule, Severity } from '@/types/alerts'

type SeverityChoice = Rule['severity']

const SEVERITY_CHOICES: ReadonlyArray<{ id: SeverityChoice; label: string }> = [
  { id: 'auto', label: 'Default' },
  { id: 'info', label: 'Info' },
  { id: 'warning', label: 'Warning' },
  { id: 'critical', label: 'Critical' },
]

/** The severity a rule sends at: its own, or the type's default. */
function effectiveSeverity(rule: Rule, type: AlertTypeView): Severity {
  return rule.severity === 'auto' ? type.severity : rule.severity
}

function ruleSummary(rule: Rule, type: AlertTypeView): string {
  if (!rule.enabled) return 'Off'
  const parts: string[] = [SEVERITY_LABEL[effectiveSeverity(rule, type)]]
  if (!rule.notify) parts.push('inbox only')
  else if (!rule.push && !rule.webhooks) parts.push('no channel')
  if (type.kind === 'condition' && rule.notify) {
    parts.push(rule.holdSeconds > 0 ? `after ${formatDuration(rule.holdSeconds)}` : 'at once')
  }
  if (rule.groupSeconds > 0) parts.push(`grouped ${formatDuration(rule.groupSeconds)}`)
  return parts.join(' · ')
}

/**
 * Settings → Alerts: every alert type, grouped by category, one row each (name, what it sends, on/off). A
 * row opens its rule in a drawer: severity, channels, timing and the type's own parameters, checked against
 * the controller's limits. Types this controller cannot detect yet are greyed with the reason.
 */
export function RulesList({
  view,
  categoryLabels,
  openType,
  onOpenType,
}: {
  view: AlertSettingsView
  categoryLabels: Partial<Record<Category, string>>
  openType: string | null
  onOpenType: (type: string | null) => void
}) {
  const update = useUpdateAlertSettings()
  const [pendingType, setPendingType] = useState<string | null>(null)
  const byCategory = new Map<Category, AlertTypeView[]>()
  for (const type of view.catalogue) {
    const list = byCategory.get(type.category) ?? []
    list.push(type)
    byCategory.set(type.category, list)
  }
  const openDef = view.catalogue.find((t) => t.type === openType) ?? null
  const shownDef = useRetained(openDef)

  const toggle = (type: AlertTypeView, enabled: boolean) => {
    setPendingType(type.type)
    update.mutate({ rules: { [type.type]: { enabled } } }, { onSettled: () => setPendingType(null) })
  }

  return (
    <div className="space-y-4">
      {[...byCategory.entries()].map(([category, types]) => (
        <section key={category} className="card-surface overflow-hidden">
          <h3 className="border-b border-border px-4 py-2.5 text-[13px] font-semibold">
            {categoryLabels[category] ?? CATEGORY_LABEL[category]}
          </h3>
          <ul className="divide-y divide-border/70">
            {types.map((type) => {
              const rule = view.rules[type.type] ?? type.defaults
              const overridden = Object.keys(view.overrides[type.type] ?? {}).length > 0
              return (
                <li key={type.type} className={cn('flex items-center gap-3 pr-4', !type.available && 'opacity-60')}>
                  <button
                    type="button"
                    onClick={() => onOpenType(type.type)}
                    className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 text-left transition-colors duration-base hover:bg-muted/40 active:bg-muted/70 active:duration-0"
                  >
                    <SeverityIcon severity={effectiveSeverity(rule, type)} quiet={!rule.enabled} className="size-4" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] font-medium">{type.label}</span>
                        {overridden ? (
                          <span className="shrink-0 rounded-full bg-brand/10 px-1.5 text-[10px] font-medium text-brand">Changed</span>
                        ) : null}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {type.available ? type.description : (type.unavailableReason ?? 'Not available on this controller.')}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        {ruleSummary(rule, type)}
                        {rule.enabled && rule.notify && rule.push ? <BellRinging aria-label="Push" className="size-3" /> : null}
                        {rule.enabled && rule.notify && rule.webhooks ? <WebhooksLogo aria-label="Webhooks" className="size-3" /> : null}
                      </span>
                    </span>
                    <CaretRight className="size-3.5 shrink-0 text-muted-foreground" />
                  </button>
                  <Switch
                    checked={rule.enabled}
                    disabled={pendingType === type.type}
                    onCheckedChange={(enabled) => toggle(type, enabled)}
                    aria-label={`${type.label}: record alerts`}
                  />
                </li>
              )
            })}
          </ul>
        </section>
      ))}
      {update.error && !openDef ? <p className="text-xs text-destructive">{update.error.message}</p> : null}

      <Drawer open={openDef !== null} onOpenChange={(open) => (open ? undefined : onOpenType(null))}>
        <DrawerContent aria-describedby={undefined} className="sm:max-w-lg">
          {shownDef ? (
            <RuleForm
              key={shownDef.type}
              type={shownDef}
              view={view}
              onClose={() => onOpenType(null)}
            />
          ) : null}
        </DrawerContent>
      </Drawer>
    </div>
  )
}

type Form = {
  severity: SeverityChoice
  notify: boolean
  push: boolean
  webhooks: boolean
  notifyRecovery: boolean
  numbers: Record<NumberKey, string>
  params: Record<string, number | boolean | string | string[] | undefined>
  paramText: Record<string, string>
}

type NumberKey =
  | 'holdSeconds'
  | 'recoveryHoldSeconds'
  | 'flapThreshold'
  | 'flapWindowMinutes'
  | 'groupSeconds'
  | 'dedupeMinutes'
  | 'repeatMinutes'
  | 'maxPerHour'

const CONDITION_FIELDS: ReadonlyArray<{ key: NumberKey; label: string; unit: string; hint: string }> = [
  { key: 'holdSeconds', label: 'Hold', unit: 's', hint: 'How long it must hold before anyone is notified.' },
  { key: 'recoveryHoldSeconds', label: 'Recovery hold', unit: 's', hint: 'How long it must stay clear before “back”.' },
  { key: 'flapThreshold', label: 'Flapping after', unit: 'changes', hint: '0 turns flap damping off.' },
  { key: 'flapWindowMinutes', label: 'Flap window', unit: 'min', hint: 'Changes within this window count.' },
  { key: 'repeatMinutes', label: 'Remind every', unit: 'min', hint: 'Until acknowledged; 0 = never.' },
  { key: 'groupSeconds', label: 'Group for', unit: 's', hint: 'Several at once become one message.' },
  { key: 'maxPerHour', label: 'At most', unit: 'per hour', hint: '0 = no limit; the rest stays in the inbox.' },
]

const NOTICE_FIELDS: ReadonlyArray<{ key: NumberKey; label: string; unit: string; hint: string }> = [
  { key: 'dedupeMinutes', label: 'Merge repeats within', unit: 'min', hint: 'The same notice again counts up instead.' },
  { key: 'groupSeconds', label: 'Group for', unit: 's', hint: 'Several at once become one message.' },
  { key: 'maxPerHour', label: 'At most', unit: 'per hour', hint: '0 = no limit; the rest stays in the inbox.' },
]

function toForm(rule: Rule, type: AlertTypeView): Form {
  const numbers = {} as Record<NumberKey, string>
  for (const key of [...CONDITION_FIELDS, ...NOTICE_FIELDS].map((f) => f.key)) numbers[key] = String(rule[key])
  const params: Form['params'] = {}
  const paramText: Record<string, string> = {}
  for (const def of type.params) {
    const value = rule.params[def.key] ?? def.default
    params[def.key] = value
    if (def.kind === 'int') paramText[def.key] = String(value)
    if (def.kind === 'list') paramText[def.key] = Array.isArray(value) ? value.join('\n') : ''
  }
  return {
    severity: rule.severity,
    notify: rule.notify,
    push: rule.push,
    webhooks: rule.webhooks,
    notifyRecovery: rule.notifyRecovery,
    numbers,
    params,
    paramText,
  }
}

function listItems(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function paramProblem(def: ParamDef, text: string | undefined): string | null {
  if (def.kind === 'int') return intProblem(text ?? '', { min: def.min, max: def.max })
  if (def.kind === 'list') {
    const items = listItems(text ?? '')
    if (items.length > def.maxItems) return `At most ${def.maxItems} entries.`
    if (items.some((item) => item.length > def.maxLength)) return `Each at most ${def.maxLength} characters.`
  }
  return null
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function RuleForm({ type, view, onClose }: { type: AlertTypeView; view: AlertSettingsView; onClose: () => void }) {
  const rule = view.rules[type.type] ?? type.defaults
  const [form, setForm] = useState<Form>(() => toForm(rule, type))
  const [problem, setProblem] = useState<string | null>(null)
  const update = useUpdateAlertSettings()
  const id = useId()
  const serverErrors = Object.fromEntries(
    Object.entries(fieldErrorsFromApi(update.error)).map(([field, message]) => [field.replace(`rules.${type.type}.`, ''), message]),
  )
  const fields = type.kind === 'condition' ? CONDITION_FIELDS : NOTICE_FIELDS
  const overridden = Object.keys(view.overrides[type.type] ?? {}).length > 0

  const setNumber = (key: NumberKey, value: string) => setForm((f) => ({ ...f, numbers: { ...f.numbers, [key]: value } }))

  function save() {
    setProblem(null)
    for (const field of fields) {
      if (intProblem(form.numbers[field.key], ruleLimit(view.limits, field.key), { zeroOr: field.key === 'repeatMinutes' })) {
        return setProblem(`Check “${field.label}”.`)
      }
    }
    for (const def of type.params) {
      if (paramProblem(def, form.paramText[def.key])) return setProblem(`Check “${def.label}”.`)
    }
    const patch: Record<string, unknown> = {}
    const next = {
      severity: form.severity,
      notify: form.notify,
      push: form.push,
      webhooks: form.webhooks,
      ...(type.kind === 'condition' ? { notifyRecovery: form.notifyRecovery } : {}),
    }
    for (const [key, value] of Object.entries(next)) {
      if (!sameValue(rule[key as keyof Rule], value)) patch[key] = value
    }
    for (const field of fields) {
      const value = Number(form.numbers[field.key])
      if (rule[field.key] !== value) patch[field.key] = value
    }
    const params: Rule['params'] = {}
    for (const def of type.params) {
      const value =
        def.kind === 'int'
          ? Number(form.paramText[def.key])
          : def.kind === 'list'
            ? listItems(form.paramText[def.key] ?? '')
            : form.params[def.key]
      if (value !== undefined && !sameValue(rule.params[def.key] ?? def.default, value)) params[def.key] = value
    }
    if (Object.keys(params).length > 0) patch.params = params
    if (Object.keys(patch).length === 0) return onClose()
    update.mutate({ rules: { [type.type]: patch } }, { onSuccess: onClose })
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{type.label}</DialogTitle>
        <DialogDescription>{type.description}</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-5">
        {!type.available ? (
          <p className="rounded-md border border-status-warning/40 bg-status-warning/5 px-3 py-2">
            {type.unavailableReason ?? 'Not available on this controller yet.'} The rule is kept for when it is.
          </p>
        ) : null}
        <div className="space-y-1.5">
          <p className="text-xs font-medium">Severity</p>
          <Segmented
            size="xs"
            ariaLabel="Severity"
            value={form.severity}
            onChange={(severity) => setForm((f) => ({ ...f, severity }))}
            options={SEVERITY_CHOICES.map((choice) =>
              choice.id === 'auto' ? { ...choice, label: `Default (${SEVERITY_LABEL[type.severity]})` } : choice,
            )}
            className="w-fit flex-wrap"
          />
          <p className="text-xs text-muted-foreground">
            Push devices take warning and up unless they choose otherwise; the inbox keeps everything.
          </p>
        </div>

        <div className="space-y-2.5">
          <ToggleRow
            id={`${id}-notify`}
            label="Notify"
            hint="Off: it stays in the inbox, nothing is sent."
            checked={form.notify}
            onChange={(notify) => setForm((f) => ({ ...f, notify }))}
          />
          <ToggleRow
            id={`${id}-push`}
            label="Push to devices"
            checked={form.push}
            disabled={!form.notify}
            onChange={(push) => setForm((f) => ({ ...f, push }))}
          />
          <ToggleRow
            id={`${id}-webhooks`}
            label="Send to webhooks"
            checked={form.webhooks}
            disabled={!form.notify}
            onChange={(webhooks) => setForm((f) => ({ ...f, webhooks }))}
          />
          {type.kind === 'condition' ? (
            <ToggleRow
              id={`${id}-recovery`}
              label="Say when it is over"
              hint="A “back online” notice after the recovery hold."
              checked={form.notifyRecovery}
              disabled={!form.notify}
              onChange={(notifyRecovery) => setForm((f) => ({ ...f, notifyRecovery }))}
            />
          ) : null}
        </div>

        <div className="space-y-3">
          <p className="section-label">Timing and limits</p>
          <div className="grid gap-4 sm:grid-cols-2">
            {fields.map((field) => (
              <NumberField
                key={field.key}
                id={`${id}-${field.key}`}
                label={field.label}
                unit={field.unit}
                hint={field.hint}
                value={form.numbers[field.key]}
                onChange={(value) => setNumber(field.key, value)}
                limit={ruleLimit(view.limits, field.key)}
                zeroOr={field.key === 'repeatMinutes'}
                error={serverErrors[field.key]}
              />
            ))}
          </div>
        </div>

        {type.params.length > 0 ? (
          <div className="space-y-3">
            <p className="section-label">{type.label}</p>
            <div className="space-y-4">
              {type.params.map((def) => (
                <ParamField
                  key={def.key}
                  id={`${id}-p-${def.key}`}
                  def={def}
                  form={form}
                  setForm={setForm}
                  error={serverErrors[`params.${def.key}`]}
                />
              ))}
            </div>
          </div>
        ) : null}

        {problem || (update.error && Object.keys(serverErrors).length === 0) ? (
          <p className="text-destructive">{problem ?? update.error?.message}</p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        {overridden ? (
          <Button
            variant="ghost"
            className="sm:mr-auto"
            disabled={update.isPending}
            onClick={() => update.mutate({ rules: { [type.type]: null } }, { onSuccess: onClose })}
          >
            Reset to defaults
          </Button>
        ) : null}
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={save} disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </>
  )
}

function ToggleRow({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string
  label: string
  hint?: string
  checked: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label htmlFor={id} className={cn('flex items-center justify-between gap-4', disabled && 'opacity-50')}>
      <span className="space-y-0.5">
        <span className="block text-xs font-medium">{label}</span>
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </label>
  )
}

function ParamField({
  id,
  def,
  form,
  setForm,
  error,
}: {
  id: string
  def: ParamDef
  form: Form
  setForm: React.Dispatch<React.SetStateAction<Form>>
  error?: string
}) {
  const setText = (value: string) => setForm((f) => ({ ...f, paramText: { ...f.paramText, [def.key]: value } }))
  if (def.kind === 'int') {
    return (
      <NumberField
        id={id}
        label={def.label}
        unit={def.unit}
        value={form.paramText[def.key] ?? ''}
        onChange={setText}
        limit={{ min: def.min, max: def.max }}
        error={error}
      />
    )
  }
  if (def.kind === 'bool') {
    return (
      <ToggleRow
        id={id}
        label={def.label}
        checked={Boolean(form.params[def.key])}
        onChange={(value) => setForm((f) => ({ ...f, params: { ...f.params, [def.key]: value } }))}
      />
    )
  }
  if (def.kind === 'enum') {
    return (
      <div className="space-y-1.5">
        <p className="text-xs font-medium">{def.label}</p>
        <Segmented
          size="xs"
          ariaLabel={def.label}
          value={String(form.params[def.key] ?? def.default)}
          onChange={(value) => setForm((f) => ({ ...f, params: { ...f.params, [def.key]: value } }))}
          options={def.options.map((option) => ({ id: option, label: option }))}
          className="w-fit"
        />
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    )
  }
  const problem = error ?? paramProblem(def, form.paramText[def.key])
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium">
        {def.label}
      </label>
      <textarea
        id={id}
        rows={3}
        value={form.paramText[def.key] ?? ''}
        onChange={(event) => setText(event.target.value)}
        className="w-full rounded-md border border-input bg-transparent px-2.5 py-1.5 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30"
      />
      <p className={cn('text-xs', problem ? 'text-destructive' : 'text-muted-foreground')}>
        {problem ?? `One per line, up to ${def.maxItems}.`}
      </p>
    </div>
  )
}
