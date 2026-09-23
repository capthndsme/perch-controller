import { ArrowRight, Check, Info, Package, Warning } from '@phosphor-icons/react'
import { Panel } from '@/components/ui/panel'
import { Callout, IssueList, SyncBadge, ToneBadge } from '@/components/firewall/firewall-ui'
import { targetTone } from '@/lib/firewall'
import { cn } from '@/lib/utils'
import type { FirewallOverview, FirewallZone } from '@/types/firewall'

function Policy({ value, label }: { value: string | null; label: string }) {
  if (!value) return <span className="text-muted-foreground">—</span>
  return (
    <ToneBadge tone={targetTone(value)} title={`${label}: ${value}`} className="font-mono text-[10.5px]">
      {value}
    </ToneBadge>
  )
}

function ZoneName({ zone }: { zone: FirewallZone }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className="font-mono font-medium">{zone.name}</span>
      {zone.wan ? <ToneBadge tone="info">WAN</ToneBadge> : null}
      {zone.management ? (
        <ToneBadge tone="warning" title="The gateway reaches Perch through this zone: rules that cut it are refused.">
          Management path
        </ToneBadge>
      ) : null}
    </span>
  )
}

/**
 * The firewall at a glance (firewall.md section 1): zones with their networks
 * and policies, which zone may forward to which, the defaults, and what
 * Perch only observes (includes, other sets, NAT).
 */
