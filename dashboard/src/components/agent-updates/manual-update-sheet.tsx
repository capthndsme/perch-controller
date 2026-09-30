import { Terminal } from '@phosphor-icons/react'
import { PlainHttpNotice } from '@/components/security/plain-http'
import { CopyButton } from '@/components/ui/copy-button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatDateTime, UNSUPPORTED_TEXT } from '@/lib/agent-updates'
import type { AgentUpdateDevice } from '@/types/agent-updates'

/** The update can be made by hand when the dashboard cannot: why, and the one-time command. */
export function ManualUpdate({ device }: { device: AgentUpdateDevice }) {
  const command = device.manualCommand
  const why = device.selfUpdate.reason ? UNSUPPORTED_TEXT[device.selfUpdate.reason] : null
  const plainHttp = command ? /(^|['"\s=])http:\/\//i.test(command.command) : false

  return (
    <div className="space-y-3">
      {why ? <p>{why}</p> : null}
      {command ? (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex min-w-0 items-center gap-1.5 font-medium">
              <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
              {command.title}
            </p>
            <CopyButton value={command.command} ariaLabel={`Copy the command: ${command.title}`} />
          </div>
          <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap select-all">
            {command.command}
          </pre>
          <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
            {command.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
            {command.expiresAt ? <li>The download link inside works until {formatDateTime(command.expiresAt)}.</li> : null}
          </ul>
        </div>
      ) : (
        <p className="text-muted-foreground">
          This controller has no file for this device yet (check for releases, or upload a build for its
          architecture{device.selfUpdate.arch ? `, ${device.selfUpdate.arch}` : ''}).
        </p>
      )}
      {plainHttp ? (
        <PlainHttpNotice>
          The command downloads over plain HTTP. The file is checked against its hash before anything is replaced, but
          anyone on this network can see which versions run where. Keep the controller and your devices on a
          management VLAN, or serve the controller over HTTPS.
        </PlainHttpNotice>
      ) : null}
    </div>
  )
}

/** ManualUpdate in a dialog (the fleet row's "How to update"). */
export function ManualUpdateSheet({
  device,
  open,
  onOpenChange,
}: {
  device: AgentUpdateDevice | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide>
        {device ? (
          <>
            <DialogHeader>
              <DialogTitle>Update {device.name} by hand</DialogTitle>
              <DialogDescription>
                {device.selfUpdate.reason === 'agent_too_old'
                  ? 'Run this once as root on the device. After that it updates from this page.'
                  : 'This device does not update from the dashboard; this is how to update it yourself.'}
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <ManualUpdate device={device} />
            </DialogBody>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
