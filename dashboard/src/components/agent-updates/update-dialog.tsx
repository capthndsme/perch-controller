import { useEffect, useMemo, useState } from 'react'
import { ArrowClockwise, Info, Warning } from '@phosphor-icons/react'
import { PreflightSummary } from '@/components/agent-updates/preflight-summary'
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
import { Label } from '@/components/ui/label'
import { Segmented } from '@/components/ui/segmented'
import { Spinner } from '@/components/ui/spinner'
import { useAgentPreflight, useAgentReleases, useStartAgentUpdate } from '@/hooks/use-agent-updates'
import { apiErrorCode } from '@/lib/api'
import {
  CHANNEL_LABEL,
  compareVersions,
  formatInZone,
  METHOD_HINT,
  METHOD_LABEL,
  refusalMessage,
} from '@/lib/agent-updates'
import type { AgentFleet, AgentUpdateDevice, AgentUpdateJob, UpdateMethod } from '@/types/agent-updates'

export const SELECT_CLASS =
  'h-8 w-full min-w-0 rounded-md border border-border bg-card px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:opacity-50'

type Mode = 'update' | 'check'
type MethodChoice = 'auto' | UpdateMethod

type UpdateDialogProps = {
  device: AgentUpdateDevice | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** `check` is the dry run: the same form, without the install buttons. */
  mode: Mode
  window: AgentFleet['window'] | null
  /** The device's check window in seconds (settings.probationSeconds), for the warnings. */
  probationSeconds?: number
  onStarted?: (job: AgentUpdateJob) => void
}

/**
 * Update one device: pick the version and method, see the device's own dry
 * run (it runs as the dialog opens and again on every change), then update
 * now or in the maintenance window. Keyed by its opener, so every open starts
 * fresh.
 */
