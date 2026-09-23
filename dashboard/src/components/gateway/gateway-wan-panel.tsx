import { Info, Warning } from '@phosphor-icons/react'
import { FactRow, NotReported, ObservedLine, StateChip, TableScroll } from '@/components/gateway/observation-bits'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Panel } from '@/components/ui/panel'
import { formatUptime, wanSummary } from '@/lib/gateway-observation'
import { cn } from '@/lib/utils'
import type { GatewayInterfacesResponse, GatewayWanStatus, Mwan3Observation, WanInterface } from '@/types/api'

type GatewayWanPanelProps = {
  wan: GatewayWanStatus | undefined
  interfaces: GatewayInterfacesResponse | undefined
  isPending: boolean
  error: Error | null
  /** The agent ever reported `interfaces`. */
  reported: boolean
}

/**
 * WAN status: one card per WAN (interfaces with a default route, mwan3's
 * members, the gateway report's WAN list), how the router fails over between
 * them, and mwan3's config and service state apart, loudly when it is
 * installed but not running. Then every network the router has.
 */
export function GatewayWanPanel({ wan, interfaces, isPending, error, reported }: GatewayWanPanelProps) {
  const summary = wan ? wanSummary(wan) : null
  // Without mwan3 the lowest-metric default route that is up carries everything.
  const carrier =
    summary && summary.mode !== 'mwan3'
      ? (wan?.wans.find((item) => item.defaultRoute === true && item.up)?.network ?? null)
      : null
  return (
    <Panel
      title="WAN"
      description={wan ? <ObservedLine observedAt={wan.observedAt} /> : 'Uplinks, default routes and failover.'}
    >
      {isPending ? (
        <p className="text-xs text-muted-foreground">Loading WAN status…</p>
      ) : error ? (
        <p className="text-xs text-destructive">{error.message}</p>
      ) : !reported || !wan || !summary ? (
        <NotReported what="interfaces" />
      ) : (
        <div className="space-y-4">
          {summary.mwan3Warning ? (
            <Alert className="rounded-lg border-status-warning/50 bg-status-warning/10" data-testid="mwan3-warning">
              <Warning className="size-4 text-status-warning" weight="fill" />
              <AlertTitle className="text-sm">{summary.mwan3Warning.title}</AlertTitle>
              <AlertDescription>{summary.mwan3Warning.detail}</AlertDescription>
            </Alert>
          ) : null}

          <div className="rounded-lg border bg-muted/20 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-[13px] font-medium">
              <Info className="size-4 text-muted-foreground" />
              {summary.title}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{summary.detail}</p>
          </div>

          {wan.wans.length === 0 ? (
            <p className="text-xs text-muted-foreground">No WAN interface in the router's report.</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {wan.wans.map((item) => (
                <WanCard key={item.network} wan={item} primary={item.network === carrier && wan.wans.length > 1} />
              ))}
            </div>
          )}

          {wan.mwan3 ? <Mwan3Section mwan3={wan.mwan3} /> : null}

          {interfaces && interfaces.interfaces.length > 0 ? (
            <div className="space-y-2">
              <p className="section-label">All networks</p>
              <TableScroll>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Network</th>
                      <th>Device</th>
                      <th>Protocol</th>
                      <th>State</th>
                      <th>Addresses</th>
                    </tr>
                  </thead>
                  <tbody>
                    {interfaces.interfaces.map((iface) => (
                      <tr key={iface.network}>
                        <td className="font-medium">{iface.network}</td>
                        <td className="whitespace-nowrap font-mono text-[12px]">{iface.device ?? '—'}</td>
                        <td>{iface.proto ?? '—'}</td>
                        <td>
                          <span className="inline-flex items-center gap-1.5">
                            <span
                              aria-hidden
                              className={cn('inline-block size-1.5 rounded-full', iface.up ? 'bg-status-good' : 'bg-muted-foreground/40')}
                            />
                            {iface.up ? 'up' : 'down'}
                            {iface.error ? <span className="text-status-serious">· {iface.error}</span> : null}
                          </span>
                        </td>
                        <td className="font-mono text-[12px]">
                          {[...iface.ipv4, ...iface.ipv6].join(', ') || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  )
}

function WanCard({ wan, primary }: { wan: WanInterface; primary: boolean }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-[13px] font-semibold">
          <span
            aria-hidden
            className={cn('inline-block size-2 rounded-full', wan.up ? 'bg-status-good' : 'bg-status-critical')}
          />
          {wan.network}
          {wan.ifname ? <span className="font-mono text-xs font-normal text-muted-foreground">{wan.ifname}</span> : null}
        </p>
        <div className="flex flex-wrap gap-1">
          {primary ? <Badge className="rounded text-[10px]">carries traffic</Badge> : null}
          {wan.defaultRoute ? (
            <Badge variant="outline" className="rounded text-[10px]">
              default route{wan.metric !== null ? ` · metric ${wan.metric}` : ''}
            </Badge>
          ) : (
            <Badge variant="outline" className="rounded text-[10px] text-muted-foreground">
              no default route
            </Badge>
          )}
        </div>
      </div>
      <div className="mt-1 divide-y divide-border/70">
        <FactRow label="State">{wan.up ? `up for ${formatUptime(wan.uptimeSeconds)}` : 'down'}</FactRow>
        <FactRow label="Protocol">{wan.proto ?? '—'}</FactRow>
        <FactRow label="Address">
          <span className="font-mono text-[12px]">{[...wan.ipv4, ...wan.ipv6].join(', ') || '—'}</span>
        </FactRow>
        <FactRow label="Gateway">
          <span className="font-mono text-[12px]">{[wan.gateway4, wan.gateway6].filter(Boolean).join(', ') || '—'}</span>
        </FactRow>
        <FactRow label="DNS">
          <span className="font-mono text-[12px]">{wan.dnsServers.join(', ') || '—'}</span>
        </FactRow>
        {wan.mwan3Status ? <FactRow label="mwan3">{wan.mwan3Status}</FactRow> : null}
        {wan.error ? (
          <FactRow label="Error">
            <span className="text-status-serious">{wan.error}</span>
          </FactRow>
        ) : null}
      </div>
    </div>
  )
}

/** mwan3, read-only: the service state, then the config, then the live status, each on its own. */
function Mwan3Section({ mwan3 }: { mwan3: Mwan3Observation }) {
  const policies = Object.entries(mwan3.configPolicies)
  const livePolicies = Object.entries(mwan3.policies)
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-semibold">mwan3</p>
        <span className="text-[11px] text-muted-foreground">read-only · Perch does not change mwan3</span>
      </div>
      <div className="space-y-1.5">
        <p className="section-label">Service</p>
        <div className="flex flex-wrap gap-1.5">
          <StateChip label="installed" value={mwan3.service?.installed ?? true} />
          <StateChip label="starts at boot" value={mwan3.service?.enabled} />
          <StateChip label="running" value={mwan3.service?.running} />
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <p className="section-label">Config: interfaces</p>
          {mwan3.configInterfaces.length === 0 ? (
            <p className="text-xs text-muted-foreground">None configured.</p>
          ) : (
            <ul className="space-y-1 text-[12.5px]">
              {mwan3.configInterfaces.map((iface) => (
                <li key={iface.name} className="flex flex-wrap items-center gap-x-2">
                  <span className="font-medium">{iface.name}</span>
                  <span className="text-muted-foreground">
                    {iface.enabled === false ? 'disabled' : 'enabled'}
                    {iface.family ? ` · ${iface.family}` : ''}
                    {iface.trackIps.length > 0 ? ` · tracks ${iface.trackIps.join(', ')}` : ' · no tracking'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="space-y-1.5">
          <p className="section-label">Config: policies</p>
          {policies.length === 0 ? (
            <p className="text-xs text-muted-foreground">None configured.</p>
          ) : (
            <ul className="space-y-1 text-[12.5px]">
              {policies.map(([name, members]) => (
                <li key={name}>
                  <span className="font-medium">{name}</span>{' '}
                  <span className="text-muted-foreground">{members.join(', ') || 'no members'}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {mwan3.interfaces.length > 0 || livePolicies.length > 0 ? (
        <div className="space-y-1.5">
          <p className="section-label">Live status</p>
          <ul className="space-y-1 text-[12.5px]">
            {mwan3.interfaces.map((iface) => (
              <li key={iface.name} className="flex flex-wrap items-center gap-x-2">
                <span className="font-medium">{iface.name}</span>
                <span className="text-muted-foreground">
                  {iface.status ?? 'unknown'}
                  {iface.tracking ? ` · tracking ${iface.tracking}` : ''}
                  {iface.trackIps.length > 0
                    ? ` · ${iface.trackIps.map((t) => `${t.ip} ${t.up === false ? 'down' : t.up ? 'up' : '?'}`).join(', ')}`
                    : ''}
                </span>
              </li>
            ))}
            {livePolicies.map(([name, members]) => (
              <li key={`policy-${name}`}>
                <span className="font-medium">{name}</span>{' '}
                <span className="text-muted-foreground">
                  {members.map((m) => (m.percent !== null ? `${m.interface} ${m.percent}%` : m.interface)).join(', ')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No live status: mwan3 does not answer while it is not running.</p>
      )}
    </div>
  )
}
