import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowCounterClockwise,
  CaretRight,
  DotsThree,
  MagnifyingGlass,
  PushPin,
  PushPinSlash,
  SlidersHorizontal,
  Terminal,
} from '@phosphor-icons/react'
import { DeviceStatus, ToneDot } from '@/components/agent-updates/job-state'
import { VersionArrow, VersionBadge } from '@/components/agent-updates/version-badge'
import { UnencryptedBadge } from '@/components/security/plain-http'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useMediaQuery } from '@/hooks/use-media-query'
import { formatBytes } from '@/lib/format-bytes'
import { devicePagePath, isOpenJob, PRODUCT_LABEL, ROLE_LABEL } from '@/lib/agent-updates'
import { cn } from '@/lib/utils'
import type { RolloutMember } from '@/hooks/use-agent-updates'
import type { AgentUpdateDevice } from '@/types/agent-updates'

export type FleetAction = 'update' | 'check' | 'rollback' | 'manual' | 'hold' | 'unhold' | 'settings'

type FleetTableProps = {
  devices: AgentUpdateDevice[]
  isAdmin: boolean
  onOpen: (device: AgentUpdateDevice) => void
  onAction: (device: AgentUpdateDevice, action: FleetAction) => void
  /** Devices an open rollout still has to update: their row offers no update of its own. */
  members?: Map<string, RolloutMember>
}

/** Where the device's previous version waits: the open job's store, else a kept `previous`. */
function rollbackCopy(device: AgentUpdateDevice): { label: string; hint: string | null } {
  const job = device.activeJob
  if (job && isOpenJob(job.state) && job.rollbackStore) {
    return { label: job.rollbackStore === 'flash' ? 'Flash' : 'Memory', hint: job.fromVersion }
  }
  if (device.selfUpdate.previous) return { label: 'Flash', hint: device.selfUpdate.previous.version }
  return { label: 'None', hint: null }
}

function FreeFlash({ device }: { device: AgentUpdateDevice }) {
  const flash = device.selfUpdate.flash
  if (!flash) return <span className="text-muted-foreground">—</span>
  const tight = flash.freeBytes < 6 * 1024 * 1024
  return (
    <span className={cn('tabular-nums', tight && 'text-status-warning')} title={`${flash.fsType}, ${formatBytes(flash.totalBytes)} in all`}>
      {formatBytes(flash.freeBytes)}
    </span>
  )
}

function Connection({ device }: { device: AgentUpdateDevice }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <ToneDot tone={device.online ? 'good' : 'critical'} />
        {device.online ? 'Online' : 'Offline'}
      </span>
      {device.online && device.secure === false ? (
        <UnencryptedBadge title="Plain HTTP: keep the controller and this device on a management VLAN." />
      ) : null}
    </span>
  )
}

/** The primary action a row offers, if any. */
function primaryAction(device: AgentUpdateDevice, member: RolloutMember | undefined): FleetAction | null {
  if (!device.selfUpdate.supported) return device.manualCommand ? 'manual' : null
  if (device.activeJob || member) return null
  if (device.available && !device.pinnedVersion) return 'update'
  return null
}

