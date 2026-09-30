import { CheckCircle, WarningCircle } from '@phosphor-icons/react'
import { formatBytes } from '@/lib/format-bytes'
import { INSTALL_KIND_TEXT, METHOD_LABEL, reasonText } from '@/lib/agent-updates'
import { cn } from '@/lib/utils'
import type { AgentPreflight } from '@/types/agent-updates'

/**
 * Space on the device against what the update needs: the need, then the
 * reserve that must stay free, over the free space. Red when they do not fit.
 */
function SpaceMeter({ free, need, reserve, label }: { free: number; need: number; reserve: number; label: string }) {
  const scale = Math.max(free, need + reserve, 1)
  const fits = need + reserve <= free
  return (
    <div className="space-y-1">
      <div
        className="relative flex h-2 w-full overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`${label}: needs ${formatBytes(need)} plus ${formatBytes(reserve)} kept free, ${formatBytes(free)} free`}
      >
        <span className={cn('h-full', fits ? 'bg-brand' : 'bg-status-critical')} style={{ width: `${(need / scale) * 100}%` }} />
        <span
          className={cn('h-full', fits ? 'bg-brand/35' : 'bg-status-critical/40')}
          style={{ width: `${(reserve / scale) * 100}%` }}
        />
        {!fits ? (
          <span aria-hidden className="absolute inset-y-0 w-0.5 bg-foreground" style={{ left: `${(free / scale) * 100}%` }} />
        ) : null}
      </div>
      <p className="flex flex-wrap justify-between gap-x-3 text-[11px] text-muted-foreground tabular-nums">
        <span>
          Needs {formatBytes(need)} + {formatBytes(reserve)} kept free
        </span>
        <span className={cn(!fits && 'font-medium text-status-critical')}>{formatBytes(free)} free</span>
      </p>
    </div>
  )
}

/** A dry run's answer in words: does it fit, where the old version waits, what stands in the way. */
export function PreflightSummary({ preflight }: { preflight: AgentPreflight }) {
  const { flash, ram } = preflight
  return (
    <div className="space-y-3">
      {preflight.ok ? (
        <p className="flex items-start gap-2 rounded-md border border-status-good/40 bg-status-good/10 px-2.5 py-2">
          <CheckCircle weight="fill" className="mt-px size-4 shrink-0 text-status-good" />
          <span>
            <span className="font-medium">It fits.</span> The device verified the release and has the room to keep
            its current version until the new one checks in.
          </span>
        </p>
      ) : (
        <div className="space-y-1.5 rounded-md border border-status-critical/40 bg-status-critical/10 px-2.5 py-2">
          <p className="flex items-center gap-2 font-medium">
            <WarningCircle weight="fill" className="size-4 shrink-0 text-status-critical" />
            It would not update now
          </p>
          <ul className="list-disc space-y-0.5 pl-9">
            {preflight.problems.map((p) => (
              <li key={p.code}>
                {p.message || reasonText(p.code)}
                {p.needBytes !== undefined && p.freeBytes !== undefined
                  ? ` (needs ${formatBytes(p.needBytes)}, ${formatBytes(p.freeBytes)} free)`
                  : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {preflight.busy ? (
        <p className="rounded-md border border-status-warning/40 bg-status-warning/10 px-2.5 py-2">
          Waits for: {reasonText(preflight.busy)}.
        </p>
      ) : null}

      <div className="space-y-1.5">
        <p className="font-medium">
          Flash <span className="font-normal text-muted-foreground">({flash.fsType} at {flash.path})</span>
        </p>
        <SpaceMeter free={flash.freeBytes} need={flash.needBytes} reserve={flash.reserveBytes} label="Flash" />
        <p className="text-[11px] text-muted-foreground">
          Estimated as {flash.estimate}.{' '}
          {flash.hardlink
            ? 'The running version is kept as a hardlink, so keeping it costs no extra space.'
            : 'The running version is copied aside while the new one is checked.'}
        </p>
      </div>

      <div className="space-y-1.5">
        <p className="font-medium">
          Memory{' '}
          <span className="font-normal text-muted-foreground">
            ({preflight.staging === 'ram' ? 'the download waits in /tmp' : 'the download waits on flash'})
          </span>
        </p>
        <SpaceMeter
          free={Math.min(ram.memAvailableBytes, ram.tmpFreeBytes)}
          need={ram.needBytes}
          reserve={ram.reserveBytes}
          label="Memory"
        />
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Method</dt>
        <dd>{METHOD_LABEL[preflight.method]}</dd>
        <dt className="text-muted-foreground">Download</dt>
        <dd className="tabular-nums">{formatBytes(preflight.downloadBytes)}</dd>
        <dt className="text-muted-foreground">Rollback copy</dt>
        <dd>
          {preflight.rollbackStore === 'flash'
            ? 'On flash: survives a restart'
            : preflight.rollbackStore === 'ram'
              ? 'In memory: lost if the device restarts during the check'
              : 'None'}
        </dd>
        <dt className="text-muted-foreground">Install</dt>
        <dd>{INSTALL_KIND_TEXT[preflight.installKind]}</dd>
      </dl>
    </div>
  )
}
