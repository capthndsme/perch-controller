import { useState } from 'react'
import { Info, Pause, Play, PlugsConnected, ShieldCheck, WarningOctagon } from '@phosphor-icons/react'
import { IssueList, LoudBanner, RefusalAlert, StatePill } from '@/components/qos/qos-bits'
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
import type { QosWrites } from '@/hooks/use-qos'
import { formatLastSeen } from '@/lib/collectors'
import { describeApply, formatWhen, routerPauses } from '@/lib/qos'
import type { QosOverview } from '@/types/api'

/** The chips under the page title: mode, connection, delivery of both halves. */
export function QosStatusChips({ overview }: { overview: QosOverview }) {
  const config = describeApply(overview.config, 'config')
  const devices = describeApply(overview.devices, 'devices')
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <StatePill tone={overview.managed ? 'good' : 'muted'}>{overview.managed ? 'Managed' : 'Watch only'}</StatePill>
      {overview.managed ? (
        <StatePill tone={overview.authoritative ? 'info' : 'muted'} title="Authoritative Mode: the controller's config wins over router edits.">
          {overview.authoritative ? 'Authoritative' : 'Two-way sync'}
        </StatePill>
      ) : null}
      <StatePill tone={overview.online ? 'good' : 'critical'}>{overview.online ? 'Gateway online' : 'Gateway offline'}</StatePill>
      {overview.paused ? (
        <StatePill tone={overview.paused.by === 'router' ? 'critical' : 'warning'}>
          Paused {overview.paused.by === 'router' ? 'on the router' : 'from Perch'}
        </StatePill>
      ) : null}
      <StatePill tone={devices.tone} title={devices.detail ?? undefined}>
        Device caps: {devices.label}
      </StatePill>
      <StatePill tone={config.tone} title={config.detail ?? undefined}>
        Shaper config: {config.label}
      </StatePill>
    </div>
  )
}

type BannerProps = { overview: QosOverview; isAdmin: boolean; writes: QosWrites }

/**
 * Everything an operator must see before touching a cap, loudest first:
 * a router-side pause (owner decision 15: never reverted), a paused WAN
 * queue, watch-only mode, the controller's pause, delivery, capabilities.
 */