function RowMenu({
  device,
  member,
  onAction,
}: {
  device: AgentUpdateDevice
  member: RolloutMember | undefined
  onAction: (device: AgentUpdateDevice, action: FleetAction) => void
}) {
  const [open, setOpen] = useState(false)
  const supported = device.selfUpdate.supported
  const job = device.activeJob
  const canRollBack =
    supported && ((job && (job.state === 'installing' || job.state === 'probation')) || (!job && device.selfUpdate.previous !== null))
  const items: { action: FleetAction; label: string; icon: typeof DotsThree; disabled?: boolean }[] = supported
    ? [
        {
          action: 'update',
          label: member ? `Update… (rollout #${member.rolloutId} has it)` : 'Update…',
          icon: CaretRight,
          disabled: job !== null || member !== undefined,
        },
        { action: 'check', label: 'Dry run…', icon: MagnifyingGlass, disabled: job !== null },
        { action: 'rollback', label: job ? 'Stop and roll back…' : 'Roll back…', icon: ArrowCounterClockwise, disabled: !canRollBack },
        device.pinnedVersion
          ? { action: 'unhold', label: 'Stop holding', icon: PushPinSlash }
          : { action: 'hold', label: `Hold at ${device.version ?? 'this version'}`, icon: PushPin, disabled: !device.version },
        { action: 'settings', label: 'Channel and auto-update…', icon: SlidersHorizontal },
      ]
    : [{ action: 'manual', label: 'How to update…', icon: Terminal }]

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`More actions for ${device.name}`}
          onClick={(event) => event.stopPropagation()}
        >
          <DotsThree weight="bold" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1" onClick={(event) => event.stopPropagation()}>
        <ul role="menu" aria-label={`Actions for ${device.name}`}>
          {items.map((item) => (
            <li key={item.action} role="none">
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors duration-base hover:bg-muted active:bg-muted active:duration-0 disabled:pointer-events-none disabled:opacity-45"
                onClick={() => {
                  setOpen(false)
                  onAction(device, item.action)
                }}
              >
                <item.icon className="size-3.5 text-muted-foreground" />
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

function PrimaryButton({
  device,
  member,
  onAction,
  className,
}: {
  device: AgentUpdateDevice
  member: RolloutMember | undefined
  onAction: (device: AgentUpdateDevice, action: FleetAction) => void
  className?: string
}) {
  const action = primaryAction(device, member)
  if (!action) return null
  return (
    <Button
      type="button"
      size="sm"
      variant={action === 'update' ? 'default' : 'outline'}
      className={className}
      onClick={(event) => {
        event.stopPropagation()
        onAction(device, action)
      }}
    >
      {action === 'update' ? 'Update' : 'How to update'}
    </Button>
  )
}

/**
 * Every agent with its version, what it could take, and what it is doing. A
 * table from md up; on a phone one stacked row per device (tap for the sheet).
 * Rows keep their order on every refresh (products, then names).
 */
export function FleetTable({ devices, isAdmin, onOpen, onAction, members }: FleetTableProps) {
  const narrow = useMediaQuery('(width < 48rem)')

  if (narrow) {
    return (
      <ul className="card-surface divide-y divide-border overflow-hidden">
        {devices.map((device) => (
          <li key={device.key}>
            {/* The whole row opens the sheet under a finger; the name is the keyboard's way in. */}
            <div
              onClick={() => onOpen(device)}
              className="flex cursor-pointer items-start gap-3 px-3.5 py-3 transition-colors duration-base select-none has-[button[data-row-open]:focus-visible]:bg-muted/40 hover:bg-muted/40 active:bg-muted/70 active:duration-0"
            >
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex items-center gap-2">
                  <ToneDot tone={device.online ? 'good' : 'critical'} />
                  <button
                    type="button"
                    data-row-open
                    className="min-w-0 truncate text-left text-sm font-medium outline-none"
                    onClick={(event) => {
                      event.stopPropagation()
                      onOpen(device)
                    }}
                  >
                    {device.name}
                  </button>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{ROLE_LABEL[device.role]}</span>
                </div>
                {device.activeJob ? (
                  <VersionArrow from={device.activeJob.fromVersion} to={device.activeJob.toVersion} />
                ) : device.available && !device.pinnedVersion ? (
                  <VersionArrow from={device.version} to={device.available.version} />
                ) : (
                  <VersionBadge device={device} />
                )}
                <DeviceStatus device={device} member={members?.get(device.key)} />
                {device.online && device.secure === false ? (
                  <UnencryptedBadge title="Plain HTTP: keep the controller and this device on a management VLAN." />
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1 self-center">
                {isAdmin ? <PrimaryButton device={device} member={members?.get(device.key)} onAction={onAction} /> : null}
                <CaretRight className="size-4 text-muted-foreground" aria-hidden />
              </div>
            </div>
          </li>
        ))}
      </ul>
    )
  }

  return (
    <div className="card-surface overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th>Device</th>
            <th>Version</th>
            <th>Available</th>
            <th className="w-56">Status</th>
            <th>Rollback copy</th>
            <th className="text-right">Free flash</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {devices.map((device) => {
            const copy = rollbackCopy(device)
            const page = devicePagePath(device)
            return (
              <tr key={device.key} data-clickable="true" onClick={() => onOpen(device)}>
                <td className="max-w-64">
                  <div className="space-y-0.5">
                    <p className="flex items-center gap-2">
                      {page ? (
                        <Link
                          to={page}
                          className="truncate font-medium underline-offset-2 hover:underline"
                          onClick={(event) => event.stopPropagation()}
                        >
                          {device.name}
                        </Link>
                      ) : (
                        <span className="truncate font-medium">{device.name}</span>
                      )}
                    </p>
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                      <span>
                        {ROLE_LABEL[device.role]} · {PRODUCT_LABEL[device.product]}
                      </span>
                      <Connection device={device} />
                    </p>
                  </div>
                </td>
                <td>
                  <VersionBadge device={device} />
                </td>
                <td className="whitespace-nowrap">
                  {device.available ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="font-mono text-xs tabular-nums">{device.available.version}</span>
                      {device.available.newerThanController ? (
                        <Badge
                          variant="outline"
                          className="h-4 px-1.5 text-[10px]"
                          title="Newer than the version this controller installs on new devices"
                        >
                          newer
                        </Badge>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td>
                  <DeviceStatus device={device} member={members?.get(device.key)} />
                </td>
                <td className="whitespace-nowrap">
                  <span className={cn(copy.label === 'None' && 'text-muted-foreground')}>{copy.label}</span>
                  {copy.hint ? <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">{copy.hint}</span> : null}
                </td>
                <td className="text-right">
                  <FreeFlash device={device} />
                </td>
                <td className="w-px whitespace-nowrap text-right">
                  {isAdmin ? (
                    <span className="inline-flex items-center gap-1">
                      <PrimaryButton device={device} member={members?.get(device.key)} onAction={onAction} />
                      <RowMenu device={device} member={members?.get(device.key)} onAction={onAction} />
                    </span>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

