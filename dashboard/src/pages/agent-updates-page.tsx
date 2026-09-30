import { useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowsClockwise, CheckCircle, RocketLaunch, X } from '@phosphor-icons/react'
import '@/components/agent-updates/agent-updates.css'
import { DeviceSheet } from '@/components/agent-updates/device-sheet'
import { EventsList } from '@/components/agent-updates/events-list'
import { FleetTable, type FleetAction } from '@/components/agent-updates/fleet-table'
import { ManualUpdateSheet } from '@/components/agent-updates/manual-update-sheet'
import { ReleaseUploadDialog } from '@/components/agent-updates/release-upload-dialog'
import { ReleasesPanel } from '@/components/agent-updates/releases-table'
import { RolloutDialog } from '@/components/agent-updates/rollout-dialog'
import { RolloutSheet } from '@/components/agent-updates/rollout-sheet'
import { OpenRolloutCard, RolloutsPanel } from '@/components/agent-updates/rollouts-list'
import { AgentUpdateSettingsForm } from '@/components/agent-updates/settings-form'
import { SELECT_CLASS, UpdateDialog } from '@/components/agent-updates/update-dialog'
import { PageHeader } from '@/components/layout/page-header'
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
import { PageSpinner, Spinner } from '@/components/ui/spinner'
import { Segmented } from '@/components/ui/segmented'
import {
  useAbortAgentJob,
  useAgentFleet,
  useAgentRollouts,
  useAgentUpdateSettings,
  useCheckReleases,
  useOpenRolloutMembers,
  useRollbackAgent,
  useUpdateAgentDevice,
} from '@/hooks/use-agent-updates'
import { useProfile } from '@/hooks/use-auth'
import { useConfirm } from '@/hooks/use-confirm'
import { useNow } from '@/hooks/use-now'
import { useRetained } from '@/hooks/use-retained'
import { apiErrorCode } from '@/lib/api'
import {
  deviceMatchesFilter,
  formatAgo,
  formatIn,
  formatInZone,
  refusalMessage,
  type FleetFilter,
} from '@/lib/agent-updates'
import { cn } from '@/lib/utils'
import type {
  AgentFleet,
  AgentProduct,
  AgentRelease,
  AgentUpdateDevice,
  EventSeverity,
  ReleaseCheckResult,
} from '@/types/agent-updates'

const TABS = ['devices', 'releases', 'rollouts', 'history', 'settings'] as const
type Tab = (typeof TABS)[number]

const TAB_LABEL: Record<Tab, string> = {
  devices: 'Devices',
  releases: 'Releases',
  rollouts: 'Rollouts',
  history: 'History',
  settings: 'Settings',
}

/** Rows keep one order on every refresh: products, gateways before the rest, then names. */
function fleetOrder(a: AgentUpdateDevice, b: AgentUpdateDevice): number {
  if (a.product !== b.product) return a.product === 'perch-collector' ? -1 : 1
  if (a.role !== b.role) return a.role === 'gateway' ? -1 : b.role === 'gateway' ? 1 : 0
  return a.name.localeCompare(b.name)
}

/**
 * Settings → Updates (docs/design/agent-updates, controller.md section 10):
 * every Perch agent's version and update state, releases (GitHub and local
 * builds), rollouts, the audit trail and the settings. Tabs are URL state
 * (`?tab=`); `?device=ap:4` opens a device's sheet and
 * `/settings/updates/rollouts/:rolloutId` a rollout's.
 */
