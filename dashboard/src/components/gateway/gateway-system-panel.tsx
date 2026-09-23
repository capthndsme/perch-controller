import { Warning } from '@phosphor-icons/react'
import { FactRow, NotReported, ObservedLine } from '@/components/gateway/observation-bits'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Panel } from '@/components/ui/panel'
import { DECISION_LABELS, FEATURE_LABELS, formatUptime, yesNo } from '@/lib/gateway-observation'
import { cn } from '@/lib/utils'
import type { GatewayResolver, GatewaySystem } from '@/types/api'

type SystemProps = {
  data: GatewaySystem | undefined
  isPending: boolean
  error: Error | null
  reported: boolean
}

/**
 * The router itself (admin): board, release, kernel, uptime, flow offloading
 * (the page shows the hardware offloading warning above everything),
 * and the native features Perch knows with what it does with each.
 */
export function GatewaySystemPanel({ data, isPending, error, reported }: SystemProps) {
  const installed = data?.features.filter((f) => f.installed === true) ?? []
  const others = data?.features.filter((f) => f.installed !== true) ?? []
  return (
    <Panel title="System" description={data ? <ObservedLine observedAt={data.observedAt} /> : 'The router itself.'}>
      {isPending ? (
        <p className="text-xs text-muted-foreground">Loading system…</p>
      ) : error ? (
        <p className="text-xs text-destructive">{error.message}</p>
      ) : !reported || !data ? (
        <NotReported what="system facts" />
      ) : (
        <div className="space-y-4">
          <div className="divide-y divide-border/70">
            <FactRow label="Hostname">{data.hostname ?? '—'}</FactRow>
            <FactRow label="Model">{data.model ?? data.boardName ?? '—'}</FactRow>
            <FactRow label="Target">{data.board ?? '—'}</FactRow>
            <FactRow label="Release">
              {data.release ?? '—'}
              {data.revision && !data.release?.includes(data.revision) ? (
                <span className="block font-mono text-[11px] text-muted-foreground">{data.revision}</span>
              ) : null}
            </FactRow>
            <FactRow label="Kernel">
              <span className="font-mono text-[12px]">{data.kernel ?? '—'}</span>
            </FactRow>
            <FactRow label="Uptime">{formatUptime(data.uptimeSeconds)}</FactRow>
            <FactRow label="Flow offloading">
              software {yesNo(data.flowOffloading)} · hardware{' '}
              <span className={cn(data.flowOffloadingHw === true && 'font-medium text-status-critical')}>
                {yesNo(data.flowOffloadingHw)}
              </span>
            </FactRow>
            <FactRow label="Packages">
              {data.packages
                ? `${data.packages.length} installed${data.packageManager ? ` (${data.packageManager})` : ''}${
                    data.upgradable && data.upgradable.length > 0 ? ` · ${data.upgradable.length} upgradable` : ''
                  }`
                : 'not reported'}
            </FactRow>
          </div>
          <div className="space-y-1.5">
            <p className="section-label">Features</p>
            <ul className="grid gap-x-4 gap-y-1 text-[12.5px] sm:grid-cols-2">
              {[...installed, ...others].map((feature) => {
                const decision = DECISION_LABELS[feature.decision] ?? { label: feature.decision, hint: '' }
                return (
                  <li key={feature.name} className="flex items-center justify-between gap-2" title={decision.hint}>
                    <span className={cn('truncate', feature.installed !== true && 'text-muted-foreground')}>
                      {FEATURE_LABELS[feature.name] ?? feature.name}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span className="text-[11px] text-muted-foreground">
                        {feature.installed === true ? 'installed' : feature.installed === false ? 'not installed' : '?'}
                      </span>
                      {feature.installed === true ? (
                        <Badge variant="outline" className="rounded text-[10px]">
                          {decision.label}
                        </Badge>
                      ) : null}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      )}
    </Panel>
  )
}

/** Plan 2's offloading warning: hardware offloading hides forwarded bytes from the capture. */
export function HardwareOffloadingAlert({ className }: { className?: string }) {
  return (
    <Alert variant="destructive" className={cn('rounded-lg border-status-critical/50 bg-status-critical/10', className)}>
      <Warning className="size-4" weight="fill" />
      <AlertTitle className="text-sm">Hardware flow offloading is on</AlertTitle>
      <AlertDescription>
        The router's switch forwards established connections past the CPU, so the collector does not see
        their bytes: traffic, protocol and destination numbers read low. Turn hardware offloading off on
        the router that captures (Network → Firewall → Routing/NAT Offloading in LuCI); software
        offloading is fine.
      </AlertDescription>
    </Alert>
  )
}

type ResolverProps = {
  resolver: GatewayResolver | null | undefined
  isPending: boolean
  error: Error | null
}

/**
 * Who answers DNS on the router: the process on port 53 and where dnsmasq
 * listens. AdGuard Home in front of dnsmasq is observed only; Perch never
 * changes it.
 */
export function GatewayResolverPanel({ resolver, isPending, error }: ResolverProps) {
  const owner = resolver?.port53Process ?? null
  const dnsmasqFronted = resolver && resolver.dnsmasqPort !== null && resolver.dnsmasqPort !== 53 && resolver.dnsmasqPort !== 0
  const adguard = owner !== null && /adguard/i.test(owner)
  return (
    <Panel title="Resolver" description="Who answers DNS for the network.">
      {isPending ? (
        <p className="text-xs text-muted-foreground">Loading resolver…</p>
      ) : error ? (
        <p className="text-xs text-destructive">{error.message}</p>
      ) : !resolver ? (
        <NotReported what="resolver facts" />
      ) : (
        <div className="space-y-3">
          <div className="divide-y divide-border/70">
            <FactRow label="Port 53">
              {owner ?? 'nothing listening'}
              {resolver.port53Processes.length > 1 ? (
                <span className="block text-[11px] text-muted-foreground">also {resolver.port53Processes.filter((p) => p !== owner).join(', ')}</span>
              ) : null}
            </FactRow>
            <FactRow label="dnsmasq DNS">
              {resolver.dnsmasqPort === null
                ? 'no dnsmasq'
                : resolver.dnsmasqPort === 0
                  ? 'off (DHCP only)'
                  : `port ${resolver.dnsmasqPort}`}
            </FactRow>
            {resolver.controllerHost ? (
              <FactRow label="Controller name">
                <span className="font-mono text-[12px]">{resolver.controllerHost.name}</span>
                <span
                  className={cn(
                    'block text-[11px]',
                    resolver.controllerHost.error ? 'text-status-serious' : 'text-muted-foreground',
                  )}
                >
                  {resolver.controllerHost.error
                    ? `does not resolve on the router (${resolver.controllerHost.error})`
                    : `→ ${resolver.controllerHost.addresses.join(', ') || 'no address'}`}
                </span>
              </FactRow>
            ) : null}
          </div>
          {dnsmasqFronted ? (
            <p className="rounded-lg border bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
              {owner ?? 'Another resolver'} answers DNS on port 53 and dnsmasq sits behind it on port{' '}
              {resolver.dnsmasqPort}, still serving DHCP and the local names.
              {adguard ? ' Perch only observes AdGuard Home and never changes its settings.' : ''}
            </p>
          ) : null}
        </div>
      )}
    </Panel>
  )
}
