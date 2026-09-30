import { useId, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { DownloadSimple, Info } from '@phosphor-icons/react'
import { ErrorNote } from '@/components/firewall/firewall-ui'
import { ToneBadge } from '@/components/gateway-config/bits'
import { RouterOwnedHint, SyncBadges } from '@/components/gateway-native/native-ui'
import { UpnpAcl } from '@/components/gateway-sync/upnp-acl'
import { UpnpMappings } from '@/components/gateway-sync/upnp-mappings'
import { Button } from '@/components/ui/button'
import { Panel } from '@/components/ui/panel'
import { Switch } from '@/components/ui/switch'
import { useUpdateUpnpConfig, useUpnpConfig } from '@/hooks/use-gateway-sync'
import { isNotBuilt, syncRefusalMessage, unavailableText } from '@/lib/gateway-sync'
import type { FirewallWriteSummary, FwGateway } from '@/types/firewall'
import type { UpnpConfigPatch, UpnpConfigView } from '@/types/gateway-sync'

type SettingKey = 'enabled' | 'upnp' | 'natpmp' | 'secureMode'

const SETTINGS: Array<{ key: SettingKey; label: string; hint: string }> = [
  { key: 'enabled', label: 'UPnP service', hint: 'miniupnpd runs on the router and answers devices.' },
  { key: 'upnp', label: 'UPnP IGD', hint: 'Game consoles, most apps and media servers ask this way.' },
  { key: 'natpmp', label: 'NAT-PMP and PCP', hint: 'Apple devices and some torrent clients ask this way.' },
  {
    key: 'secureMode',
    label: 'Secure mode',
    hint: 'A device may open ports only to itself, never to another address. Perch turns it on with UPnP.',
  },
]

/**
 * UPnP on the firewall page (design gateway-sync dashboard.md 6, rest.md 8):
 * whether miniupnpd is installed, enabled and running, its switches, the
 * ports devices opened (delete them, block a device), and the ordered access
 * list. Everything but deleting a mapping is a config write with its own
 * apply; renders nothing on a controller that does not serve it yet.
 */
export function UpnpSection({
  gateway,
  canWrite,
  onWrite,
}: {
  gateway: FwGateway
  canWrite: boolean
  onWrite: (summary: FirewallWriteSummary) => void
}) {
  const upnp = useUpnpConfig(gateway.id)
  if (upnp.error && isNotBuilt(upnp.error)) return null
  const view = upnp.data

  return (
    <Panel
      title="UPnP and NAT-PMP"
      description="Lets devices open ports on the router by themselves (game consoles, video calls)."
      actions={view ? <StatusBadges view={view} /> : null}
      className="max-w-full"
    >
      {upnp.isPending ? (
        <p className="text-xs text-muted-foreground">Loading UPnP…</p>
      ) : !view ? (
        <p className="text-xs text-destructive">{syncRefusalMessage(upnp.error)}</p>
      ) : !view.installed ? (
        <NotInstalled gateway={gateway} />
      ) : (
        <UpnpBody gateway={gateway} view={view} canWrite={canWrite} onWrite={onWrite} />
      )}
    </Panel>
  )
}

function StatusBadges({ view }: { view: UpnpConfigView }) {
  if (!view.installed) return <ToneBadge tone="neutral">Not installed</ToneBadge>
  return (
    <span className="flex flex-wrap items-center gap-1" data-testid="upnp-status">
      <ToneBadge tone={view.settings?.enabled ? 'good' : 'neutral'} dot>
        {view.settings?.enabled ? 'Enabled' : 'Off'}
      </ToneBadge>
      {view.running !== null ? (
        <ToneBadge tone={view.running ? 'good' : view.settings?.enabled ? 'warning' : 'neutral'} dot>
          {view.running ? 'Running' : 'Stopped'}
        </ToneBadge>
      ) : null}
      {view.settings ? <SyncBadges sync={view.settings.sync} /> : null}
    </span>
  )
}

function NotInstalled({ gateway }: { gateway: FwGateway }) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-dashed border-border p-3 text-xs sm:flex-row sm:items-center sm:justify-between">
      <p className="text-muted-foreground">
        miniupnpd is not installed on {gateway.name}, so no device can open ports by itself. Port forwards you set up
        still work.
      </p>
      <Button asChild size="sm" variant="outline" className="shrink-0">
        <Link to={`/gateway/config/${gateway.id}`}>
          <DownloadSimple />
          Install on gateway
        </Link>
      </Button>
    </div>
  )
}