export function QosBanners({ overview, isAdmin, writes }: BannerProps) {
  const pauses = routerPauses(overview)
  const [confirmOverride, setConfirmOverride] = useState(false)
  const config = describeApply(overview.config, 'config')
  const devicesInSync = overview.devices.state === 'in_sync'
  const caps = overview.capabilities
  const capabilityProblems: string[] = []
  if (overview.agentSupportsQos === false) {
    capabilityProblems.push('The collector on this gateway does not support traffic shaping. Update perch-collector.')
  }
  if (caps) {
    if (!caps.sqm.installed) capabilityProblems.push('sqm-scripts is not installed on the gateway: WAN queues cannot run.')
    if (!caps.shaper.available) {
      capabilityProblems.push(`The router kernel lacks what device caps need: ${caps.shaper.missing.join(', ')}.`)
    }
    for (const c of caps.conflicts) capabilityProblems.push(`${c} is enabled on the router and would fight Perch's shaper.`)
    if (caps.flowOffload.hardware) capabilityProblems.push('Hardware flow offloading is on: offloaded traffic bypasses every cap.')
    if (caps.clockSynced === false) {
      capabilityProblems.push("The router's clock is not synced yet: schedules keep their no-schedule rates until it is.")
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {pauses.shaper ? (
        <LoudBanner
          tone="critical"
          icon={<WarningOctagon className="size-5" weight="fill" />}
          title="Shaping is paused on the router"
          actions={
            isAdmin && overview.managed ? (
              <Button size="sm" variant="outline" onClick={() => setConfirmOverride(true)}>
                Resume over the router's pause…
              </Button>
            ) : null
          }
        >
          <p>
            Someone switched Perch's shaper off on the gateway itself
            {overview.paused?.at ? ` (seen ${formatLastSeen(overview.paused.at)})` : ''}. No device cap, bucket or
            schedule is enforced right now. <strong>Perch never switches it back on by itself</strong>, not even in
            Authoritative Mode: that is a safety switch for whoever is at the router.
          </p>
        </LoudBanner>
      ) : null}

      {pauses.queues.map((device) => (
        <LoudBanner
          key={device}
          tone="critical"
          icon={<WarningOctagon className="size-5" weight="fill" />}
          title={`WAN queue on ${device} is switched off on the router`}
        >
          <p>
            The router set <span className="font-mono">sqm enabled=0</span> for {device}, so its line runs without
            smart queueing (expect lag under load). <strong>Perch keeps it off and never reverts it</strong>; switch it
            back on in LuCI, or from its row below when you know why it was paused.
          </p>
        </LoudBanner>
      ))}

      {!overview.managed ? (
        <LoudBanner tone="info" icon={<Info className="size-5" />} title="Watch only: this gateway is not in managed mode">
          <p>
            Perch shows the gateway's shaping but cannot change it. The WAN queue the router already has keeps running
            exactly as it is, and no device gets a cap: that is the safe default. To set caps (for example on a guest or
            lab network), an admin turns on management for the gateway first.
          </p>
        </LoudBanner>
      ) : null}

      {overview.paused?.by === 'controller' ? (
        <LoudBanner
          tone="warning"
          icon={<Pause className="size-5" weight="fill" />}
          title="Shaping is paused from Perch"
          actions={
            isAdmin ? (
              <Button size="sm" onClick={() => writes.resume.mutate(false)} disabled={writes.resume.isPending}>
                <Play className="size-3.5" weight="fill" /> Resume
              </Button>
            ) : null
          }
        >
          <p>
            Paused {overview.paused.at ? formatWhen(overview.paused.at) : ''}. Device caps, buckets and schedules are
            lifted on the router; WAN queues keep running. Everything stays configured here.
          </p>
        </LoudBanner>
      ) : null}

      {overview.managed && overview.config.error === 'plane_unavailable' ? (
        <LoudBanner tone="info" icon={<PlugsConnected className="size-5" />} title="Queued: config plane unavailable">
          <p>
            {devicesInSync ? (
              <>
                <strong>Per-device caps apply now.</strong> Perch sends each device's cap straight to the gateway's
                collector ({overview.devices.entries} {overview.devices.entries === 1 ? 'entry' : 'entries'}, in sync).
              </>
            ) : (
              <>Per-device caps go straight to the gateway's collector and do not wait for this.</>
            )}{' '}
            The rest of the shaper's config (shared buckets, network defaults, schedules) is written to the router
            through the config plane, which this controller cannot use yet. It is kept and offered again on every change
            and every 5 minutes, so nothing is lost.
          </p>
        </LoudBanner>
      ) : overview.managed && config.detail && overview.config.state !== 'in_sync' ? (
        <LoudBanner tone="warning" icon={<Info className="size-5" />} title={`Shaper config: ${config.label}`}>
          <p>{config.detail}</p>
        </LoudBanner>
      ) : null}

      {capabilityProblems.length > 0 ? (
        <LoudBanner tone="warning" icon={<ShieldCheck className="size-5" />} title="The gateway needs attention before caps can hold">
          <ul className="list-disc space-y-0.5 pl-4">
            {capabilityProblems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </LoudBanner>
      ) : null}

      {overview.errors.length > 0 || overview.issues.length > 0 ? (
        <section className="card-surface space-y-2 px-4 py-3">
          <h2 className="text-[13px] font-semibold">Problems</h2>
          <IssueList
            issues={[
              ...overview.errors.map((e) => ({
                severity: 'error' as const,
                code: e.code,
                message: [e.message, e.mac, e.device].filter(Boolean).join(' · '),
              })),
              ...overview.issues,
            ]}
          />
        </section>
      ) : null}

      <Dialog open={confirmOverride} onOpenChange={setConfirmOverride}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resume over the router's pause?</DialogTitle>
            <DialogDescription>The router's own safety switch is on.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p>
              Someone at the gateway paused the shaper on purpose, perhaps because a cap broke something. Resuming from
              here switches every device cap, bucket and schedule back on.
            </p>
            <p>Only do this when you know why it was paused.</p>
            {writes.resume.error ? <RefusalAlert error={writes.resume.error} /> : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOverride(false)}>
              Keep it paused
            </Button>
            <Button
              variant="destructive"
              disabled={writes.resume.isPending}
              onClick={() =>
                writes.resume.mutate(true, {
                  onSuccess: () => setConfirmOverride(false),
                })
              }
            >
              Resume anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** Pause / Resume in the page header (admins, managed gateways). */
export function PauseControl({ overview, writes }: { overview: QosOverview; writes: QosWrites }) {
  const [confirm, setConfirm] = useState(false)
  if (!overview.managed) return null
  if (overview.paused) return null // the banner carries Resume
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setConfirm(true)}>
        <Pause className="size-3.5" weight="fill" /> Pause shaping
      </Button>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pause shaping on this gateway?</DialogTitle>
            <DialogDescription>Nothing is deleted.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p>
              The router lifts every device cap, bucket and schedule until you resume. WAN queues keep running. Policies,
              groups, assignments and quotas stay here as they are.
            </p>
            {writes.pause.error ? <RefusalAlert error={writes.pause.error} /> : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              disabled={writes.pause.isPending}
              onClick={() => writes.pause.mutate(undefined, { onSuccess: () => setConfirm(false) })}
            >
              Pause shaping
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