export function FirewallOverviewPanel({ overview }: { overview: FirewallOverview }) {
  const zones = overview.zones
  const forwardingOf = (src: string, dest: string) => overview.forwardings.find((f) => f.src === src && f.dest === dest)
  const errors = overview.issues.filter((i) => i.severity === 'error')
  const warnings = overview.issues.filter((i) => i.severity === 'warning')
  const defaults = overview.defaults ?? {}

  return (
    <div className="flex flex-col gap-4">
      {overview.flowOffloadingHw ? (
        <Callout tone="warning" title="Hardware flow offloading is on">
          Offloaded connections bypass the router’s CPU: traffic counts, per-device caps and blocks can miss them. It is
          set in the firewall defaults on the router; Perch leaves it alone.
        </Callout>
      ) : null}

      {errors.length > 0 || warnings.length > 0 ? (
        <Panel
          title="Checks"
          description={`${errors.length} errors, ${warnings.length} warnings in the firewall configuration Perch knows.`}
        >
          <IssueList issues={errors} />
          {warnings.length > 0 ? (
            <details className={cn(errors.length > 0 && 'mt-3')}>
              <summary className="cursor-pointer text-xs font-medium">
                {warnings.length} warning{warnings.length === 1 ? '' : 's'}
              </summary>
              <IssueList issues={warnings} className="mt-2" />
            </details>
          ) : null}
        </Panel>
      ) : null}

      <Panel
        flush
        title="Zones"
        description="Each network belongs to a zone; a zone’s policies say what happens to traffic no rule matches. Zones are created and changed with the networks."
      >
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-left text-[12.5px]">
            <thead className="border-y border-border bg-muted/30 text-[11px] text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Zone</th>
                <th className="px-3 py-2 font-medium">Networks</th>
                <th className="px-3 py-2 font-medium" title="Traffic to the router itself">
                  To router
                </th>
                <th className="px-3 py-2 font-medium" title="Traffic from the router">
                  From router
                </th>
                <th className="px-3 py-2 font-medium" title="Traffic between networks of this zone and other zones">
                  Forward
                </th>
                <th className="px-3 py-2 font-medium">NAT</th>
                <th className="px-3 py-2 font-medium">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {zones.map((z) => (
                <tr key={z.name} className="align-top">
                  <td className="px-3 py-2">
                    <ZoneName zone={z} />
                  </td>
                  <td className="px-3 py-2">
                    <span className="flex flex-wrap gap-1">
                      {z.networks.length ? (
                        z.networks.map((n) => (
                          <ToneBadge key={n} tone="muted" className="font-mono text-[10.5px] text-foreground">
                            {n}
                          </ToneBadge>
                        ))
                      ) : (
                        <span className="text-muted-foreground">none</span>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <Policy value={z.input} label="Input" />
                  </td>
                  <td className="px-3 py-2">
                    <Policy value={z.output} label="Output" />
                  </td>
                  <td className="px-3 py-2">
                    <Policy value={z.forward} label="Forward" />
                  </td>
                  <td className="px-3 py-2 text-[11.5px]">
                    {z.masq ? 'Masquerade' : <span className="text-muted-foreground">—</span>}
                    {z.mtuFix ? <span className="block text-muted-foreground">MSS clamping</span> : null}
                  </td>
                  <td className="px-3 py-2">
                    <SyncBadge sync={z.sync} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="divide-y divide-border/70 border-t border-border md:hidden">
          {zones.map((z) => (
            <li key={z.name} className="space-y-1.5 px-4 py-3">
              <div className="flex items-start justify-between gap-2">
                <ZoneName zone={z} />
                <SyncBadge sync={z.sync} />
              </div>
              <p className="text-[11.5px] text-muted-foreground">
                Networks: <span className="font-mono text-foreground">{z.networks.join(', ') || 'none'}</span>
                {z.masq ? ' · masquerade' : ''}
              </p>
              <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  To router <Policy value={z.input} label="Input" />
                </span>
                <span className="flex items-center gap-1">
                  Forward <Policy value={z.forward} label="Forward" />
                </span>
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel
          title="Which zone may reach which"
          description="A forwarding lets new connections go from one zone to another (answers always come back)."
        >
          {zones.length === 0 ? (
            <p className="text-xs text-muted-foreground">No zones.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-[12px]">
                <thead>
                  <tr>
                    <th className="px-2 py-1.5 text-left text-[10.5px] font-medium text-muted-foreground">from ↓ to →</th>
                    {zones.map((z) => (
                      <th key={z.name} className="px-2 py-1.5 text-center font-mono font-medium">
                        {z.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {zones.map((src) => (
                    <tr key={src.name} className="border-t border-border/70">
                      <th className="px-2 py-1.5 text-left font-mono font-medium">{src.name}</th>
                      {zones.map((dest) => {
                        if (src.name === dest.name) {
                          return (
                            <td key={dest.name} className="px-2 py-1.5 text-center text-muted-foreground/60">
                              ·
                            </td>
                          )
                        }
                        const f = forwardingOf(src.name, dest.name)
                        return (
                          <td key={dest.name} className="px-2 py-1.5 text-center">
                            {f ? (
                              <span
                                title={`${src.name} → ${dest.name}${f.enabled ? '' : ' (disabled)'}${f.family !== 'any' ? ` · ${f.family}` : ''}`}
                                className={cn(
                                  'inline-flex size-5 items-center justify-center rounded',
                                  f.enabled ? 'bg-status-good/15 text-status-good' : 'bg-muted text-muted-foreground',
                                )}
                              >
                                <Check className="size-3.5" weight="bold" />
                              </span>
                            ) : (
                              <span className="text-muted-foreground/60">–</span>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {overview.forwardings.length > 0 ? (
            <ul className="mt-3 flex flex-wrap gap-1.5">
              {overview.forwardings.map((f) => (
                <li key={f.sync.perchId}>
                  <ToneBadge tone="muted" className={cn('font-mono text-[10.5px] text-foreground', !f.enabled && 'line-through opacity-60')}>
                    {f.src}
                    <ArrowRight className="size-3" />
                    {f.dest}
                    {f.family !== 'any' ? ` (${f.family})` : ''}
                  </ToneBadge>
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>

        <Panel title="Defaults" description="Read only: the router’s global firewall settings. Perch never changes them.">
          {Object.keys(defaults).length === 0 ? (
            <p className="text-xs text-muted-foreground">No defaults section.</p>
          ) : (
            <dl className="divide-y divide-border/70 text-[12px]">
              {Object.entries(defaults).map(([key, value]) => (
                <div key={key} className="flex items-start justify-between gap-3 py-1.5">
                  <dt className="font-mono text-muted-foreground">{key}</dt>
                  <dd className="text-right font-mono">{Array.isArray(value) ? value.join(' ') : value}</dd>
                </div>
              ))}
            </dl>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel
          title="Includes"
          description="Extra nftables rules added by packages or by hand: observed, managed by their package. Perch never edits or reverts them."
        >
          {overview.includes.length === 0 ? (
            <p className="text-xs text-muted-foreground">None.</p>
          ) : (
            <ul className="divide-y divide-border/70 text-[12px]">
              {overview.includes.map((inc) => (
                <li key={inc.perchId} className="flex items-start gap-2 py-2">
                  <Package className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono" title={inc.path ?? inc.section}>
                      {inc.path ?? inc.section}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {inc.owner === 'package'
                        ? 'Managed by its package'
                        : inc.owner === 'perch'
                          ? 'Perch’s own'
                          : 'Added by hand on the router'}
                      {inc.type ? ` · ${inc.type}` : ''}
                      {inc.position ? ` · ${inc.position}` : ''} · section {inc.section}
                    </p>
                  </div>
                  <ToneBadge tone="muted">Observed</ToneBadge>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Other sections" description="IP sets and NAT the router has; Perch writes only its own internet-block set.">
          {overview.ipsets.length === 0 && overview.observed.length === 0 ? (
            <p className="text-xs text-muted-foreground">None.</p>
          ) : (
            <ul className="divide-y divide-border/70 text-[12px]">
              {overview.ipsets.map((set) => (
                <li key={set.perchId} className="flex items-start justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="font-mono">{set.name ?? set.section}</p>
                    <p className="text-[11px] text-muted-foreground">
                      IP set · {set.match.join(', ') || 'no match'} · {set.entries} entr{set.entries === 1 ? 'y' : 'ies'}
                    </p>
                  </div>
                  <ToneBadge tone={set.managed ? 'info' : 'muted'}>{set.managed ? 'Perch' : 'Observed'}</ToneBadge>
                </li>
              ))}
              {overview.observed.map((o) => (
                <li key={o.perchId} className="flex items-start justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="font-mono">{o.section}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {o.type === 'redirect' ? 'SNAT redirect' : o.type === 'nat' ? 'NAT rule' : o.type}
                    </p>
                  </div>
                  <ToneBadge tone="muted">Observed</ToneBadge>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <p className="flex items-start gap-1.5 text-[11.5px] text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        Runtime checks (fw4’s own check, the live contents of the block set) are not reported yet: “In sync” compares the
        router’s configuration files.
      </p>
      {overview.managementZone === null ? (
        <p className="flex items-start gap-1.5 text-[11.5px] text-status-warning">
          <Warning className="mt-0.5 size-3.5 shrink-0" />
          The gateway has not reported the network it reaches Perch through, so the management-path guard can only
          protect your own access for now.
        </p>
      ) : null}
    </div>
  )
}
