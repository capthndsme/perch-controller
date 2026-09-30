import { useEffect, useId, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { CheckCircle } from '@phosphor-icons/react'
import { ErrorLine } from '@/components/gateway-config/bits'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { PageSpinner, Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { SettingRow, SettingsGroup } from '@/components/wifi-config/rows'
import { useUpdateWifiConfigSettings, useWifiConfigSettings } from '@/hooks/use-wifi-config'
import { ApiError, fieldErrorsFromApi } from '@/lib/api'
import { countryOptions, wifiRefusalMessage } from '@/lib/wifi-config'
import { cn } from '@/lib/utils'
import type { WifiConfigNumericKey, WifiConfigSettings, WifiConfigSettingsView } from '@/types/wifi-config'

type NumberField = { key: WifiConfigNumericKey; label: string; unit: string; hint: string }

const GROUPS: Array<{ id: string; title: string; description: string; fields: NumberField[] }> = [
  {
    id: 'windows',
    title: 'Confirm windows',
    description: 'How long an access point waits for its confirmation before it restores its previous settings.',
    fields: [
      { key: 'confirmTimeoutSeconds', label: 'Confirm window', unit: 's', hint: 'Capped again by each access point’s own maximum.' },
      {
        key: 'managementConfirmTimeoutSeconds',
        label: 'Confirm window, uplink changes',
        unit: 's',
        hint: 'Changes to the network the access point reaches Perch through.',
      },
      { key: 'healthWaitSeconds', label: 'Health check waits up to', unit: 's', hint: 'For every network to come up after a change.' },
    ],
  },
  {
    id: 'watching',
    title: 'Watching the access points',
    description: 'How quickly edits made in LuCI reach Perch.',
    fields: [
      { key: 'watchSeconds', label: 'Check for edits every', unit: 's', hint: 'The fallback poll; LuCI edits usually arrive at once.' },
      { key: 'importDebounceSeconds', label: 'Wait for edits to settle', unit: 's', hint: 'Several quick edits import as one.' },
    ],
  },
  {
    id: 'authoritative',
    title: 'Authoritative Mode',
    description: 'What happens to edits on an access point when Perch’s settings win.',
    fields: [
      { key: 'authoritativeRevertDelaySeconds', label: 'Revert edits after', unit: 's', hint: 'Time to accept an edit instead.' },
      { key: 'enforcementMaxFailures', label: 'Suspend after failed reverts', unit: '', hint: 'Within the window below.' },
      { key: 'enforcementWindowMinutes', label: 'Failure window', unit: 'min', hint: '' },
    ],
  },
  {
    id: 'history',
    title: 'History',
    description: 'How much Perch keeps.',
    fields: [
      { key: 'keepRevisions', label: 'Revisions per access point', unit: '', hint: 'The newest one confirmed working is always kept.' },
      { key: 'auditRetentionDays', label: 'Keep activity for', unit: 'days', hint: '' },
    ],
  },
]

type Form = Omit<WifiConfigSettings, WifiConfigNumericKey> & Record<WifiConfigNumericKey, string>

function toForm(s: WifiConfigSettings): Form {
  const form = { ...s } as unknown as Form
  for (const g of GROUPS) for (const f of g.fields) form[f.key] = String(s[f.key])
  return form
}

function NumberRow({
  field,
  view,
  value,
  onChange,
  error,
}: {
  field: NumberField
  view: WifiConfigSettingsView
  value: string
  onChange: (value: string) => void
  error?: string
}) {
  const id = useId()
  const limit = view.limits[field.key]
  return (
    <SettingRow
      label={field.label}
      htmlFor={id}
      description={
        error ? (
          <span className="text-destructive">{error}</span>
        ) : (
          `${field.hint ? `${field.hint} ` : ''}${limit ? `${limit.min}–${limit.max}, ` : ''}default ${view.defaults[field.key]}${field.unit ? ` ${field.unit}` : ''}.`
        )
      }
      control={
        <div className="flex items-center gap-1.5">
          <Input
            id={id}
            inputMode="numeric"
            className="h-9 w-24 text-right font-mono"
            value={value}
            aria-invalid={error ? true : undefined}
            onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ''))}
          />
          {field.unit ? <span className="w-7 text-xs text-muted-foreground">{field.unit}</span> : <span className="w-7" />}
        </div>
      }
    />
  )
}