export function AgentUpdatesPage() {
  const params = useParams()
  const navigate = useNavigate()
  const [search, setSearch] = useSearchParams()
  const profile = useProfile()
  const isAdmin = profile.data?.role === 'admin'
  const fleet = useAgentFleet()
  const settings = useAgentUpdateSettings({ enabled: isAdmin })
  const check = useCheckReleases()
  const [checkResult, setCheckResult] = useState<ReleaseCheckResult | null>(null)

  const rolloutParam = params.rolloutId ? Number(params.rolloutId) : null
  const rolloutId = useRetained(rolloutParam)
  const rawTab = search.get('tab')
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? '')
    ? (rawTab as Tab)
    : rolloutParam !== null
      ? 'rollouts'
      : 'devices'
  const shownTab: Tab = tab === 'settings' && !isAdmin ? 'devices' : tab

  // Dialogs and sheets.
  const deviceKey = search.get('device')
  const sheetDevice = fleet.data?.devices.find((d) => d.key === deviceKey) ?? null
  const retainedDevice = useRetained(sheetDevice)
  const update = useConfirm<{ device: AgentUpdateDevice; mode: 'update' | 'check' }>()
  const manual = useConfirm<AgentUpdateDevice>()
  const rollback = useConfirm<AgentUpdateDevice>()
  const [rolloutDialog, setRolloutDialog] = useState<{ open: boolean; preset: { product: AgentProduct; version?: string } | null }>({
    open: false,
    preset: null,
  })
  const [uploadOpen, setUploadOpen] = useState(false)
  const hold = useUpdateAgentDevice()

  function setParam(changes: Record<string, string | null>) {
    const next = new URLSearchParams(search)
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key)
      else next.set(key, value)
    }
    setSearch(next)
  }

  function onTab(next: Tab) {
    if (rolloutParam !== null) {
      navigate(`/settings/updates${next === 'devices' ? '' : `?tab=${next}`}`)
      return
    }
    setParam({ tab: next === 'devices' ? null : next })
  }

  function openDevice(device: AgentUpdateDevice) {
    setParam({ device: device.key })
  }

  function onAction(device: AgentUpdateDevice, action: FleetAction) {
    switch (action) {
      case 'update':
      case 'check':
        update.open({ device, mode: action })
        break
      case 'manual':
        manual.open(device)
        break
      case 'rollback':
        rollback.open(device)
        break
      case 'hold':
        hold.mutate({ kind: device.kind, id: device.id, pinnedVersion: device.version })
        break
      case 'unhold':
        hold.mutate({ kind: device.kind, id: device.id, pinnedVersion: null })
        break
      case 'settings':
        openDevice(device)
        break
    }
  }

  function openRolloutDialog(preset: { product: AgentProduct; version?: string } | null) {
    setRolloutDialog({ open: true, preset })
  }

  // Where the rollout sheet opens over (the tab it came from) and where closing it goes back to.
  const rolloutPath = (id: number) => `/settings/updates/rollouts/${id}${shownTab === 'rollouts' ? '' : `?tab=${shownTab}`}`
  const backPath = shownTab === 'devices' ? '/settings/updates' : `/settings/updates?tab=${shownTab}`

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageHeader
        crumbs={[{ label: 'Settings', to: '/settings' }, { label: 'Updates' }]}
        title="Updates"
        description="Perch AP Daemon and Perch Network Collector on your devices: versions, releases and rollouts."
        actions={
          isAdmin ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={check.isPending}
                onClick={() => check.mutate(undefined, { onSuccess: setCheckResult })}
              >
                {check.isPending ? <Spinner className="size-3.5" /> : <ArrowsClockwise />}
                Check for releases
              </Button>
              <Button type="button" size="sm" onClick={() => openRolloutDialog(null)}>
                <RocketLaunch />
                Start rollout
              </Button>
            </>
          ) : null
        }
      />

      {check.error ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {refusalMessage(check.error)}
        </p>
      ) : null}
      {checkResult ? <CheckResultNote result={checkResult} onDismiss={() => setCheckResult(null)} /> : null}

      <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none]">
        <div role="tablist" aria-label="Updates" className="flex min-w-max gap-1 border-b border-border">
          {TABS.filter((t) => t !== 'settings' || isAdmin).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={shownTab === t}
              onClick={() => onTab(t)}
              className={cn(
                '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors duration-base active:duration-0',
                shownTab === t ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {TAB_LABEL[t]}
              {t === 'devices' && fleet.data && fleet.data.summary.updateAvailable > 0 ? (
                <span className="rounded-full bg-brand/15 px-1.5 text-[10px] text-brand tabular-nums">
                  {fleet.data.summary.updateAvailable}
                </span>
              ) : null}
              {t === 'rollouts' && fleet.data && fleet.data.openRollouts.length > 0 ? (
                <span aria-label="in progress" className="size-1.5 rounded-full bg-brand" />
              ) : null}
            </button>
          ))}
        </div>
      </div>

      {shownTab === 'devices' ? (
        fleet.isPending ? (
          <PageSpinner label="Loading devices" />
        ) : fleet.error && !fleet.data ? (
          <p className="text-sm text-destructive">{refusalMessage(fleet.error)}</p>
        ) : fleet.data ? (
          <DevicesTab fleet={fleet.data} isAdmin={isAdmin} onOpen={openDevice} onAction={onAction} />
        ) : null
      ) : null}
      {shownTab === 'releases' ? (
        <ReleasesPanel
          isAdmin={isAdmin}
          onUpload={() => setUploadOpen(true)}
          onRollout={(release: AgentRelease) => openRolloutDialog({ product: release.product, version: release.version })}
        />
      ) : null}
      {shownTab === 'rollouts' ? (
        <RolloutsPanel isAdmin={isAdmin} window={fleet.data?.window ?? null} onNew={() => openRolloutDialog(null)} />
      ) : null}
      {shownTab === 'history' ? <HistoryTab fleet={fleet.data} search={search} setParam={setParam} /> : null}
      {shownTab === 'settings' && isAdmin ? (
        settings.data ? (
          <AgentUpdateSettingsForm view={settings.data} timezone={fleet.data?.window.timezone ?? null} />
        ) : settings.error ? (
          <p className="text-sm text-destructive">{refusalMessage(settings.error)}</p>
        ) : (
          <PageSpinner label="Loading update settings" />
        )
      ) : null}

      <DeviceSheet
        device={sheetDevice ?? retainedDevice}
        open={sheetDevice !== null}
        onOpenChange={(open) => {
          if (!open) setParam({ device: null })
        }}
        isAdmin={isAdmin}
        settings={settings.data}
        onAction={onAction}
      />
      <RolloutSheet
        rolloutId={rolloutId}
        open={rolloutParam !== null}
        onOpenChange={(open) => {
          if (!open) navigate(backPath)
        }}
        isAdmin={isAdmin}
        window={fleet.data?.window ?? null}
      />
      <UpdateDialog
        {...update.props}
        device={update.target?.device ?? null}
        mode={update.target?.mode ?? 'update'}
        window={fleet.data?.window ?? null}
        probationSeconds={settings.data?.settings.probationSeconds}
        onStarted={(job) => {
          if (job.device) setParam({ device: job.device.key })
        }}
      />
      <ManualUpdateSheet {...manual.props} device={manual.target} />
      <RollbackDialog
        {...rollback.props}
        device={rollback.target ? (fleet.data?.devices.find((d) => d.key === rollback.target!.key) ?? rollback.target) : null}
        onClose={rollback.close}
        onPickOlder={(device) => {
          rollback.close()
          update.open({ device, mode: 'update' })
        }}
      />
      <RolloutDialog
        open={rolloutDialog.open}
        onOpenChange={(open) => setRolloutDialog((d) => ({ ...d, open }))}
        fleet={fleet.data}
        preset={rolloutDialog.preset}
        onCreated={(rollout) => navigate(rolloutPath(rollout.id))}
      />
      <ReleaseUploadDialog open={uploadOpen} onOpenChange={setUploadOpen} />
      {hold.error ? <p className="text-xs text-destructive">{refusalMessage(hold.error)}</p> : null}
    </div>
  )
}

