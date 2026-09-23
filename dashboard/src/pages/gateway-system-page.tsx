import { useState } from 'react'
import { ErrorLine, FactRow, IssueList } from '@/components/gateway-config/bits'
import {
  Field,
  ListEditor,
  NativePage,
  NativeWriteResult,
  RouterOwnedHint,
  StageOnly,
  SyncBadges,
  type NativeContext,
} from '@/components/gateway-native/native-ui'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Panel } from '@/components/ui/panel'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useUpdateSystem } from '@/hooks/use-gateway-native'
import { useGatewaySystem } from '@/hooks/use-gateway-observation'
import { nativeErrorMessage } from '@/lib/gateway-native'
import { refusalIssues } from '@/lib/networks'
import type { GatewaySystem } from '@/types/api'
import type { NativeWrite, SystemConfig, SystemPatch } from '@/types/gateway-native'

/**
 * The router's `system` section (docs/gateway/native-sync.md section 5):
 * host name, time zone and the NTP client and server, beside what the
 * router reports about itself (board, release, uptime).
 */
export function GatewaySystemPage() {
  return (
    <NativePage title="System" description="Host name, time zone and time servers">
      {(ctx) => <SystemView ctx={ctx} />}
    </NativePage>
  )
}

function formatUptime(seconds: number | null): string {
  if (seconds === null) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m} min` : `${m} min`
}

function SystemView({ ctx }: { ctx: NativeContext }) {
  const system = useGatewaySystem(ctx.gateway.id)
  const [result, setResult] = useState<NativeWrite<SystemConfig> | null>(null)
  if (system.isPending) return <p className="text-sm text-muted-foreground">Loading the system section…</p>
  if (system.error) return <ErrorLine message={nativeErrorMessage(system.error)} />
  const data = system.data
  const config = data.config ?? null
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      {config ? (
        <SystemForm
          key={JSON.stringify([config.hostname, config.zonename, config.timezone, config.ntp])}
          ctx={ctx}
          config={config}
          observed={data}
          result={result}
          onResult={setResult}
        />
      ) : (
        <EmptyState
          title="No system section yet"
          description="The config plane has not read the router's system config (managed or observe mode reads it)."
        />
      )}
      <Panel title="The router reports" description={data.observedAt ? undefined : 'Not reported yet.'}>
        <div className="divide-y divide-border/70">
          <FactRow label="Host name">
            <span className="font-mono">{data.hostname ?? '—'}</span>
          </FactRow>
          <FactRow label="Model">{data.model ?? data.boardName ?? '—'}</FactRow>
          <FactRow label="Target">
            <span className="font-mono">{data.board ?? '—'}</span>
          </FactRow>
          <FactRow label="Release">{data.release ?? '—'}</FactRow>
          <FactRow label="Kernel">
            <span className="font-mono">{data.kernel ?? '—'}</span>
          </FactRow>
          <FactRow label="Uptime">{formatUptime(data.uptimeSeconds)}</FactRow>
        </div>
      </Panel>
    </div>
  )
}

function SystemForm({
  ctx,
  config,
  observed,
  result,
  onResult,
}: {
  ctx: NativeContext
  config: SystemConfig
  observed: GatewaySystem
  result: NativeWrite<SystemConfig> | null
  onResult: (r: NativeWrite<SystemConfig>) => void
}) {
  const update = useUpdateSystem(ctx.gateway.id)
  const mainEditable = config.sync?.owner === 'perch' && !ctx.hardBlocked
  const ntpEditable = (config.ntp ? config.ntp.sync.owner === 'perch' : true) && !ctx.hardBlocked
  const [hostname, setHostname] = useState(config.hostname ?? '')
  const [zone, setZone] = useState(config.zonename ?? '')
  const [ntpEnabled, setNtpEnabled] = useState(config.ntp?.enabled ?? true)
  const [ntpServe, setNtpServe] = useState(config.ntp?.server ?? false)
  const [servers, setServers] = useState(config.ntp?.servers ?? [])
  const [stage, setStage] = useState(false)

  const patch: SystemPatch = {}
  if (hostname.trim() && hostname.trim() !== (config.hostname ?? '')) patch.hostname = hostname.trim()
  if (zone.trim() && zone.trim() !== (config.zonename ?? '')) patch.timezone = zone.trim()
  if (ntpEnabled !== (config.ntp?.enabled ?? true)) patch.ntpEnabled = ntpEnabled
  if (ntpServe !== (config.ntp?.server ?? false)) patch.ntpServe = ntpServe
  if (servers.join('\n') !== (config.ntp?.servers ?? []).join('\n')) patch.ntpServers = servers
  const dirty = Object.keys(patch).length > 0
  const zoneKnown = zone.trim() === '' || config.zoneNames.includes(zone.trim())
  const hostMismatch = observed.hostname && config.hostname && observed.hostname !== config.hostname

  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center gap-2">
          System <SyncBadges sync={config.sync} />
        </span>
      }
      description="Synced two-way: a change made in LuCI shows up here."
    >
      <div className="space-y-4">
        {config.sync?.owner === 'router' ? <RouterOwnedHint gatewayId={ctx.gateway.id} what="The system section" /> : null}
        <Field
          label="Host name"
          hint={
            hostMismatch
              ? `The router still runs as "${observed.hostname}": it takes the new name after the apply.`
              : 'Letters, digits and dashes. The gateway agent reports it under this name after its next connect.'
          }
        >
          <Input value={hostname} disabled={!mainEditable} onChange={(e) => setHostname(e.target.value)} className="font-mono" />
        </Field>
        <Field
          label="Time zone"
          hint={
            config.timezone
              ? `POSIX: ${config.timezone}${config.zonename ? '' : ' (no zone name set)'}`
              : 'The router runs on UTC until a zone is set.'
          }
        >
          <Input
            value={zone}
            list="gateway-zone-names"
            disabled={!mainEditable}
            placeholder="Europe/Berlin"
            onChange={(e) => setZone(e.target.value)}
            aria-invalid={!zoneKnown}
            className="font-mono"
          />
          <datalist id="gateway-zone-names">
            {config.zoneNames.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
          {!zoneKnown ? <p className="text-[11px] text-destructive">Pick a zone from the list.</p> : null}
        </Field>

        <div className="space-y-2 border-t border-border pt-3">
          <div className="flex items-center gap-2 text-xs font-medium">
            Time (NTP) {config.ntp ? <SyncBadges sync={config.ntp.sync} /> : null}
          </div>
          {config.ntp?.sync.owner === 'router' ? <RouterOwnedHint gatewayId={ctx.gateway.id} what="The NTP section" /> : null}
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs">Set the router's clock from time servers</span>
            <Switch checked={ntpEnabled} onCheckedChange={setNtpEnabled} disabled={!ntpEditable} aria-label="NTP client" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs">Serve time to the LAN</span>
            <Switch checked={ntpServe} onCheckedChange={setNtpServe} disabled={!ntpEditable} aria-label="NTP server" />
          </div>
          {ntpServe && !ntpEnabled ? (
            <p className="text-[11px] text-status-warning">Serving time with the client off hands out an unsynchronised clock.</p>
          ) : null}
          <Field label="Time servers">
            <ListEditor values={servers} onChange={setServers} disabled={!ntpEditable} placeholder="0.openwrt.pool.ntp.org" />
          </Field>
        </div>

        {update.error ? (
          <div className="space-y-2">
            <ErrorLine message={nativeErrorMessage(update.error)} />
            <IssueList issues={refusalIssues(update.error)} />
          </div>
        ) : null}
        {result ? <NativeWriteResult result={result} gatewayId={ctx.gateway.id} /> : null}
        {mainEditable || ntpEditable ? (
          <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
            <StageOnly checked={stage} onChange={setStage} />
            <Button
              size="sm"
              disabled={!dirty || !zoneKnown || update.isPending}
              onClick={() => update.mutate({ patch, apply: !stage }, { onSuccess: onResult })}
            >
              {update.isPending ? <Spinner className="size-3.5 text-current" /> : null}
              {stage ? 'Save draft' : 'Save and apply'}
            </Button>
          </div>
        ) : null}
      </div>
    </Panel>
  )
}
