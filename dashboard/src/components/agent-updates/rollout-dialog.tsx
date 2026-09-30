import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { SELECT_CLASS } from '@/components/agent-updates/update-dialog'
import { ChannelBadge } from '@/components/agent-updates/version-badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Segmented } from '@/components/ui/segmented'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useAgentReleases, useAgentUpdateSettings, useCreateRollout } from '@/hooks/use-agent-updates'
import { apiErrorCode, fieldErrorsFromApi } from '@/lib/api'
import { formatBytes } from '@/lib/format-bytes'
import {
  compareVersions,
  METHOD_HINT,
  METHOD_LABEL,
  PRODUCT_DEVICES,
  PRODUCTS,
  refusalField,
  refusalMessage,
} from '@/lib/agent-updates'
import { cn } from '@/lib/utils'
import type { AgentFleet, AgentProduct, AgentRollout, AgentUpdateDevice, UpdateMethod } from '@/types/agent-updates'

type Preset = { product: AgentProduct; version?: string }

type RolloutDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  fleet: AgentFleet | undefined
  preset: Preset | null
  onCreated: (rollout: AgentRollout) => void
}

export function RolloutDialog({ open, onOpenChange, fleet, preset, onCreated }: RolloutDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide>
        {/* Radix unmounts the content once closed, so every open starts a fresh form. */}
        <RolloutForm
          fleet={fleet}
          preset={preset}
          onCreated={(rollout) => {
            onOpenChange(false)
            onCreated(rollout)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

/** Why a device cannot take `version`, or null when it can. */
function ineligible(device: AgentUpdateDevice, version: string | null): string | null {
  if (!device.selfUpdate.supported) return 'Needs a manual update'
  if (device.pinnedVersion) return `Held at ${device.pinnedVersion}`
  if (!version) return null
  const cmp = compareVersions(device.version, version)
  if (cmp === 0) return 'Already on it'
  if (cmp > 0) return `Runs a newer ${device.version}`
  return null
}

/** The suggested canary: for access points the one with the most free flash; else the first. */
function suggestCanary(devices: AgentUpdateDevice[]): string | null {
  if (devices.length === 0) return null
  const online = devices.filter((d) => d.online)
  const pool = online.length > 0 ? online : devices
  const best = [...pool].sort((a, b) => (b.selfUpdate.flash?.freeBytes ?? 0) - (a.selfUpdate.flash?.freeBytes ?? 0))[0]
  return best.key
}

type Pacing = { batchSize: string; batchGapSeconds: string; canaryObserveMinutes: string; offlineWaitMinutes: string }

function RolloutForm({
  fleet,
  preset,
  onCreated,
}: {
  fleet: AgentFleet | undefined
  preset: Preset | null
  onCreated: (rollout: AgentRollout) => void
}) {
  const settings = useAgentUpdateSettings()
  const create = useCreateRollout()
  const [product, setProduct] = useState<AgentProduct>(preset?.product ?? 'perch-apd')
  const releases = useAgentReleases(product)
  const choices = useMemo(
    () => (releases.data ?? []).filter((r) => r.product === product && r.offerable).sort((a, b) => compareVersions(b.version, a.version)),
    [releases.data, product],
  )
  const [picked, setPicked] = useState<string | null>(preset?.version ?? null)
  const version = picked && choices.some((r) => r.version === picked) ? picked : (choices[0]?.version ?? null)
  const release = choices.find((r) => r.version === version) ?? null

  const devices = useMemo(() => (fleet?.devices ?? []).filter((d) => d.product === product), [fleet, product])
  const eligible = devices.filter((d) => ineligible(d, version) === null)
  const [unticked, setUnticked] = useState<Set<string>>(() => new Set())
  const chosen = eligible.filter((d) => !unticked.has(d.key))
  const suggested = suggestCanary(chosen)
  const [canaryPick, setCanaryPick] = useState<string | null>(null)
  const canary = canaryPick && chosen.some((d) => d.key === canaryPick) ? canaryPick : suggested

  const defaults = settings.data?.settings
  const [pacing, setPacing] = useState<Partial<Pacing>>({})
  const pacingValue = (key: keyof Pacing) => pacing[key] ?? (defaults ? String(defaults[key]) : '')
  const [stopOnFailure, setStopOnFailure] = useState<boolean | null>(null)
  const [respectWindow, setRespectWindow] = useState(false)
  const [method, setMethod] = useState<'auto' | UpdateMethod>('auto')
  const [acceptUnrecoverable, setAcceptUnrecoverable] = useState(false)

  const number = (key: keyof Pacing) => {
    const raw = pacing[key]
    if (raw === undefined || raw.trim() === '') return undefined
    const n = Number(raw)
    return Number.isInteger(n) ? n : undefined
  }
  const badNumber = (Object.keys(pacing) as (keyof Pacing)[]).some((k) => pacing[k]?.trim() !== '' && number(k) === undefined)

  async function submit() {
    if (!version) return
    try {
      const rollout = await create.mutateAsync({
        product,
        version,
        deviceKeys: chosen.map((d) => d.key),
        canaryKey: canary ?? undefined,
        method,
        batchSize: number('batchSize'),
        batchGapSeconds: number('batchGapSeconds'),
        canaryObserveMinutes: number('canaryObserveMinutes'),
        offlineWaitMinutes: number('offlineWaitMinutes'),
        stopOnFailure: stopOnFailure ?? undefined,
        respectWindow,
        acceptUnrecoverable: product === 'perch-apd' ? acceptUnrecoverable : undefined,
      })
      onCreated(rollout)
    } catch {
      // Shown in the form.
    }
  }

  const openRolloutId = apiErrorCode(create.error) === 'rollout_open' ? refusalField<number>(create.error, 'rolloutId') : undefined
  const fieldErrors = create.error ? fieldErrorsFromApi(create.error) : {}

  return (
    <>
      <DialogHeader>
        <DialogTitle>New rollout</DialogTitle>
        <DialogDescription>
          The canary updates first and is watched for a while; then the others follow a batch at a time.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <p className="text-xs font-medium">Product</p>
            <Segmented
              value={product}
              onChange={(next) => {
                setProduct(next)
                setPicked(null)
                setUnticked(new Set())
                setCanaryPick(null)
              }}
              options={PRODUCTS.map((p) => ({ id: p, label: p }))}
              ariaLabel="Product"
              size="xs"
              className="w-fit"
            />
            <p className="text-[11px] text-muted-foreground">On your {PRODUCT_DEVICES[product]}.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rollout-version" className="text-xs font-medium">
              Version
            </Label>
            {releases.isPending ? (
              <p className="text-muted-foreground">Loading releases…</p>
            ) : choices.length === 0 ? (
              <p className="text-muted-foreground">No release of {product} can be offered.</p>
            ) : (
              <select
                id="rollout-version"
                className={SELECT_CLASS}
                value={version ?? ''}
                onChange={(event) => {
                  setPicked(event.target.value)
                  setUnticked(new Set())
                }}
              >
                {choices.map((r) => (
                  <option key={r.id} value={r.version}>
                    {r.version} ({r.devicesEligible} can take it)
                  </option>
                ))}
              </select>
            )}
            {release ? (
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <ChannelBadge channel={release.channel} />
                {release.source === 'upload' ? 'Local build' : 'GitHub'}
              </p>
            ) : null}
          </div>
        </div>

        <section className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="section-label">Devices</h3>
            <span className="text-[11px] text-muted-foreground">
              {chosen.length} of {devices.length}
            </span>
          </div>
          {devices.length === 0 ? (
            <p className="text-muted-foreground">No {PRODUCT_DEVICES[product]} report to this controller.</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {devices.map((device) => {
                const why = ineligible(device, version)
                const checked = why === null && !unticked.has(device.key)
                return (
                  <li key={device.key}>
                    <label
                      className={cn(
                        'flex items-center gap-3 px-3 py-2',
                        why ? 'text-muted-foreground' : 'cursor-pointer transition-colors duration-base active:bg-muted/60 active:duration-0',
                      )}
                    >
                      <input
                        type="checkbox"
                        className="size-4 shrink-0"
                        disabled={why !== null}
                        checked={checked}
                        onChange={(event) =>
                          setUnticked((current) => {
                            const next = new Set(current)
                            if (event.target.checked) next.delete(device.key)
                            else next.add(device.key)
                            return next
                          })
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-foreground">{device.name}</span>
                        <span className="block text-[11px] text-muted-foreground">
                          <span className="font-mono">{device.version ?? '?'}</span>
                          {why ? ` · ${why}` : ''}
                          {!why && !device.online ? ` · Offline: waited for, then skipped` : ''}
                          {!why && device.selfUpdate.flash ? ` · ${formatBytes(device.selfUpdate.flash.freeBytes)} flash free` : ''}
                        </span>
                      </span>
                      {canary === device.key && checked ? (
                        <span className="shrink-0 rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-medium text-brand">Canary</span>
                      ) : null}
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
          {chosen.length > 1 ? (
            <div className="space-y-1.5">
              <Label htmlFor="rollout-canary" className="text-xs font-medium">
                Canary
              </Label>
              <select
                id="rollout-canary"
                className={SELECT_CLASS}
                value={canary ?? ''}
                onChange={(event) => setCanaryPick(event.target.value)}
              >
                {chosen.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.name}
                    {d.key === suggested ? ' (suggested: most free flash)' : ''}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </section>

        <section className="space-y-3">
          <h3 className="section-label">Pacing</h3>
          <div className="grid grid-cols-2 gap-3">
            <PacingField id="batchSize" label="Devices per batch" value={pacingValue('batchSize')} error={fieldErrors.batchSize} onChange={(v) => setPacing((p) => ({ ...p, batchSize: v }))} />
            <PacingField id="batchGapSeconds" label="Between batches (s)" value={pacingValue('batchGapSeconds')} error={fieldErrors.batchGapSeconds} onChange={(v) => setPacing((p) => ({ ...p, batchGapSeconds: v }))} />
            <PacingField id="canaryObserveMinutes" label="Watch the canary (min)" value={pacingValue('canaryObserveMinutes')} error={fieldErrors.canaryObserveMinutes} onChange={(v) => setPacing((p) => ({ ...p, canaryObserveMinutes: v }))} />
            <PacingField id="offlineWaitMinutes" label="Wait for offline (min)" value={pacingValue('offlineWaitMinutes')} error={fieldErrors.offlineWaitMinutes} onChange={(v) => setPacing((p) => ({ ...p, offlineWaitMinutes: v }))} />
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="section-label">Safety</h3>
          <ToggleRow
            id="stopOnFailure"
            label="Pause on a failure"
            hint="Otherwise the device that failed is skipped and the rollout goes on."
            checked={stopOnFailure ?? defaults?.stopOnFailure ?? true}
            onChange={setStopOnFailure}
          />
          <ToggleRow
            id="respectWindow"
            label="Only inside the maintenance window"
            hint={
              fleet?.window.enabled
                ? 'Devices start only while the window is open; one already updating finishes.'
                : 'The maintenance window is off in the settings, so this would wait for nothing.'
            }
            checked={respectWindow}
            onChange={setRespectWindow}
          />
          <div className="space-y-1.5">
            <p className="text-xs font-medium">Method</p>
            <Segmented
              value={method}
              onChange={setMethod}
              options={[
                { id: 'auto', label: 'Automatic' },
                { id: 'binary', label: METHOD_LABEL.binary },
                { id: 'package', label: METHOD_LABEL.package },
              ]}
              ariaLabel="Method"
              size="xs"
              className="w-fit"
            />
            <p className="text-[11px] text-muted-foreground">{METHOD_HINT[method]}</p>
          </div>
          {product === 'perch-apd' ? (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0"
                checked={acceptUnrecoverable}
                onChange={(event) => setAcceptUnrecoverable(event.target.checked)}
              />
              <span>
                <span className="font-medium">Allow access points short of flash</span>
                <span className="block text-[11px] text-muted-foreground">
                  Their previous version waits in memory during the check. A restart then fetches it again from this
                  controller when it can, or leaves the new version running.
                </span>
              </span>
            </label>
          ) : null}
        </section>

        {create.error && !Object.keys(fieldErrors).length ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-destructive">
            {refusalMessage(create.error)}{' '}
            {openRolloutId ? (
              <Link className="underline underline-offset-2" to={`/settings/updates/rollouts/${openRolloutId}`}>
                Open it
              </Link>
            ) : null}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button type="button" onClick={submit} disabled={!version || chosen.length === 0 || badNumber || create.isPending}>
          {create.isPending ? <Spinner className="size-3.5 text-current" /> : null}
          Start rollout{chosen.length > 0 ? ` on ${chosen.length} device${chosen.length === 1 ? '' : 's'}` : ''}
        </Button>
      </DialogFooter>
    </>
  )
}

function PacingField({
  id,
  label,
  value,
  error,
  onChange,
}: {
  id: string
  label: string
  value: string
  error?: string
  onChange: (value: string) => void
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={`rollout-${id}`} className="text-[11px] font-medium">
        {label}
      </Label>
      <Input
        id={`rollout-${id}`}
        inputMode="numeric"
        className="rounded-md"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
      />
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
    </div>
  )
}

function ToggleRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string
  label: string
  hint: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="space-y-0.5">
        <Label htmlFor={`rollout-${id}`} className="text-xs font-medium">
          {label}
        </Label>
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      </div>
      <Switch id={`rollout-${id}`} checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  )
}