// ── Devices ────────────────────────────────────────────────────────────────

function DevicesTab({
  fleet,
  isAdmin,
  onOpen,
  onAction,
}: {
  fleet: AgentFleet
  isAdmin: boolean
  onOpen: (device: AgentUpdateDevice) => void
  onAction: (device: AgentUpdateDevice, action: FleetAction) => void
}) {
  const [filter, setFilter] = useState<FleetFilter>('all')
  const now = useNow(60_000)
  const members = useOpenRolloutMembers(fleet.openRollouts.map((r) => r.id))
  const devices = useMemo(() => [...fleet.devices].sort(fleetOrder), [fleet.devices])
  const shown = devices.filter((d) => deviceMatchesFilter(d, filter))
  const s = fleet.summary
  const chips: { id: FleetFilter; label: string; count: number; tone?: string }[] = [
    { id: 'all', label: 'All', count: s.total },
    { id: 'current', label: 'Up to date', count: s.current },
    { id: 'update_available', label: 'Update available', count: s.updateAvailable, tone: 'bg-brand' },
    { id: 'updating', label: 'Updating', count: s.updating, tone: 'bg-brand au-halo text-brand' },
    { id: 'manual', label: 'Needs manual update', count: s.unsupported, tone: 'bg-status-warning' },
  ]
  const w = fleet.window
  const windowNext = w.enabled && !w.open ? formatInZone(w.nextStart, w.timezone) : null

  return (
    <div className="space-y-4">
      {fleet.openRollouts.map((r) => (
        <OpenRolloutCard key={r.id} id={r.id} window={w} />
      ))}

      <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none]">
        <div className="flex min-w-max gap-1.5" role="radiogroup" aria-label="Show">
          {chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              role="radio"
              aria-checked={filter === chip.id}
              onClick={() => setFilter(chip.id)}
              disabled={chip.count === 0 && chip.id !== 'all'}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors duration-base active:duration-0 disabled:opacity-45',
                filter === chip.id
                  ? 'border-foreground/20 bg-foreground/[0.07] font-medium dark:bg-secondary'
                  : 'border-border bg-card text-muted-foreground hover:text-foreground active:bg-muted',
              )}
            >
              {chip.tone && chip.count > 0 ? <span aria-hidden className={cn('size-1.5 rounded-full', chip.tone)} /> : null}
              {chip.label}
              <span className="tabular-nums">{chip.count}</span>
            </button>
          ))}
        </div>
      </div>

      <p className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>
          Controller <span className="font-mono">{fleet.controller.version}</span> installs perch-apd{' '}
          <span className="font-mono">{fleet.controller.apdVersion}</span> and perch-collector{' '}
          <span className="font-mono">{fleet.controller.collectorVersion}</span> on new devices
        </span>
        <span>
          {fleet.githubCheck ? `GitHub checked ${formatAgo(fleet.lastGithubCheckAt, now)}` : 'GitHub check off'}
        </span>
        <span>
          {!w.enabled
            ? 'No maintenance window'
            : w.open
              ? 'Maintenance window open now'
              : `Maintenance window opens ${windowNext ?? 'later'}${w.nextStart ? ` (${formatIn(w.nextStart, now)})` : ''}`}
        </span>
      </p>

      {shown.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {fleet.devices.length === 0 ? 'No Perch agents report to this controller yet.' : 'No device matches.'}
        </p>
      ) : (
        <FleetTable devices={shown} isAdmin={isAdmin} onOpen={onOpen} onAction={onAction} members={members} />
      )}
    </div>
  )
}