function SettingsForm({ view }: { view: WifiConfigSettingsView }) {
  const update = useUpdateWifiConfigSettings()
  const [form, setForm] = useState<Form>(() => toForm(view.settings))
  const [initial, setInitial] = useState(form)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fieldErrors = update.error ? fieldErrorsFromApi(update.error) : {}
  const dirty = JSON.stringify(form) !== JSON.stringify(initial)
  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setSaved(false)
    setForm((f) => ({ ...f, [key]: value }))
  }
  const countryId = useId()

  async function save() {
    setError(null)
    const patch: Partial<WifiConfigSettings> = {
      confirmMode: form.confirmMode,
      protectedConfirmMode: form.protectedConfirmMode,
      dfsAllowance: form.dfsAllowance,
      rolloutOrder: form.rolloutOrder,
      rolloutOfflinePolicy: form.rolloutOfflinePolicy,
      catchUpOnReconnect: form.catchUpOnReconnect,
      countryDefault: form.countryDefault,
      newNetworkFastRoaming: form.newNetworkFastRoaming,
      allowInsecureTransport: form.allowInsecureTransport,
      sealSecrets: form.sealSecrets,
    }
    for (const g of GROUPS) {
      for (const f of g.fields) {
        if (form[f.key] === '') {
          setError('Enter a whole number in every field.')
          return
        }
        ;(patch as Record<string, number>)[f.key] = Number(form[f.key])
      }
    }
    try {
      const next = await update.mutateAsync(patch)
      const fresh = toForm(next.settings)
      setForm(fresh)
      setInitial(fresh)
      setSaved(true)
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 422)) setError(wifiRefusalMessage(e))
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <SettingsGroup title="Confirming a change" description="How Perch knows a change works before it keeps it.">
        <SettingRow
          label="Ordinary WiFi changes"
          description={
            form.confirmMode === 'agent'
              ? 'Kept once the access point reconnects on a fresh connection, its networks come up and it checks in. Right when a change drops your own phone off the WiFi.'
              : 'Also waits for an admin to press Keep changes, like LuCI.'
          }
          stack
        >
          <Segmented
            size="xs"
            ariaLabel="Confirm mode"
            value={form.confirmMode}
            onChange={(v) => set('confirmMode', v)}
            options={[
              { id: 'agent', label: 'Access point checks in' },
              { id: 'admin_and_agent', label: '+ Keep changes' },
            ]}
            className="w-fit"
          />
        </SettingRow>
        <SettingRow
          label="Uplink changes"
          description="Changes to the network or radio the access point reaches Perch through."
          stack
        >
          <Segmented
            size="xs"
            ariaLabel="Uplink confirm mode"
            value={form.protectedConfirmMode}
            onChange={(v) => set('protectedConfirmMode', v)}
            options={[
              { id: 'agent', label: 'Access point checks in' },
              { id: 'admin_and_agent', label: '+ Keep changes' },
            ]}
            className="w-fit"
          />
        </SettingRow>
        <SettingRow
          label="Add radar-check time"
          description="A change on a DFS channel gets the radio’s radar check (usually 60 s) added to its window."
          control={<Switch checked={form.dfsAllowance} onCheckedChange={(v) => set('dfsAllowance', v)} aria-label="Add radar-check time" />}
        />
      </SettingsGroup>

      {GROUPS.slice(0, 1).map((g) => (
        <SettingsGroup key={g.id} id={g.id} title={g.title} description={g.description}>
          {g.fields.map((f) => (
            <NumberRow key={f.key} field={f} view={view} value={form[f.key]} onChange={(v) => set(f.key, v)} error={fieldErrors[f.key]} />
          ))}
        </SettingsGroup>
      ))}

      <SettingsGroup title="Rollouts" description="How a change travels across the access points.">
        <SettingRow
          label="Order"
          description={
            form.rolloutOrder === 'canary'
              ? 'Online access points with the fewest clients first; the one your own device is on goes last.'
              : 'By name.'
          }
          stack
        >
          <Segmented
            size="xs"
            ariaLabel="Rollout order"
            value={form.rolloutOrder}
            onChange={(v) => set('rolloutOrder', v)}
            options={[
              { id: 'canary', label: 'Fewest clients first' },
              { id: 'name', label: 'By name' },
            ]}
            className="w-fit"
          />
        </SettingRow>
        <SettingRow
          label="Offline access points"
          description={
            form.rolloutOfflinePolicy === 'skip'
              ? 'Skipped; they catch up when they come back.'
              : 'The rollout waits for them (or for you to skip them).'
          }
          stack
        >
          <Segmented
            size="xs"
            ariaLabel="Offline access points"
            value={form.rolloutOfflinePolicy}
            onChange={(v) => set('rolloutOfflinePolicy', v)}
            options={[
              { id: 'skip', label: 'Skip, catch up later' },
              { id: 'wait', label: 'Wait for them' },
            ]}
            className="w-fit"
          />
        </SettingRow>
        <SettingRow
          label="Catching up"
          description={
            form.catchUpOnReconnect === 'auto'
              ? 'An access point that missed a change gets it as soon as it reconnects: a missed passphrase change is a security fix.'
              : 'Perch asks before it sends missed changes.'
          }
          stack
        >
          <Segmented
            size="xs"
            ariaLabel="Catching up"
            value={form.catchUpOnReconnect}
            onChange={(v) => set('catchUpOnReconnect', v)}
            options={[
              { id: 'auto', label: 'Automatically' },
              { id: 'ask', label: 'Ask me' },
            ]}
            className="w-fit"
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup id="country" title="New networks and country">
        <SettingRow
          label="Fleet country"
          htmlFor={countryId}
          description="Written to every radio of access points that follow the fleet default. Empty leaves each access point’s own."
          stack
        >
          <select
            id={countryId}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-xs sm:w-72 dark:bg-input/30"
            value={form.countryDefault ?? ''}
            onChange={(e) => set('countryDefault', e.target.value || null)}
          >
            <option value="">Leave each access point’s</option>
            {countryOptions().map((c) => (
              <option key={c.code} value={c.code}>
                {c.name} ({c.code})
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow
          label="Fast roaming on new networks"
          description="802.11r starts on for networks created in Perch. Off by default: some older devices cannot join with it."
          control={
            <Switch checked={form.newNetworkFastRoaming} onCheckedChange={(v) => set('newNetworkFastRoaming', v)} aria-label="Fast roaming on new networks" />
          }
        />
      </SettingsGroup>

      {GROUPS.slice(1).map((g) => (
        <SettingsGroup key={g.id} id={g.id} title={g.title} description={g.description}>
          {g.fields.map((f) => (
            <NumberRow key={f.key} field={f} view={view} value={form[f.key]} onChange={(v) => set(f.key, v)} error={fieldErrors[f.key]} />
          ))}
        </SettingsGroup>
      ))}

      <SettingsGroup title="Plain HTTP" description="Only matters for access points that reach Perch without HTTPS.">
        <SettingRow
          label="Allow writes over plain HTTP"
          description="The controller’s half of the opt-in: the access point must allow it too, and be paired."
          control={
            <Switch
              checked={form.allowInsecureTransport}
              onCheckedChange={(v) => set('allowInsecureTransport', v)}
              aria-label="Allow writes over plain HTTP"
            />
          }
        />
        <SettingRow
          label="Seal passphrases"
          description="On a paired plain-HTTP connection, passphrases travel encrypted with the pairing key."
          control={<Switch checked={form.sealSecrets} onCheckedChange={(v) => set('sealSecrets', v)} aria-label="Seal passphrases" />}
        />
      </SettingsGroup>

      <div
        className={cn(
          'sticky bottom-[calc(var(--bottom-nav-height)+0.75rem)] z-20 lg:bottom-4',
          !dirty && !saved && !error && 'hidden',
        )}
      >
        <div className="card-surface flex flex-wrap items-center gap-2 px-3 py-2.5 shadow-lg">
          {error ? <ErrorLine message={error} /> : null}
          <p className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
            {saved && !dirty ? (
              <>
                <CheckCircle weight="fill" className="size-4 text-status-good" />
                Saved. Online access points pick it up right away.
              </>
            ) : (
              'Unsaved changes'
            )}
          </p>
          {dirty ? (
            <>
              <Button variant="ghost" size="lg" onClick={() => setForm(initial)} disabled={update.isPending}>
                Discard
              </Button>
              <Button size="lg" onClick={save} disabled={update.isPending}>
                {update.isPending ? <Spinner className="size-3.5 text-current" /> : null}
                Save
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** Settings → WiFi management (controller.md 8). */
export function WifiConfigSettingsPage() {
  const query = useWifiConfigSettings()
  const location = useLocation()
  const loaded = query.data !== undefined
  useEffect(() => {
    if (!loaded || !location.hash) return
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' })
  }, [loaded, location.hash])

  const header = (
    <PageHeader
      title="WiFi management"
      crumbs={[{ label: 'Settings', to: '/settings' }, { label: 'WiFi management' }]}
      description="How Perch confirms WiFi changes on access points, rolls them out, and watches for edits made in LuCI."
    />
  )
  if (query.data) {
    return (
      <div className="flex w-full max-w-3xl flex-col gap-5">
        {header}
        <SettingsForm view={query.data} />
      </div>
    )
  }
  if (query.error) {
    const message =
      query.error instanceof ApiError && query.error.status === 403
        ? 'Only admins can view this settings page.'
        : wifiRefusalMessage(query.error)
    return (
      <div className="flex w-full max-w-3xl flex-col gap-5">
        {header}
        <p className="text-sm text-destructive">{message}</p>
      </div>
    )
  }
  return <PageSpinner label="Loading WiFi settings" />
}