function UpnpBody({
  gateway,
  view,
  canWrite,
  onWrite,
}: {
  gateway: FwGateway
  view: UpnpConfigView
  canWrite: boolean
  onWrite: (summary: FirewallWriteSummary) => void
}) {
  const id = useId()
  const update = useUpdateUpnpConfig(gateway.id)
  const blocked = unavailableText(view.available ? null : view.unavailableReason, gateway.name)
  const settings = view.settings
  const routerOwned = settings ? settings.sync.owner !== 'perch' : false
  const writable = canWrite && view.available && !routerOwned
  // While a switch's write is in flight it shows where it is going.
  const pending = update.isPending ? update.variables.patch : null
  const valueOf = (key: SettingKey): boolean => {
    const wanted = pending?.[key]
    if (wanted !== undefined) return wanted
    const current = settings?.[key]
    return current ?? false
  }

  function toggle(key: SettingKey, next: boolean) {
    const patch: UpnpConfigPatch = { [key]: next }
    // Owner decision D10: UPnP comes on with secure mode.
    if (key === 'enabled' && next && !settings?.secureMode) patch.secureMode = true
    const label = SETTINGS.find((s) => s.key === key)!.label
    update.mutate(
      { patch },
      {
        onSuccess: (answer) =>
          onWrite({
            what: `${label} ${next ? 'on' : 'off'}${patch.secureMode && key === 'enabled' ? ', with secure mode' : ''}`,
            issues: answer.issues,
            apply: answer.apply,
            applyError: answer.applyError,
          }),
      },
    )
  }

  return (
    <div className="space-y-5">
      {blocked ? (
        <p className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" />
          {blocked}
        </p>
      ) : null}

      {settings ? (
        <section className="space-y-2" aria-label="UPnP settings">
          <ul className="divide-y divide-border/70">
            {SETTINGS.map(({ key, label, hint }) => (
              <SettingRow key={key} id={`${id}-${key}`} label={label} hint={hint}>
                <Switch
                  id={`${id}-${key}`}
                  checked={valueOf(key)}
                  disabled={!writable || update.isPending || (key !== 'enabled' && settings[key] === null)}
                  onCheckedChange={(next) => toggle(key, next)}
                  aria-label={label}
                />
              </SettingRow>
            ))}
          </ul>
          <p className="text-[11px] text-muted-foreground">
            Answers on{' '}
            <span className="font-mono text-foreground">{settings.internalInterfaces.join(', ') || '—'}</span>, opens
            ports on <span className="font-mono text-foreground">{settings.externalInterface ?? 'the WAN'}</span>.
          </p>
          {routerOwned ? <RouterOwnedHint gatewayId={gateway.id} what="The UPnP settings section" /> : null}
          <ErrorNote error={update.error} />
        </section>
      ) : null}

      <UpnpMappings gateway={gateway} view={view} canWrite={canWrite && view.available} onWrite={onWrite} />
      <UpnpAcl gateway={gateway} view={view} canWrite={writable} onWrite={onWrite} />
    </div>
  )
}

function SettingRow({ id, label, hint, children }: { id: string; label: string; hint: string; children: ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-4 py-2">
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
        <span className="block text-xs font-medium">{label}</span>
        <span className="block text-[11px] text-muted-foreground">{hint}</span>
      </label>
      {children}
    </li>
  )
}

