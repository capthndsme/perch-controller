import { useState, type ReactNode } from 'react'
import { CheckCircle } from '@phosphor-icons/react'
import { FormError } from '@/components/setup/form-field'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Segmented } from '@/components/ui/segmented'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useUpdateAgentUpdateSettings } from '@/hooks/use-agent-updates'
import { ApiError, fieldErrorsFromApi } from '@/lib/api'
import {
  AUTO_UPDATE_HINT,
  AUTO_UPDATE_LABEL,
  CHANNEL_HINT,
  CHANNEL_LABEL,
  refusalMessage,
  WEEKDAYS,
} from '@/lib/agent-updates'
import { cn } from '@/lib/utils'
import type {
  AgentUpdateNumericSetting,
  AgentUpdateSettings,
  AgentUpdateSettingsView,
  AutoUpdate,
  Channel,
} from '@/types/agent-updates'

type NumberForm = Record<AgentUpdateNumericSetting, string>
type Rest = Omit<AgentUpdateSettings, AgentUpdateNumericSetting>

const NUMERIC_KEYS: AgentUpdateNumericSetting[] = [
  'githubCheckIntervalHours',
  'keepReleases',
  'probationSeconds',
  'stableSeconds',
  'minPushes',
  'confirmGraceSeconds',
  'crashLoopRestarts',
  'downloadTimeoutSeconds',
  'downloadRateKbps',
  'flashReserveKiB',
  'ramReserveMiB',
  'keepPreviousMinFreeKiB',
  'batchSize',
  'batchGapSeconds',
  'canaryObserveMinutes',
  'offlineWaitMinutes',
  'queueExpiryHours',
  'historyDays',
]

function numbersOf(settings: AgentUpdateSettings): NumberForm {
  return Object.fromEntries(NUMERIC_KEYS.map((k) => [k, String(settings[k])])) as NumberForm
}

