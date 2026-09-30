import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowClockwise, ArrowCounterClockwise, ArrowSquareOut, MagnifyingGlass, Stop } from '@phosphor-icons/react'
import { EventsList } from '@/components/agent-updates/events-list'
import { ToneDot } from '@/components/agent-updates/job-state'
import { JobTimeline } from '@/components/agent-updates/job-timeline'
import { ManualUpdate } from '@/components/agent-updates/manual-update-sheet'
import { FactList, SheetSection, UpdatesSheet } from '@/components/agent-updates/sheet'
import { SELECT_CLASS } from '@/components/agent-updates/update-dialog'
import { ChannelBadge, VersionBadge } from '@/components/agent-updates/version-badge'
import { UnencryptedBadge } from '@/components/security/plain-http'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useAgentJob, useRefreshAgentDevice, useUpdateAgentDevice } from '@/hooks/use-agent-updates'
import { useNow } from '@/hooks/use-now'
import { formatBytes } from '@/lib/format-bytes'
import {
  AUTO_UPDATE_HINT,
  AUTO_UPDATE_LABEL,
  CHANNEL_HINT,
  CHANNEL_LABEL,
  devicePagePath,
  formatAgo,
  GUARD_TEXT,
  INSTALL_KIND_TEXT,
  isOpenJob,
  packageToReleaseVersion,
  PRODUCT_LABEL,
  refusalMessage,
  ROLE_LABEL,
} from '@/lib/agent-updates'
import type { FleetAction } from '@/components/agent-updates/fleet-table'
import type {
  AgentUpdateDevice,
  AgentUpdateSettingsView,
  AutoUpdate,
  Channel,
} from '@/types/agent-updates'

type DeviceSheetProps = {
  device: AgentUpdateDevice | null
  open: boolean
  onOpenChange: (open: boolean) => void
  isAdmin: boolean
  settings: AgentUpdateSettingsView | undefined
  onAction: (device: AgentUpdateDevice, action: FleetAction) => void
}

/** A job worth showing: the open one, else one that finished within the last day. */
function shownJobId(device: AgentUpdateDevice, now: number): number | null {
  if (device.activeJob) return device.activeJob.id
  const last = device.lastJob
  if (last?.finishedAt && now - Date.parse(last.finishedAt) < 24 * 3600_000) return last.id
  return null
}

/**
 * One device's update facts, its current (or last) update step by step, its
 * update settings and its history. Opened from the fleet list or with
 * `?device=ap:4`.
 */
