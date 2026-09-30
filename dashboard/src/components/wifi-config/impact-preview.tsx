import { useState, type ReactNode } from 'react'
import {
  ArrowsClockwise,
  CaretDown,
  Crosshair,
  DeviceMobile,
  Key,
  ShieldWarning,
  Timer,
  UsersThree,
  WifiSlash,
} from '@phosphor-icons/react'
import { DiffList, ErrorLine, IssueList, ToneBadge } from '@/components/gateway-config/bits'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { EditorSheet } from '@/components/wifi-config/sheet'
import { durationText, plural } from '@/lib/wifi-config'
import { cn } from '@/lib/utils'
import type { ImpactAp, ImpactPreview } from '@/types/wifi-config'

function Fact({ icon, tone = 'muted', children }: { icon: ReactNode; tone?: 'muted' | 'warn' | 'alarm'; children: ReactNode }) {
  return (
    <li
      className={cn(
        'flex items-start gap-1.5',
        tone === 'muted' && 'text-muted-foreground',
        tone === 'warn' && 'text-foreground',
        tone === 'alarm' && 'font-medium text-foreground',
      )}
    >
      <span
        className={cn(
          'mt-px shrink-0 [&>svg]:size-3.5',
          tone === 'warn' && 'text-status-warning',
          tone === 'alarm' && 'text-status-serious',
        )}
      >
        {icon}
      </span>
      <span>{children}</span>
    </li>
  )
}

function radioWords(radios: string[]): string {
  if (radios.length === 1) return radios[0]
  return `${radios.length} radios (${radios.join(', ')})`
}

function ImpactApRow({ ap, position, adminSsid }: { ap: ImpactAp; position: number; adminSsid: string | null }) {
  const [open, setOpen] = useState(false)
  const changes = ap.jobs.flatMap((job) => job.changes)
  const protectedJob = ap.jobs.some((job) => job.protected)
  return (
    <li className="rounded-lg border border-border" data-testid="impact-ap">
      <div className="flex items-start gap-3 p-3">
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted font-mono text-[11px] font-semibold tabular-nums">
          {position}
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold">{ap.apName}</span>
            {!ap.online ? (
              <ToneBadge tone="neutral">
                <WifiSlash aria-hidden className="size-3" />
                Offline: catches up later
              </ToneBadge>
            ) : null}
            {protectedJob ? <ToneBadge tone="serious">Management path</ToneBadge> : null}
          </div>
          <ul className="space-y-1 text-xs">
            {ap.restartsRadio.length > 0 ? (
              <Fact icon={<ArrowsClockwise weight="bold" />} tone="warn">
                Restarts {radioWords(ap.restartsRadio)}:{' '}
                {ap.clientsAffected > 0 ? `${plural(ap.clientsAffected, 'client')} reconnect` : 'no clients on it now'}
              </Fact>
            ) : ap.touchedBss > 0 ? (
              <Fact icon={<UsersThree weight="bold" />} tone={ap.clientsAffected > 0 ? 'warn' : 'muted'}>
                {plural(ap.touchedBss, 'network')} change here
                {ap.clientsAffected > 0 ? `: ${plural(ap.clientsAffected, 'client')} reconnect` : ''}
              </Fact>
            ) : null}
            {ap.dfs ? (
              <Fact icon={<Crosshair weight="bold" />} tone="warn">
                Radar check on {ap.dfs.radio}: up to {durationText(ap.dfs.cacSeconds)} without Wi-Fi on that radio
              </Fact>
            ) : null}
            {ap.adminDeviceHere ? (
              <Fact icon={<DeviceMobile weight="bold" />} tone="alarm">
                Your device is connected through {ap.apName}
                {adminSsid ? ` on ${adminSsid}` : ''}: it goes last and will drop off for a moment
              </Fact>
            ) : null}
            {protectedJob ? (
              <Fact icon={<ShieldWarning weight="bold" />} tone="alarm">
                Touches the access point’s own uplink: you confirm it with Keep changes
              </Fact>
            ) : null}
            <Fact icon={<Timer weight="bold" />}>
              Rolls back by itself unless it checks in within {durationText(ap.windowSeconds)}
            </Fact>
          </ul>
          {changes.length > 0 ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <CaretDown
                aria-hidden
                className={cn(
                  'size-3 transition-transform duration-base ease-out motion-reduce:transition-none',
                  open ? 'rotate-0' : '-rotate-90',
                )}
              />
              {open ? 'Hide' : 'Show'} {plural(changes.length, 'section')} that change
            </button>
          ) : null}
          {open ? <DiffList entries={changes} beforeLabel="Now" afterLabel="After" /> : null}
        </div>
      </div>
    </li>
  )
}