// ── History ────────────────────────────────────────────────────────────────

const SEVERITIES: { id: 'all' | EventSeverity; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'info', label: 'Info' },
  { id: 'warning', label: 'Warnings' },
  { id: 'critical', label: 'Critical' },
]

function HistoryTab({
  fleet,
  search,
  setParam,
}: {
  fleet: AgentFleet | undefined
  search: URLSearchParams
  setParam: (changes: Record<string, string | null>) => void
}) {
  const rollouts = useAgentRollouts('all')
  const deviceKey = search.get('deviceKey')
  const rolloutRaw = search.get('rolloutId')
  const rolloutId = rolloutRaw && /^\d+$/.test(rolloutRaw) ? Number(rolloutRaw) : undefined
  const sevRaw = search.get('severity')
  const severity = sevRaw === 'info' || sevRaw === 'warning' || sevRaw === 'critical' ? sevRaw : undefined
  const devices = [...(fleet?.devices ?? [])].sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Device"
          className={cn(SELECT_CLASS, 'w-auto min-w-40')}
          value={deviceKey ?? ''}
          onChange={(event) => setParam({ deviceKey: event.target.value || null })}
        >
          <option value="">Every device</option>
          {devices.map((d) => (
            <option key={d.key} value={d.key}>
              {d.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Rollout"
          className={cn(SELECT_CLASS, 'w-auto min-w-40')}
          value={rolloutId ?? ''}
          onChange={(event) => setParam({ rolloutId: event.target.value || null })}
        >
          <option value="">Every rollout</option>
          {(rollouts.data ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              #{r.id} {r.product} {r.version}
            </option>
          ))}
        </select>
        <Segmented
          value={severity ?? 'all'}
          onChange={(next) => setParam({ severity: next === 'all' ? null : next })}
          options={SEVERITIES}
          ariaLabel="Severity"
          size="xs"
        />
      </div>
      <div className="card-surface px-4 py-3">
        <EventsList
          filters={{ deviceKey: deviceKey ?? undefined, rolloutId, severity, limit: 50 }}
          emptyText="No events match these filters."
        />
      </div>
    </div>
  )
}

// ── Dialogs ────────────────────────────────────────────────────────────────

function CheckResultNote({ result, onDismiss }: { result: ReleaseCheckResult; onDismiss: () => void }) {
  const fresh = result.found.filter((f) => f.status === 'new')
  const odd = result.found.filter((f) => f.status === 'unsigned' || f.status === 'rejected')
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 text-xs shadow-sm transition-[opacity,translate] duration-base ease-out starting:-translate-y-1 starting:opacity-0 motion-reduce:starting:translate-y-0">
      <CheckCircle weight="fill" className="mt-0.5 size-4 shrink-0 text-status-good" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium">
          {fresh.length > 0
            ? `Found ${fresh.map((f) => `${f.product} ${f.version}`).join(', ')}`
            : 'No new releases on GitHub'}
        </p>
        {odd.map((f) => (
          <p key={`${f.product}-${f.version}`} className="text-muted-foreground">
            {f.product} {f.version}: {f.status === 'unsigned' ? 'not signed yet, so not offered' : 'rejected'}
            {f.reason ? ` (${f.reason})` : ''}.
          </p>
        ))}
      </div>
      <Button type="button" size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={onDismiss}>
        <X />
      </Button>
    </div>
  )
}

/**
 * Roll back, or stop an update. A job that has not replaced anything yet is
 * cancelled; one being installed or checked is aborted (the device restores
 * the previous version); with nothing running, the device goes back to the
 * previous version it keeps, through the same check.
 */
function RollbackDialog({
  device,
  open,
  onOpenChange,
  onClose,
  onPickOlder,
}: {
  device: AgentUpdateDevice | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onClose: () => void
  onPickOlder: (device: AgentUpdateDevice) => void
}) {
  const rollback = useRollbackAgent()
  const abort = useAbortAgentJob()
  const job = device?.activeJob ?? null
  const early = job !== null && (job.state === 'queued' || job.state === 'staging' || job.state === 'staged')
  const error = rollback.error ?? abort.error
  const noPrevious = apiErrorCode(rollback.error) === 'no_previous'
  const pending = rollback.isPending || abort.isPending

  function go() {
    if (!device) return
    if (job && early) abort.mutate(job.id, { onSuccess: onClose })
    else rollback.mutate({ kind: device.kind, id: device.id }, { onSuccess: onClose })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          rollback.reset()
          abort.reset()
        }
        onOpenChange(next)
      }}
    >
      <DialogContent>
        {device ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {job ? (early ? `Cancel the update of ${device.name}?` : `Stop the update of ${device.name}?`) : `Roll back ${device.name}?`}
              </DialogTitle>
              <DialogDescription>
                {job
                  ? early
                    ? `Nothing has been replaced yet; ${device.name} stays on ${job.fromVersion}.`
                    : `${device.name} puts ${job.fromVersion} back and restarts it. This takes a few seconds.`
                  : device.selfUpdate.previous
                    ? `${device.name} goes back to ${device.selfUpdate.previous.version}, which it keeps on flash, with the same automatic check as an update.`
                    : `${device.name} keeps no previous version.`}
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              {error ? (
                <div className="space-y-2">
                  <p className="text-destructive">{refusalMessage(error)}</p>
                  {noPrevious ? (
                    <Button type="button" size="sm" variant="outline" onClick={() => onPickOlder(device)}>
                      Install an older version instead…
                    </Button>
                  ) : null}
                </div>
              ) : (
                <p className="text-muted-foreground">
                  {job && !early
                    ? 'The update is recorded as rolled back (stopped by an admin).'
                    : job
                      ? 'The downloaded files are deleted.'
                      : 'Its version floor still applies: it never goes below it.'}
                </p>
              )}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                Keep {job ? 'updating' : 'this version'}
              </Button>
              <Button type="button" variant="destructive" onClick={go} disabled={pending || noPrevious}>
                {pending ? <Spinner className="size-3.5 text-current" /> : null}
                {job ? (early ? 'Cancel update' : 'Stop and roll back') : 'Roll back'}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