export function UpdateDialog({ device, open, onOpenChange, mode, window, probationSeconds, onStarted }: UpdateDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {device ? (
          <UpdateForm
            device={device}
            initialMode={mode}
            window={window}
            probationSeconds={probationSeconds}
            onDone={(job) => {
              onOpenChange(false)
              onStarted?.(job)
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function UpdateForm({
  device,
  initialMode,
  window,
  probationSeconds,
  onDone,
}: {
  device: AgentUpdateDevice
  initialMode: Mode
  window: AgentFleet['window'] | null
  probationSeconds?: number
  onDone: (job: AgentUpdateJob) => void
}) {
  const [mode, setMode] = useState<Mode>(initialMode)
  const releases = useAgentReleases(device.product)
  const preflight = useAgentPreflight()
  const start = useStartAgentUpdate()
  const { mutate: runPreflight } = preflight

  const choices = useMemo(
    () => (releases.data ?? []).filter((r) => r.product === device.product && r.offerable).sort((a, b) => compareVersions(b.version, a.version)),
    [releases.data, device.product],
  )
  const fallback =
    device.available?.version ??
    choices.find((r) => compareVersions(r.version, device.version) > 0)?.version ??
    choices.find((r) => r.version !== device.version)?.version ??
    null
  const [picked, setPicked] = useState<string | null>(null)
  const version = picked ?? fallback
  const [method, setMethod] = useState<MethodChoice>('auto')
  const [acceptRam, setAcceptRam] = useState(false)
  const [tick, setTick] = useState(0)

  const methods: MethodChoice[] = ['auto', ...device.selfUpdate.methods]
  const methodOptions = methods.map((id) => ({ id, label: id === 'auto' ? 'Automatic' : METHOD_LABEL[id] }))

  // The device's dry run, again on every change of version or method (and "Check again").
  useEffect(() => {
    if (!version) return
    runPreflight({ kind: device.kind, id: device.id, version, method: method === 'auto' ? undefined : method })
  }, [runPreflight, device.kind, device.id, version, method, tick])

  const result = preflight.data?.preflight ?? null
  const offline = apiErrorCode(preflight.error) === 'agent_offline' || !device.online
  const ram = result?.rollbackStore === 'ram'
  const minutes = probationSeconds ? Math.round(probationSeconds / 60) : null
  const checkWindow = minutes ? `the ${minutes}-minute check` : 'the check'
  const blocked =
    preflight.isPending || (result !== null && !result.ok) || (ram && !acceptRam) || !version || version === device.version

  async function submit(when: 'now' | 'window') {
    if (!version) return
    try {
      const job = await start.mutateAsync({
        kind: device.kind,
        id: device.id,
        version,
        method: method === 'auto' ? undefined : method,
        when,
        acceptUnrecoverable: ram ? acceptRam : undefined,
      })
      onDone(job)
    } catch {
      // Shown under the form.
    }
  }

  const windowNext = window?.enabled ? formatInZone(window.nextStart, window.timezone) : null

  return (
    <>
      <DialogHeader>
        <DialogTitle>{mode === 'check' ? `Dry run on ${device.name}` : `Update ${device.name}`}</DialogTitle>
        <DialogDescription>
          {mode === 'check'
            ? 'The device checks the release’s signature and its own space. Nothing is downloaded or installed.'
            : `Now on ${device.version ?? 'an unknown version'}. It keeps this version until the new one checks in, and goes back to it on its own if that fails.`}
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="space-y-1.5">
          <Label htmlFor="update-version" className="text-xs font-medium">
            Version
          </Label>
          {releases.isPending ? (
            <p className="text-muted-foreground">Loading releases…</p>
          ) : choices.length === 0 ? (
            <p className="text-muted-foreground">No release of {device.product} is on this controller yet.</p>
          ) : (
            <select
              id="update-version"
              className={SELECT_CLASS}
              value={version ?? ''}
              onChange={(event) => {
                setPicked(event.target.value)
                setAcceptRam(false)
              }}
            >
              {choices.map((r) => {
                const below = device.selfUpdate.floor !== null && compareVersions(r.version, device.selfUpdate.floor) < 0
                const running = r.version === device.version
                const notes = [
                  CHANNEL_LABEL[r.channel],
                  running ? 'running now' : null,
                  r.version === device.available?.version ? 'offered' : null,
                  below ? 'below the device’s floor' : null,
                ].filter(Boolean)
                return (
                  <option key={r.id} value={r.version} disabled={running || below}>
                    {r.version} · {notes.join(', ')}
                  </option>
                )
              })}
            </select>
          )}
          {version && device.available && version !== device.available.version ? (
            <p className="text-[11px] text-muted-foreground">
              Not the version offered on the {CHANNEL_LABEL[device.channel].toLowerCase()} channel (
              {device.available.version}).
              {compareVersions(version, device.version) < 0 ? ' This goes back to an older version.' : ''}
            </p>
          ) : null}
        </div>

        {methods.length > 1 ? (
          <div className="space-y-1.5">
            <p className="text-xs font-medium">Method</p>
            <Segmented
              value={method}
              onChange={(next) => {
                setMethod(next)
                setAcceptRam(false)
              }}
              options={methodOptions}
              ariaLabel="Update method"
              size="xs"
              className="w-fit"
            />
            <p className="text-[11px] text-muted-foreground">{METHOD_HINT[method]}</p>
          </div>
        ) : null}

        {device.role === 'gateway' ? (
          <p className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-2">
            <Info className="mt-px size-4 shrink-0 text-muted-foreground" />
            Internet keeps working. Traffic capture pauses for about 10 seconds while the collector restarts.
          </p>
        ) : null}

        <section className="relative min-h-24 space-y-2" aria-live="polite">
          <div className="flex items-center justify-between gap-2">
            <h3 className="section-label">Dry run on the device</h3>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => setTick((t) => t + 1)}
              disabled={preflight.isPending || !version}
            >
              <ArrowClockwise />
              Check again
            </Button>
          </div>
          {preflight.isPending ? (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Spinner className="size-3.5" />
              Asking {device.name}…
            </p>
          ) : offline ? (
            <p className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-2">
              <Info className="mt-px size-4 shrink-0 text-muted-foreground" />
              {device.name} is offline, so it cannot check now. An update waits for it and starts when it is back.
            </p>
          ) : preflight.error ? (
            <p className="rounded-md border border-status-critical/40 bg-status-critical/10 px-2.5 py-2">
              {refusalMessage(preflight.error)}
            </p>
          ) : result ? (
            <PreflightSummary preflight={result} />
          ) : null}
        </section>

        {mode === 'update' && ram ? (
          <label className="flex items-start gap-2 rounded-md border border-status-warning/50 bg-status-warning/10 px-2.5 py-2">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-current"
              checked={acceptRam}
              onChange={(event) => setAcceptRam(event.target.checked)}
            />
            <span>
              <span className="flex items-center gap-1.5 font-medium">
                <Warning className="size-3.5 text-status-warning" weight="fill" />
                The previous version waits in memory
              </span>
              There is not enough flash to keep it. If the access point restarts during {checkWindow}, it fetches the
              previous version from this controller again; if it cannot, it keeps the new version and may need a
              reinstall over SSH.
            </span>
          </label>
        ) : null}

        {start.error ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-destructive">
            {refusalMessage(start.error)}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        {mode === 'check' ? (
          <Button type="button" onClick={() => setMode('update')} disabled={!version}>
            Update…
          </Button>
        ) : (
          <>
            {window?.enabled ? (
              <Button type="button" variant="outline" onClick={() => submit('window')} disabled={blocked || start.isPending}>
                In the maintenance window{windowNext ? ` (${windowNext})` : ''}
              </Button>
            ) : null}
            <Button type="button" onClick={() => submit('now')} disabled={blocked || start.isPending}>
              {start.isPending ? <Spinner className="size-3.5 text-current" /> : null}
              {offline ? 'Update when it is back' : 'Update now'}
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  )
}