export function DeviceSheet({ device, open, onOpenChange, isAdmin, settings, onAction }: DeviceSheetProps) {
  const now = useNow(60_000)
  const jobId = device ? shownJobId(device, now) : null
  const job = useAgentJob(jobId)
  const refresh = useRefreshAgentDevice()
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null)

  if (!device) return null
  const su = device.selfUpdate
  const active = device.activeJob
  const summary = active ?? (jobId !== null ? device.lastJob : null)
  const shownJob = job.data && summary && job.data.id === summary.id ? { ...job.data, ...summary } : summary
  const page = devicePagePath(device)
  const canRollBack = su.supported && ((active && (active.state === 'installing' || active.state === 'probation')) || (!active && su.previous !== null))

  const footer =
    isAdmin && su.supported ? (
      <>
        {active && isOpenJob(active.state) ? (
          <Button type="button" variant="destructive" size="sm" onClick={() => onAction(device, 'rollback')}>
            <Stop weight="fill" />
            {active.state === 'queued' || active.state === 'staging' || active.state === 'staged'
              ? 'Cancel update'
              : 'Stop and roll back'}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={() => onAction(device, 'update')}
            disabled={device.pinnedVersion !== null}
            title={device.pinnedVersion ? `Held at ${device.pinnedVersion}` : undefined}
          >
            {device.available ? `Update to ${device.available.version}` : 'Update…'}
          </Button>
        )}
        {!active ? (
          <Button type="button" size="sm" variant="outline" onClick={() => onAction(device, 'check')}>
            <MagnifyingGlass />
            Dry run
          </Button>
        ) : null}
        {!active && canRollBack ? (
          <Button type="button" size="sm" variant="outline" onClick={() => onAction(device, 'rollback')}>
            <ArrowCounterClockwise />
            Roll back
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto"
          disabled={refresh.isPending || !device.online}
          onClick={() =>
            refresh.mutate({ kind: device.kind, id: device.id }, { onSuccess: () => setRefreshedAt(Date.now()) })
          }
          title="Ask the device for its update status now"
        >
          {refresh.isPending ? <Spinner className="size-3.5" /> : <ArrowClockwise />}
          Refresh
        </Button>
      </>
    ) : null

  return (
    <UpdatesSheet
      open={open}
      onOpenChange={onOpenChange}
      title={device.name}
      subtitle={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>
            {ROLE_LABEL[device.role]} · {PRODUCT_LABEL[device.product]}
          </span>
          <span className="inline-flex items-center gap-1">
            <ToneDot tone={device.online ? 'good' : 'critical'} />
            {device.online ? 'Online' : 'Offline'}
          </span>
          {device.online && device.secure === false ? (
            <UnencryptedBadge title="Plain HTTP: keep the controller and this device on a management VLAN." />
          ) : null}
          {page ? (
            <Link to={page} className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline">
              Device page
              <ArrowSquareOut className="size-3" />
            </Link>
          ) : null}
        </span>
      }
      footer={footer}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-border bg-muted/30 px-3 py-2.5">
        <span className="text-muted-foreground">Runs</span>
        <VersionBadge device={device} />
        {device.available && !active ? (
          <span className="flex items-center gap-1.5">
            <span className="text-muted-foreground">·</span>
            <span className="font-medium">{device.available.version} available</span>
            <ChannelBadge channel={device.available.channel} />
            <span className="text-muted-foreground">({formatBytes(device.available.downloadBytes)})</span>
          </span>
        ) : null}
      </div>

      {refresh.error ? <p className="text-destructive">{refusalMessage(refresh.error)}</p> : null}
      {refreshedAt && !refresh.isPending && !refresh.error ? (
        <p className="text-muted-foreground">Status refreshed {formatAgo(new Date(refreshedAt).toISOString(), now)}.</p>
      ) : null}

      {shownJob ? (
        <SheetSection title={active ? 'Updating' : 'Last update'}>
          <div className="rounded-md border border-border p-3">
            <JobTimeline
              key={shownJob.id}
              job={shownJob}
              stableSeconds={settings?.settings.stableSeconds}
              minPushes={settings?.settings.minPushes}
            />
          </div>
        </SheetSection>
      ) : null}

      {!su.supported ? (
        <SheetSection title="Update by hand">
          <ManualUpdate device={device} />
        </SheetSection>
      ) : null}

      {su.supported ? <DeviceSettings device={device} isAdmin={isAdmin} defaultChannel={settings?.settings.defaultChannel} /> : null}

      <SheetSection title="On the device">
        <FactList rows={factRows(device)} />
      </SheetSection>

      <SheetSection
        title="History"
        actions={
          <Link
            to={`/settings/updates?tab=history&deviceKey=${encodeURIComponent(device.key)}`}
            className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            All of it
          </Link>
        }
      >
        <EventsList filters={{ deviceKey: device.key, limit: 8 }} compact live={active !== null} deviceLinks={false} />
      </SheetSection>
    </UpdatesSheet>
  )
}

function factRows(device: AgentUpdateDevice) {
  const su = device.selfUpdate
  const rows: { label: string; value: ReactNode; hint?: ReactNode }[] = []
  if (su.installKind) rows.push({ label: 'Installed', value: INSTALL_KIND_TEXT[su.installKind] })
  if (su.packageManager) {
    rows.push({
      label: 'Package record',
      value: su.packageVersion ? (
        <span className="font-mono">
          {su.packageManager} {su.packageVersion}
        </span>
      ) : (
        `${su.packageManager}: none`
      ),
      hint: su.packageRecordStale && su.packageVersion
        ? `Stale: says ${packageToReleaseVersion(su.packageVersion)} while ${device.version ?? 'another version'} runs. Updates swap the binary.`
        : undefined,
    })
  }
  if (su.openwrtRelease) rows.push({ label: 'OpenWrt', value: su.openwrtRelease })
  if (su.arch || su.pkgArch) {
    rows.push({ label: 'Architecture', value: <span className="font-mono">{[su.arch, su.pkgArch].filter(Boolean).join(' · ')}</span> })
  }
  if (su.flash) {
    const used = 1 - su.flash.freeBytes / Math.max(su.flash.totalBytes, 1)
    rows.push({
      label: 'Flash',
      value: (
        <span className="inline-flex flex-col items-end gap-1">
          <span className="tabular-nums">
            {formatBytes(su.flash.freeBytes)} free of {formatBytes(su.flash.totalBytes)}
          </span>
          <span className="block h-1 w-28 overflow-hidden rounded-full bg-muted" aria-hidden>
            <span className="block h-full bg-muted-foreground/50" style={{ width: `${Math.round(used * 100)}%` }} />
          </span>
        </span>
      ),
      hint: su.flash.fsType,
    })
  }
  rows.push({
    label: 'Version floor',
    value: su.floor ? <span className="font-mono">{su.floor}</span> : 'None',
    hint: 'It never accepts a version below this.',
  })
  if (su.guard) rows.push({ label: 'Boot guard', value: GUARD_TEXT[su.guard] })
  rows.push({
    label: 'Previous version',
    value: su.previous ? <span className="font-mono">{su.previous.version}</span> : 'None kept',
    hint: su.previous ? 'Kept on flash for a quick roll back.' : undefined,
  })
  rows.push({ label: 'Reported', value: su.reportedAt ? formatAgo(su.reportedAt) : 'Never' })
  return rows
}

function DeviceSettings({
  device,
  isAdmin,
  defaultChannel,
}: {
  device: AgentUpdateDevice
  isAdmin: boolean
  defaultChannel: Channel | undefined
}) {
  const update = useUpdateAgentDevice()
  const target = { kind: device.kind, id: device.id }
  const channelDefault = defaultChannel ?? (device.channelSetting === null ? device.channel : null)

  return (
    <SheetSection title="Update settings" actions={update.isPending ? <Spinner className="size-3.5" /> : null}>
      <div className="space-y-3 rounded-md border border-border p-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="device-channel" className="text-xs font-medium">
              Channel
            </Label>
            <select
              id="device-channel"
              className={SELECT_CLASS}
              value={device.channelSetting ?? ''}
              disabled={!isAdmin || update.isPending}
              onChange={(event) =>
                update.mutate({ ...target, channel: event.target.value === '' ? null : (event.target.value as Channel) })
              }
            >
              <option value="">Default{channelDefault ? ` (${CHANNEL_LABEL[channelDefault]})` : ''}</option>
              {(['stable', 'pre', 'local'] as Channel[]).map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_LABEL[c]}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">{CHANNEL_HINT[device.channel]}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="device-auto" className="text-xs font-medium">
              Auto-update
            </Label>
            <select
              id="device-auto"
              className={SELECT_CLASS}
              value={device.autoUpdateSetting}
              disabled={!isAdmin || update.isPending}
              onChange={(event) => update.mutate({ ...target, autoUpdate: event.target.value as 'inherit' | AutoUpdate })}
            >
              <option value="inherit">
                Like the other {device.kind === 'ap' ? 'access points' : 'collectors'}
                {device.autoUpdateSetting === 'inherit' ? ` (${AUTO_UPDATE_LABEL[device.autoUpdate]})` : ''}
              </option>
              {(['off', 'notify', 'auto'] as AutoUpdate[]).map((a) => (
                <option key={a} value={a}>
                  {AUTO_UPDATE_LABEL[a]}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">{AUTO_UPDATE_HINT[device.autoUpdate]}</p>
          </div>
        </div>
        <div className="flex items-start justify-between gap-3 border-t border-border pt-3">
          <div className="space-y-0.5">
            <Label htmlFor="device-hold" className="text-xs font-medium">
              {device.pinnedVersion ? `Held at ${device.pinnedVersion}` : 'Hold at this version'}
            </Label>
            <p className="text-[11px] text-muted-foreground">
              Nothing is offered to it and rollouts skip it until you let go.
            </p>
          </div>
          <Switch
            id="device-hold"
            checked={device.pinnedVersion !== null}
            disabled={!isAdmin || update.isPending || (!device.pinnedVersion && !device.version)}
            onCheckedChange={(next) => update.mutate({ ...target, pinnedVersion: next ? device.version : null })}
            aria-label="Hold at this version"
          />
        </div>
        {update.error ? <p className="text-destructive">{refusalMessage(update.error)}</p> : null}
      </div>
    </SheetSection>
  )
}
