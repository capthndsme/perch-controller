import { Fragment, useState } from 'react'
import {
  ArrowSquareOut,
  CaretDown,
  CheckCircle,
  CloudArrowUp,
  GithubLogo,
  HardDrives,
  RocketLaunch,
  Trash,
} from '@phosphor-icons/react'
import { ChannelBadge } from '@/components/agent-updates/version-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Label } from '@/components/ui/label'
import { PanelOverlay } from '@/components/ui/panel-overlay'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { useAgentReleases, useDeleteRelease, useWithdrawRelease } from '@/hooks/use-agent-updates'
import { useMediaQuery } from '@/hooks/use-media-query'
import { formatBytes } from '@/lib/format-bytes'
import { compareVersions, formatDate, PRODUCTS, refusalMessage } from '@/lib/agent-updates'
import { cn } from '@/lib/utils'
import type { AgentArtefact, AgentProduct, AgentRelease } from '@/types/agent-updates'

type ProductFilter = 'all' | AgentProduct

function target(a: AgentArtefact): string {
  if (a.kind === 'binary') return [a.arch, a.variant].filter(Boolean).join(' · ')
  if (a.kind === 'package') return [a.manager, a.openwrtSeries, a.pkgArch].filter(Boolean).join(' · ')
  return 'companion files'
}

function Source({ release }: { release: AgentRelease }) {
  return release.source === 'github' ? (
    <span className="inline-flex items-center gap-1">
      <GithubLogo className="size-3.5 text-muted-foreground" />
      GitHub
    </span>
  ) : (
    <span className="inline-flex items-center gap-1">
      <HardDrives className="size-3.5 text-muted-foreground" />
      Local build
    </span>
  )
}

function storedCount(release: AgentRelease) {
  const stored = release.artefacts.filter((a) => a.stored).length
  return { stored, total: release.artefacts.length }
}