/**
 * What a change does to each access point, in rollout order (controller.md
 * 6.3): sections changed, radios restarted and clients that reconnect, radar
 * checks, the admin's own device, the rollback window.
 */
export function ImpactPreviewList({
  preview,
  notes,
}: {
  preview: ImpactPreview
  /** Extra warnings of the change itself (a passphrase change, a security downgrade). */
  notes?: ReactNode
}) {
  const online = preview.aps.filter((ap) => ap.online).length
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {preview.aps.length === 0
          ? 'No access point changes.'
          : `${plural(preview.aps.length, 'access point')}, one at a time${
              online < preview.aps.length ? ` (${preview.aps.length - online} offline, caught up when back)` : ''
            }. The rollout stops at the first access point that fails, and that one restores its previous settings.`}
      </p>
      {notes}
      {preview.warnings.length > 0 ? <IssueList issues={preview.warnings} /> : null}
      <ol className="space-y-2">
        {[...preview.aps]
          .sort((a, b) => a.order - b.order)
          .map((ap, i) => (
            <ImpactApRow
              key={ap.apId}
              ap={ap}
              position={i + 1}
              adminSsid={preview.adminDevice?.apId === ap.apId ? preview.adminDevice.ssid : null}
            />
          ))}
      </ol>
    </div>
  )
}

/** "Every device on Home WiFi must re-enter the new passphrase." */
export function PassphraseChangeNote({ ssid }: { ssid: string }) {
  return (
    <p className="flex items-start gap-2 rounded-md border border-status-warning/60 bg-status-warning/10 px-2.5 py-2 text-xs font-medium">
      <Key weight="fill" className="mt-px size-3.5 shrink-0 text-status-warning" />
      Every device on {ssid} must re-enter the new passphrase.
    </p>
  )
}

/**
 * The impact preview as a sheet (a bottom sheet on a phone): Apply starts the
 * rollout, Keep as draft leaves the change saved in Perch without touching
 * the access points.
 */
export function ImpactSheet({
  open,
  onOpenChange,
  title,
  preview,
  notes,
  applying,
  error,
  onApply,
  onKeepDraft,
  applyLabel,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  preview: ImpactPreview | null
  notes?: ReactNode
  applying: boolean
  error: string | null
  onApply: () => void
  onKeepDraft: () => void
  applyLabel?: string
}) {
  const count = preview?.aps.length ?? 0
  return (
    <EditorSheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description="Saved in Perch. Nothing has changed on the access points yet."
      wide
      footer={
        <>
          <Button variant="outline" onClick={onKeepDraft} disabled={applying}>
            Keep as draft
          </Button>
          <Button onClick={onApply} disabled={applying || !preview || count === 0} data-testid="impact-apply">
            {applying ? <Spinner className="size-3.5 text-current" /> : null}
            {applyLabel ?? (count === 1 ? 'Apply to 1 access point' : `Apply to ${count} access points`)}
          </Button>
        </>
      }
    >
      {preview ? <ImpactPreviewList preview={preview} notes={notes} /> : <Spinner />}
      <ErrorLine message={error} />
    </EditorSheet>
  )
}