function restOf(settings: AgentUpdateSettings): Rest {
  const rest: Record<string, unknown> = { ...settings }
  for (const k of NUMERIC_KEYS) delete rest[k]
  return rest as Rest
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/** The window in words: "Mon–Fri 02:00–05:00", with the midnight crossing spelled out. */
function windowText(days: number[], start: string, end: string, timezone: string | null): string {
  const sorted = [...days].sort((a, b) => a - b)
  let dayText: string
  if (sorted.length === 7) dayText = 'Every day'
  else if (sorted.length === 0) dayText = 'No day'
  else if (sorted.join() === '1,2,3,4,5') dayText = 'Mon–Fri'
  else if (sorted.join() === '0,6') dayText = 'Weekends'
  else dayText = sorted.map((d) => WEEKDAYS[d]).join(', ')
  const crosses = TIME.test(start) && TIME.test(end) && end <= start
  return `${dayText}, ${start}–${end}${crosses ? ' (ends the next morning)' : ''}${timezone ? `, ${timezone} time` : ''}`
}

/**
 * Settings → Updates → Settings: every tunable of the design (controller.md
 * section 8) with its default and range, saved as one partial PATCH of what
 * changed.
 */
export function AgentUpdateSettingsForm({ view, timezone }: { view: AgentUpdateSettingsView; timezone: string | null }) {
  const update = useUpdateAgentUpdateSettings()
  const [numbers, setNumbers] = useState<NumberForm>(() => numbersOf(view.settings))
  const [rest, setRest] = useState<Rest>(() => restOf(view.settings))
  const [keysText, setKeysText] = useState(() => view.settings.extraTrustedKeys.join('\n'))
  const [formError, setFormError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const fieldErrors = update.error ? fieldErrorsFromApi(update.error) : {}

  const set = <K extends keyof Rest>(key: K, value: Rest[K]) => {
    setSaved(false)
    setRest((r) => ({ ...r, [key]: value }))
  }

  function num(key: AgentUpdateNumericSetting, label: string, hint?: string) {
    const limit = view.limits[key]
    const value = numbers[key]
    const parsed = Number(value)
    const outOfRange = limit && value.trim() !== '' && (!Number.isInteger(parsed) || parsed < limit.min || parsed > limit.max)
    return (
      <div className="space-y-1">
        <Label htmlFor={`au-${key}`} className="text-xs font-medium">
          {label}
        </Label>
        <Input
          id={`au-${key}`}
          inputMode="numeric"
          className="rounded-md"
          value={value}
          aria-invalid={fieldErrors[key] || outOfRange ? true : undefined}
          onChange={(event) => {
            setSaved(false)
            setNumbers((n) => ({ ...n, [key]: event.target.value }))
          }}
        />
        <p className={cn('text-[11px]', fieldErrors[key] ? 'text-destructive' : 'text-muted-foreground')}>
          {fieldErrors[key] ??
            [hint, `Default ${view.defaults[key]}`, limit ? `${limit.min}–${limit.max}` : null].filter(Boolean).join(' · ')}
        </p>
      </div>
    )
  }

  function toggle(key: 'githubCheck' | 'prefetch' | 'windowEnabled' | 'allowRamRollbackOnAps' | 'stopOnFailure', label: string, hint: ReactNode) {
    return (
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor={`au-${key}`} className="text-xs font-medium">
            {label}
          </Label>
          <p className="text-[11px] text-muted-foreground">
            {hint} Default {view.defaults[key] ? 'on' : 'off'}.
          </p>
        </div>
        <Switch id={`au-${key}`} checked={rest[key]} onCheckedChange={(next) => set(key, next)} aria-label={label} />
      </div>
    )
  }

  function resetToDefaults() {
    update.reset()
    setFormError(null)
    setSaved(false)
    setNumbers(numbersOf(view.defaults))
    setRest(restOf(view.defaults))
    setKeysText(view.defaults.extraTrustedKeys.join('\n'))
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFormError(null)
    setSaved(false)
    const patch: Partial<AgentUpdateSettings> = {}
    for (const key of NUMERIC_KEYS) {
      const n = Number(numbers[key])
      if (numbers[key].trim() === '' || !Number.isInteger(n)) {
        setFormError('Enter a whole number in every number field.')
        return
      }
      if (n !== view.settings[key]) patch[key] = n
    }
    if (!TIME.test(rest.windowStart) || !TIME.test(rest.windowEnd)) {
      setFormError('Enter the window’s start and end as HH:MM.')
      return
    }
    const keys = keysText.split('\n').map((l) => l.trim()).filter(Boolean)
    if (keys.length > 8) {
      setFormError('At most 8 extra keys.')
      return
    }
    const next = { ...rest, extraTrustedKeys: keys } as Rest
    for (const key of Object.keys(next) as (keyof Rest)[]) {
      if (JSON.stringify(next[key]) !== JSON.stringify(view.settings[key])) {
        ;(patch as Record<string, unknown>)[key] = next[key]
      }
    }
    if (Object.keys(patch).length === 0) {
      setSaved(true)
      return
    }
    try {
      const view2 = await update.mutateAsync(patch)
      setNumbers(numbersOf(view2.settings))
      setRest(restOf(view2.settings))
      setKeysText(view2.settings.extraTrustedKeys.join('\n'))
      setSaved(true)
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 422 || Object.keys(fieldErrorsFromApi(error)).length === 0) {
        setFormError(refusalMessage(error))
      }
    }
  }

  const days = rest.windowDays

  return (
    <form onSubmit={onSubmit} className="card-surface max-w-3xl">
      <div className="space-y-7 p-4 sm:p-5">
        {formError ? <FormError message={formError} /> : null}
        {saved ? (
          <Alert className="rounded-lg border-primary/20 bg-primary/5">
            <CheckCircle className="size-4 text-primary" />
            <AlertTitle>Saved</AlertTitle>
            <AlertDescription>Update settings apply from the next check.</AlertDescription>
          </Alert>
        ) : null}

        <Section title="Automatic updates" description="What happens when a newer release appears on a device’s channel.">
          {(['autoUpdateAp', 'autoUpdateCollector'] as const).map((key) => (
            <div key={key} className="space-y-1.5">
              <p className="text-xs font-medium">{key === 'autoUpdateAp' ? 'Access points (perch-apd)' : 'Gateways and collectors (perch-collector)'}</p>
              <Segmented<AutoUpdate>
                value={rest[key]}
                onChange={(next) => set(key, next)}
                options={(['off', 'notify', 'auto'] as AutoUpdate[]).map((a) => ({ id: a, label: AUTO_UPDATE_LABEL[a] }))}
                ariaLabel={key === 'autoUpdateAp' ? 'Access points' : 'Gateways and collectors'}
                size="xs"
                className="w-fit"
              />
              <p className="text-[11px] text-muted-foreground">
                {AUTO_UPDATE_HINT[rest[key]]}
                {key === 'autoUpdateCollector' && rest[key] === 'auto'
                  ? ' A gateway carries the network: most people keep it on Notify.'
                  : ''}{' '}
                Default {AUTO_UPDATE_LABEL[view.defaults[key]]}. A device can override it.
              </p>
            </div>
          ))}
          <div className="space-y-1.5">
            <p className="text-xs font-medium">Default channel</p>
            <Segmented<Channel>
              value={rest.defaultChannel}
              onChange={(next) => set('defaultChannel', next)}
              options={(['stable', 'pre', 'local'] as Channel[]).map((c) => ({ id: c, label: CHANNEL_LABEL[c] }))}
              ariaLabel="Default channel"
              size="xs"
              className="w-fit"
            />
            <p className="text-[11px] text-muted-foreground">
              {CHANNEL_HINT[rest.defaultChannel]} Default {CHANNEL_LABEL[view.defaults.defaultChannel]}.
            </p>
          </div>
        </Section>

        <Section
          title="Maintenance window"
          description="Updates and rollout batches marked for the window only start inside it; nothing is interrupted when it closes."
        >
          {toggle('windowEnabled', 'Use a maintenance window', 'Automatic rollouts always wait for it.')}
          <div className={cn('space-y-3', !rest.windowEnabled && 'opacity-50')}>
            <div className="space-y-1.5">
              <p className="text-xs font-medium">Days</p>
              <div className="flex flex-wrap gap-1" role="group" aria-label="Window days">
                {WEEKDAYS.map((label, day) => {
                  const on = days.includes(day)
                  return (
                    <Button
                      key={label}
                      type="button"
                      size="xs"
                      variant={on ? 'secondary' : 'outline'}
                      aria-pressed={on}
                      disabled={!rest.windowEnabled}
                      className={cn('w-11', on && 'bg-foreground/[0.07] ring-1 ring-foreground/15 dark:bg-secondary dark:ring-0')}
                      onClick={() => set('windowDays', on ? days.filter((d) => d !== day) : [...days, day].sort((a, b) => a - b))}
                    >
                      {label}
                    </Button>
                  )
                })}
              </div>
            </div>
            <div className="grid max-w-xs grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="au-windowStart" className="text-xs font-medium">
                  Opens
                </Label>
                <Input
                  id="au-windowStart"
                  type="time"
                  className="rounded-md"
                  value={rest.windowStart}
                  disabled={!rest.windowEnabled}
                  onChange={(event) => set('windowStart', event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="au-windowEnd" className="text-xs font-medium">
                  Closes
                </Label>
                <Input
                  id="au-windowEnd"
                  type="time"
                  className="rounded-md"
                  value={rest.windowEnd}
                  disabled={!rest.windowEnabled}
                  onChange={(event) => set('windowEnd', event.target.value)}
                />
              </div>
            </div>
            <p className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              {windowText(days, rest.windowStart, rest.windowEnd, timezone)}. The time zone is the instance’s.
            </p>
          </div>
        </Section>

        <Section
          title="The health check"
          description="After an update the new version must reconnect and report; until the controller confirms it, the device goes back to the previous version on its own."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {num('probationSeconds', 'Deadline after the restart (s)', 'The device rolls back after this')}
            {num('stableSeconds', 'Connected before the confirm (s)')}
            {num('minPushes', 'Reports before the confirm')}
            {num('confirmGraceSeconds', 'Grace after the deadline (s)', 'Then the job shows “no word”')}
            {num('crashLoopRestarts', 'Restarts that count as a crash loop')}
          </div>
        </Section>

        <Section title="Space and downloads" description="What the device must keep free, and how it downloads.">
          <div className="grid gap-4 sm:grid-cols-2">
            {num('flashReserveKiB', 'Flash kept free (KiB)')}
            {num('ramReserveMiB', 'Memory kept free (MiB)')}
            {num('keepPreviousMinFreeKiB', 'Keep the previous version above (KiB free)', 'Else it is deleted after the confirm')}
            {num('downloadTimeoutSeconds', 'Download timeout (s)')}
            {num('downloadRateKbps', 'Download rate limit (kbit/s)', '0 = unlimited')}
          </div>
          {toggle(
            'allowRamRollbackOnAps',
            'Let access points keep the previous version in memory',
            'When the flash is too small to keep it. A restart during the check fetches it again from this controller. Gateways always keep it on flash.',
          )}
        </Section>

        <Section title="Rollouts" description="What a new rollout starts with; each rollout can change them.">
          <div className="grid gap-4 sm:grid-cols-2">
            {num('batchSize', 'Devices per batch')}
            {num('batchGapSeconds', 'Between batches (s)')}
            {num('canaryObserveMinutes', 'Watch the canary (min)')}
            {num('offlineWaitMinutes', 'Wait for an offline device (min)')}
          </div>
          {toggle('stopOnFailure', 'Pause on a failure', 'Otherwise the device is skipped and the rollout goes on.')}
        </Section>

        <Section title="Releases" description="Where releases come from and how many stay on this controller.">
          {toggle('githubCheck', 'Check GitHub for releases', 'Off: GitHub is only contacted when you press “Check for releases”.')}
          {toggle('prefetch', 'Fetch files ahead of time', 'Downloads the files your devices will need when a release appears.')}
          <div className="grid gap-4 sm:grid-cols-2">
            {num('githubCheckIntervalHours', 'Check every (hours)')}
            {num('keepReleases', 'Releases kept per product', 'Plus any a device runs or keeps')}
          </div>
          <div className="space-y-1">
            <Label htmlFor="au-keys" className="text-xs font-medium">
              Extra trusted keys
            </Label>
            <textarea
              id="au-keys"
              rows={3}
              spellCheck={false}
              className="w-full rounded-md border border-input bg-transparent px-2.5 py-1.5 font-mono text-[11px] outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30"
              placeholder="One signify public key per line"
              value={keysText}
              onChange={(event) => {
                setSaved(false)
                setKeysText(event.target.value)
              }}
            />
            <p className={cn('text-[11px]', fieldErrors.extraTrustedKeys ? 'text-destructive' : 'text-muted-foreground')}>
              {fieldErrors.extraTrustedKeys ??
                'For a lab signing key. Only checks releases on this controller: each device trusts the keys it was built with, plus its own list.'}
            </p>
          </div>
        </Section>

        <Section title="Housekeeping">
          <div className="grid gap-4 sm:grid-cols-2">
            {num('queueExpiryHours', 'A queued update expires after (hours)')}
            {num('historyDays', 'History kept (days)')}
          </div>
        </Section>
      </div>
      {/* A long form: Save stays in reach, above the phone's tab bar. */}
      <div className="sticky bottom-(--bottom-nav-height) z-10 flex flex-wrap items-center justify-end gap-2 rounded-b-lg border-t bg-card px-4 py-3">
        <Button type="button" variant="ghost" onClick={resetToDefaults}>
          Reset to defaults
        </Button>
        <Button type="submit" disabled={update.isPending}>
          {update.isPending ? <Spinner className="size-3.5 text-current" /> : null}
          Save
        </Button>
      </div>
    </form>
  )
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="space-y-4 border-t pt-6 first-of-type:border-t-0 first-of-type:pt-0">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{title}</h3>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  )
}