/** A release's files and its version rules, opened under its row. */
function ReleaseDetail({ release }: { release: AgentRelease }) {
  return (
    <div className="space-y-3 text-xs transition-opacity duration-base ease-out starting:opacity-0">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">Signed by</dt>
        <dd>
          {release.keyLabel ?? 'Unnamed key'} <span className="font-mono text-muted-foreground">{release.keyId}</span>
        </dd>
        <dt className="text-muted-foreground">Floor after it</dt>
        <dd className="font-mono">{release.minVersion ?? 'unchanged'}</dd>
        {release.minFromVersion ? (
          <>
            <dt className="text-muted-foreground">Installs over</dt>
            <dd className="font-mono">{release.minFromVersion} or newer</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Needs controller</dt>
        <dd className="font-mono">{release.minControllerVersion ?? 'any'}</dd>
        <dt className="text-muted-foreground">Imported</dt>
        <dd>{formatDate(release.importedAt)}</dd>
        {release.notesUrl ? (
          <>
            <dt className="text-muted-foreground">Notes</dt>
            <dd>
              <a className="inline-flex items-center gap-1 underline underline-offset-2" href={release.notesUrl} target="_blank" rel="noreferrer">
                Release notes <ArrowSquareOut className="size-3" />
              </a>
            </dd>
          </>
        ) : null}
      </dl>
      <ul className="divide-y divide-border/70 rounded-md border border-border">
        {release.artefacts.map((a) => (
          <li key={a.id} className="flex items-center gap-3 px-2.5 py-1.5">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[11px]" title={a.file}>
                {a.file}
              </span>
              <span className="block text-[11px] text-muted-foreground">{target(a)}</span>
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{formatBytes(a.sizeBytes)}</span>
            <span className="w-16 shrink-0 text-right text-[11px]">
              {a.stored ? (
                <span className="inline-flex items-center gap-1 text-status-good">
                  <CheckCircle weight="fill" className="size-3.5" />
                  Stored
                </span>
              ) : (
                <span className="text-muted-foreground" title={release.source === 'github' ? 'Fetched from GitHub when a device needs it' : 'Not uploaded'}>
                  {release.source === 'github' ? 'On demand' : 'Missing'}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Actions({
  release,
  onRollout,
  onError,
}: {
  release: AgentRelease
  onRollout: (release: AgentRelease) => void
  onError: (message: string | null) => void
}) {
  const withdraw = useWithdrawRelease()
  const remove = useDeleteRelease()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const withdrawn = release.withdrawnAt !== null

  if (confirmDelete) {
    return (
      <span className="inline-flex flex-wrap items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
        <Button
          type="button"
          size="xs"
          variant="destructive"
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(release.id, {
              onError: (error) => {
                setConfirmDelete(false)
                onError(`${release.product} ${release.version}: ${refusalMessage(error)}`)
              },
            })
          }
        >
          Delete {release.version}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={() => setConfirmDelete(false)}>
          Keep
        </Button>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
      {release.offerable && release.devicesEligible > 0 ? (
        <Button type="button" size="xs" variant="outline" onClick={() => onRollout(release)}>
          <RocketLaunch />
          Roll out
        </Button>
      ) : null}
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={withdraw.isPending}
        onClick={() =>
          withdraw.mutate(
            { id: release.id, withdrawn: !withdrawn },
            { onError: (error) => onError(refusalMessage(error)), onSuccess: () => onError(null) },
          )
        }
        title={withdrawn ? 'Offer it again' : 'Stop offering it; devices that run it keep it'}
      >
        {withdrawn ? 'Restore' : 'Withdraw'}
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={`Delete ${release.product} ${release.version}`}
        onClick={() => setConfirmDelete(true)}
      >
        <Trash />
      </Button>
    </span>
  )
}

/**
 * Releases on this controller, per product and newest first: where each came
 * from, who signed it, how many of its files are stored, how many devices run
 * it. Tap a row for its files. Admins withdraw, delete, roll out and upload.
 */
export function ReleasesPanel({
  isAdmin,
  onUpload,
  onRollout,
}: {
  isAdmin: boolean
  onUpload: () => void
  onRollout: (release: AgentRelease) => void
}) {
  const [product, setProduct] = useState<ProductFilter>('all')
  const [withdrawn, setWithdrawn] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const query = useAgentReleases(product === 'all' ? null : product, withdrawn)
  const narrow = useMediaQuery('(width < 48rem)')
  const releases = query.data ?? []
  const products = PRODUCTS.filter((p) => product === 'all' || p === product)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Segmented
          value={product}
          onChange={setProduct}
          options={[{ id: 'all', label: 'All' }, ...PRODUCTS.map((p) => ({ id: p, label: p }))]}
          ariaLabel="Product"
          size="xs"
        />
        <div className="flex items-center gap-2">
          <Switch id="show-withdrawn" checked={withdrawn} onCheckedChange={setWithdrawn} aria-label="Show withdrawn releases" />
          <Label htmlFor="show-withdrawn" className="text-xs">
            Withdrawn too
          </Label>
        </div>
        {isAdmin ? (
          <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={onUpload}>
            <CloudArrowUp />
            Upload local build
          </Button>
        ) : null}
      </div>

      {error ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
      ) : null}

      {query.isPending ? (
        <p className="text-xs text-muted-foreground">Loading releases…</p>
      ) : query.error ? (
        <p className="text-xs text-destructive">{query.error.message}</p>
      ) : releases.length === 0 ? (
        <EmptyState
          title="No releases yet"
          description="GitHub releases appear after the next check; local builds after an upload."
        />
      ) : (
        products.map((p) => {
          const list = releases.filter((r) => r.product === p).sort((a, b) => compareVersions(b.version, a.version))
          if (list.length === 0) return null
          return (
            <section key={p} className="relative space-y-2">
              <h2 className="section-label">{p}</h2>
              {narrow ? (
                <ul className="card-surface divide-y divide-border overflow-hidden">
                  {list.map((release) => {
                    const { stored, total } = storedCount(release)
                    const open = expanded === release.id
                    return (
                      <li key={release.id} className={cn(release.withdrawnAt && 'opacity-60')}>
                        <button
                          type="button"
                          aria-expanded={open}
                          onClick={() => setExpanded(open ? null : release.id)}
                          className="flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors duration-base active:bg-muted/70 active:duration-0"
                        >
                          <span className="min-w-0 flex-1 space-y-1">
                            <span className="flex flex-wrap items-center gap-1.5">
                              <span className="font-mono text-sm font-medium">{release.version}</span>
                              <ChannelBadge channel={release.channel} />
                              {release.withdrawnAt ? (
                                <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                                  Withdrawn
                                </Badge>
                              ) : null}
                            </span>
                            <span className="flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                              <Source release={release} />
                              <span>{formatDate(release.releasedAt ?? release.importedAt)}</span>
                              <span className="tabular-nums">
                                {stored}/{total} files
                              </span>
                              <span className="tabular-nums">{release.devicesOn} running it</span>
                            </span>
                          </span>
                          <CaretDown
                            className={cn('mt-1 size-4 shrink-0 text-muted-foreground transition-[rotate] duration-base ease-out', open && 'rotate-180')}
                          />
                        </button>
                        {open ? (
                          <div className="space-y-3 px-3.5 pb-3">
                            <ReleaseDetail release={release} />
                            {isAdmin ? <Actions release={release} onRollout={onRollout} onError={setError} /> : null}
                          </div>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <div className="card-surface overflow-x-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Version</th>
                        <th>Source</th>
                        <th>Signed by</th>
                        <th>Released</th>
                        <th className="text-right">Files</th>
                        <th className="text-right">Devices</th>
                        <th aria-label="Actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((release) => {
                        const { stored, total } = storedCount(release)
                        const open = expanded === release.id
                        return (
                          <Fragment key={release.id}>
                            <tr
                              data-clickable="true"
                              aria-expanded={open}
                              className={cn(release.withdrawnAt && 'opacity-60')}
                              onClick={() => setExpanded(open ? null : release.id)}
                            >
                              <td>
                                <span className="inline-flex flex-wrap items-center gap-1.5">
                                  <CaretDown
                                    className={cn('size-3.5 text-muted-foreground transition-[rotate] duration-base ease-out', open && 'rotate-180')}
                                  />
                                  <span className="font-mono font-medium">{release.version}</span>
                                  <ChannelBadge channel={release.channel} />
                                  {release.withdrawnAt ? (
                                    <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                                      Withdrawn
                                    </Badge>
                                  ) : null}
                                  {!release.offerable && release.notOfferableReason === 'controller_too_old' ? (
                                    <Badge variant="outline" className="h-4 border-status-warning/50 px-1.5 text-[10px]">
                                      Needs a newer controller
                                    </Badge>
                                  ) : null}
                                </span>
                              </td>
                              <td>
                                <Source release={release} />
                              </td>
                              <td className="text-muted-foreground">{release.keyLabel ?? release.keyId}</td>
                              <td className="whitespace-nowrap">{formatDate(release.releasedAt ?? release.importedAt)}</td>
                              <td className={cn('text-right tabular-nums', stored < total && release.source === 'upload' && 'text-status-warning')}>
                                {stored}/{total}
                              </td>
                              <td className="text-right tabular-nums">
                                {release.devicesOn}
                                {release.devicesEligible > 0 ? (
                                  <span className="text-muted-foreground"> · {release.devicesEligible} can take it</span>
                                ) : null}
                              </td>
                              <td className="w-px whitespace-nowrap text-right">
                                {isAdmin ? <Actions release={release} onRollout={onRollout} onError={setError} /> : null}
                              </td>
                            </tr>
                            {open ? (
                              <tr>
                                <td colSpan={7} className="bg-muted/20">
                                  <ReleaseDetail release={release} />
                                </td>
                              </tr>
                            ) : null}
                          </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <PanelOverlay show={query.isPlaceholderData} label="Updating…" />
            </section>
          )
        })
      )}
    </div>
  )
}
