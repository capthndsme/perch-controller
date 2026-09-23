import { useMemo, useState } from 'react'
import { Lock, MagnifyingGlass } from '@phosphor-icons/react'
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
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import { Spinner } from '@/components/ui/spinner'
import { DiffList, ErrorLine, ToneBadge, UciValueText } from '@/components/gateway-config/bits'
import { useSections, useSectionDetail, useSetSectionScope } from '@/hooks/use-gateways'
import {
  formatAgo,
  formatDateTime,
  ISSUE_LABEL,
  optionRows,
  REVISION_SOURCE_LABEL,
  refusalMessage,
  routerAuthorLabel,
  sameValue,
  SCOPE_META,
  STATUS_META,
} from '@/lib/gateway-config'
import { cn } from '@/lib/utils'
import type { Gateway, GatewaySection, SectionContent, SectionScope } from '@/types/gateway-config'

type ScopeFilter = 'all' | SectionScope

/** Every section of the gateway's allowlisted configs, by config, with scope and status. */
export function SectionsBrowser({ gateway, isAdmin }: { gateway: Gateway; isAdmin: boolean }) {
  const [scope, setScope] = useState<ScopeFilter>('all')
  const [config, setConfig] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const sections = useSections(gateway.id, { scope: scope === 'all' ? undefined : scope })

  const configs = useMemo(() => {
    const names = new Set<string>()
    for (const d of gateway.domains) for (const c of d.configs) names.add(c)
    for (const s of sections.data ?? []) names.add(s.config)
    return [...names].sort()
  }, [gateway.domains, sections.data])

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (sections.data ?? []).filter(
      (s) =>
        (config === 'all' || s.config === config) &&
        (!q || `${s.config}.${s.section} ${s.type} ${s.domain ?? ''}`.toLowerCase().includes(q)),
    )
  }, [sections.data, config, search])

  const grouped = useMemo(() => {
    const map = new Map<string, GatewaySection[]>()
    for (const s of rows) map.set(s.config, [...(map.get(s.config) ?? []), s])
    return [...map.entries()]
  }, [rows])

  return (
    <Panel
      title="Sections"
      description="Every section of the configs Perch may read. Synced ones are managed two-way; excluded and unmodeled ones are mirrored only."
      updating={sections.isPlaceholderData}
      actions={
        <Segmented
          size="xs"
          ariaLabel="Scope"
          value={scope}
          onChange={setScope}
          options={[
            { id: 'all', label: 'All' },
            { id: 'synced', label: `Synced (${gateway.counts.synced})` },
            { id: 'excluded', label: `Excluded (${gateway.counts.excluded})` },
            { id: 'unmodeled', label: `Unmodeled (${gateway.counts.unmodeled})` },
          ]}
        />
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <MagnifyingGlass className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter sections"
            className="pl-7"
            aria-label="Filter sections"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {['all', ...configs].map((c) => (
            <Button key={c} size="xs" variant={config === c ? 'secondary' : 'ghost'} onClick={() => setConfig(c)}>
              {c === 'all' ? 'All configs' : c}
            </Button>
          ))}
        </div>
      </div>

      {sections.isPending ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : grouped.length === 0 ? (
        <EmptyState
          title="No sections"
          description={gateway.mode === 'off' ? 'The config plane is off: Perch has not read the router.' : 'Nothing matches.'}
        />
      ) : (
        <div className="space-y-4">
          {grouped.map(([name, list]) => (
            <div key={name}>
              <p className="section-label mb-1">{name}</p>
              <ul className="divide-y divide-border/70 rounded-md border border-border">
                {list.map((s) => (
                  <li key={s.perchId}>
                    <button
                      type="button"
                      onClick={() => setOpen(s.perchId)}
                      className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-2 text-left text-xs hover:bg-muted/40"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="font-mono font-medium">{s.section}</span>
                        <span className="ml-2 text-muted-foreground">{s.type}</span>
                        {s.domain ? <span className="ml-2 text-muted-foreground">· {s.domain}</span> : null}
                      </span>
                      {s.routerAuthor && s.routerAuthor.kind !== 'perch' && s.routerChangedAt ? (
                        <span className="text-[11px] text-muted-foreground">
                          changed on the router by {routerAuthorLabel(s.routerAuthor)} {formatAgo(s.routerChangedAt)}
                        </span>
                      ) : null}
                      {s.issue ? <ToneBadge tone="warning" title={ISSUE_LABEL[s.issue]}>{s.issue.replace(/_/g, ' ')}</ToneBadge> : null}
                      <ToneBadge tone={SCOPE_META[s.scope].tone}>{SCOPE_META[s.scope].label}</ToneBadge>
                      {s.scope === 'synced' ? (
                        <ToneBadge tone={STATUS_META[s.status].tone} dot>
                          {STATUS_META[s.status].label}
                        </ToneBadge>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <SectionDialog gatewayId={gateway.id} perchId={open} isAdmin={isAdmin} onClose={() => setOpen(null)} />
    </Panel>
  )
}

type View = 'compare' | 'base' | 'router' | 'desired'

function ContentTable({ content }: { content: SectionContent | null }) {
  if (!content) return <p className="text-muted-foreground">Absent.</p>
  const names = [...new Set([...Object.keys(content.options), ...Object.keys(content.secrets ?? {})])].sort()
  return (
    <div className="rounded-md border border-border">
      <p className="border-b border-border bg-muted/30 px-2.5 py-1 font-mono text-[11px]">type {content.type}</p>
      <table className="w-full text-[11px]">
        <tbody>
          {names.map((name) => (
            <tr key={name} className="border-t border-border/60 first:border-t-0">
              <td className="w-1/3 px-2.5 py-1 font-mono">{name}</td>
              <td className="px-2.5 py-1">
                {content.secrets?.[name] ? (
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <Lock className="size-3" /> secret <span className="font-mono">{content.secrets[name].fingerprint}</span>
                    {content.secrets[name].setByController ? ' (set by Perch)' : ''}
                  </span>
                ) : (
                  <UciValueText value={content.options[name]} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** One section: base / router / Perch views, the per-option comparison, scope and history. */
export function SectionDialog({
  gatewayId,
  perchId,
  isAdmin,
  onClose,
}: {
  gatewayId: number
  perchId: string | null
  isAdmin: boolean
  onClose: () => void
}) {
  const detail = useSectionDetail(gatewayId, perchId)
  const setScope = useSetSectionScope(gatewayId)
  const [view, setView] = useState<View>('compare')
  const section = detail.data?.section

  return (
    <Dialog open={perchId !== null} onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle className="font-mono">
            {section ? `${section.config}.${section.section}` : 'Section'}
          </DialogTitle>
          <DialogDescription>
            {section
              ? `${section.type}${section.domain ? ` · ${section.domain}` : ''}${section.anonymous ? ' · anonymous on the router' : ''}`
              : 'Loading…'}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {!section ? (
            detail.error ? <ErrorLine message={refusalMessage(detail.error)} /> : <Spinner />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <ToneBadge tone={SCOPE_META[section.scope].tone}>{SCOPE_META[section.scope].label}</ToneBadge>
                {section.scope === 'synced' ? (
                  <ToneBadge tone={STATUS_META[section.status].tone} dot>
                    {STATUS_META[section.status].label}
                  </ToneBadge>
                ) : null}
                {section.baseRevision !== null ? (
                  <span className="text-muted-foreground">Base from revision {section.baseRevision}</span>
                ) : null}
                {section.routerAuthor ? (
                  <span className="text-muted-foreground">
                    Last router edit: {routerAuthorLabel(section.routerAuthor)}, {formatAgo(section.routerChangedAt)}
                  </span>
                ) : null}
              </div>
              <p className="text-muted-foreground">{SCOPE_META[section.scope].hint}</p>
              {section.issue ? <p className="text-status-serious">{ISSUE_LABEL[section.issue]}.</p> : null}
              {section.ownership ? (
                <p className="text-muted-foreground">
                  Perch owns only <span className="font-mono">{section.ownership.options.join(', ')}</span> here; the
                  other options are the router’s and always take its value.
                </p>
              ) : null}

              <Segmented
                size="xs"
                ariaLabel="View"
                value={view}
                onChange={setView}
                options={[
                  { id: 'compare', label: 'Compare' },
                  { id: 'base', label: 'Base', title: 'Last content both sides agreed on' },
                  { id: 'router', label: 'Router', title: 'The router’s content at the last read' },
                  { id: 'desired', label: 'Perch', title: 'What Perch wants' },
                ]}
              />
              {view === 'compare' ? (
                <CompareTable section={section} />
              ) : (
                <ContentTable content={view === 'base' ? section.base : view === 'router' ? section.router : section.desired} />
              )}

              <div className="space-y-2">
                <p className="section-label">History of this section</p>
                {(detail.data?.history.items ?? []).length === 0 ? (
                  <p className="text-muted-foreground">No revisions touched it yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {detail.data!.history.items.map((rev) => (
                      <li key={rev.number} className="space-y-1">
                        <p className="flex flex-wrap items-center gap-2">
                          <span className="font-mono">#{rev.number}</span>
                          <ToneBadge tone="neutral">{REVISION_SOURCE_LABEL[rev.source]}</ToneBadge>
                          <span className="text-muted-foreground">
                            {rev.author?.email ?? routerAuthorLabel(rev.routerAuthor) ?? ''} · {formatDateTime(rev.createdAt)}
                          </span>
                        </p>
                        <DiffList entries={[rev.change]} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <ErrorLine message={setScope.error ? refusalMessage(setScope.error) : null} />
            </>
          )}
        </DialogBody>
        {section && isAdmin && section.scope !== 'unmodeled' ? (
          <DialogFooter>
            <Button
              variant="outline"
              disabled={setScope.isPending}
              onClick={() =>
                setScope.mutate({ perchId: section.perchId, scope: section.scope === 'synced' ? 'excluded' : 'synced' })
              }
            >
              {setScope.isPending ? <Spinner className="size-3.5" /> : null}
              {section.scope === 'synced' ? 'Exclude (router-only)' : 'Include in sync'}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function CompareTable({ section }: { section: GatewaySection }) {
  const rows = optionRows(section)
  if (rows.length === 0) return <p className="text-muted-foreground">No options.</p>
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-[520px] text-[11px]">
        <thead>
          <tr className="border-b border-border bg-muted/30 text-left text-muted-foreground">
            <th className="px-2.5 py-1 font-medium">Option</th>
            <th className="px-2.5 py-1 font-medium">Base</th>
            <th className="px-2.5 py-1 font-medium">Router</th>
            <th className="px-2.5 py-1 font-medium">Perch</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const routerMoved = !sameValue(row.router, row.base)
            const perchMoved = !sameValue(row.desired, row.base)
            return (
              <tr key={row.name} className={cn('border-t border-border/60 align-top', !row.owned && 'text-muted-foreground')}>
                <td className="px-2.5 py-1 font-mono">
                  {row.name}
                  {!row.owned ? <span className="ml-1 text-[10px]">(router’s)</span> : null}
                </td>
                <td className="px-2.5 py-1">
                  <UciValueText value={row.base} />
                </td>
                <td className={cn('px-2.5 py-1', routerMoved && 'bg-status-warning/10')}>
                  <UciValueText value={row.router} />
                </td>
                <td className={cn('px-2.5 py-1', perchMoved && 'bg-status-good/10')}>
                  <UciValueText value={row.desired} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="border-t border-border px-2.5 py-1 text-[10px] text-muted-foreground">
        Shaded: changed since the base (router in amber, Perch in green).
      </p>
    </div>
  )
}
