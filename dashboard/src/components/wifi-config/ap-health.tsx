import { useState } from 'react'
import { ArrowClockwise, CheckCircle, Crosshair, WarningCircle } from '@phosphor-icons/react'
import { ErrorLine, ToneBadge } from '@/components/gateway-config/bits'
import { Button } from '@/components/ui/button'
import { Panel } from '@/components/ui/panel'
import { Spinner } from '@/components/ui/spinner'
import { useApHealth } from '@/hooks/use-wifi-config'
import { formatAgo, type Tone } from '@/lib/gateway-config'
import { HEALTH_PROBLEM_TEXT, wifiRefusalMessage } from '@/lib/wifi-config'
import type { ApConfig, WifiHealth } from '@/types/wifi-config'

const BSS_TONE: Record<string, Tone> = {
  ENABLED: 'good',
  DFS: 'warning',
  ACS: 'warning',
  HT_SCAN: 'warning',
  COUNTRY_UPDATE: 'warning',
  DISABLED: 'critical',
  UNINITIALIZED: 'critical',
}

function HealthBody({ health }: { health: WifiHealth }) {
  return (
    <div className="space-y-4">
      <p className="flex items-center gap-2 text-xs">
        {health.pending ? (
          <Spinner className="size-4" />
        ) : health.ok ? (
          <CheckCircle weight="fill" className="size-4 text-status-good" />
        ) : (
          <WarningCircle weight="fill" className="size-4 text-status-critical" />
        )}
        <span className="font-medium">
          {health.pending ? 'Settling' : health.ok ? 'Every expected network is on the air' : 'Something is not right'}
        </span>
        <span className="text-muted-foreground">· checked {formatAgo(health.checkedAt)}</span>
      </p>

      {health.problems.length > 0 ? (
        <ul className="space-y-1">
          {health.problems.map((p, i) => (
            <li key={`${p.code}-${i}`} className="flex items-start gap-2 text-xs">
              <ToneBadge tone={p.code === 'cac_running' || p.code === 'acs_running' ? 'warning' : 'critical'}>
                {HEALTH_PROBLEM_TEXT[p.code] ?? p.code}
              </ToneBadge>
              <span>
                {p.section ? <span className="mr-1 font-mono text-[11px] text-muted-foreground">{p.section}</span> : null}
                {p.message}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="space-y-1.5">
        <p className="section-label">Radios</p>
        <ul className="divide-y divide-border/70 rounded-md border border-border">
          {health.radios.map((r) => (
            <li key={r.section} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
              <span className="font-mono text-[11px] font-medium">{r.section}</span>
              <ToneBadge tone={r.up ? 'good' : r.retrySetupFailed ? 'critical' : 'neutral'} dot>
                {r.up ? 'Up' : r.retrySetupFailed ? 'Setup failed' : 'Down'}
              </ToneBadge>
              {r.channel ? <span className="text-muted-foreground">channel {r.channel}</span> : null}
              {r.dfs?.cacActive ? (
                <ToneBadge tone="warning">
                  <Crosshair aria-hidden weight="bold" className="size-3" />
                  Radar check {r.dfs.cacSecondsLeft} s left
                </ToneBadge>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-1.5">
        <p className="section-label">Networks on the air</p>
        <ul className="divide-y divide-border/70 rounded-md border border-border">
          {health.bss.map((b) => (
            <li key={b.section} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
              <span className="font-medium">{b.ssid}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{b.ifname ?? b.section}</span>
              <ToneBadge tone={BSS_TONE[b.status] ?? 'neutral'} dot className="ml-auto">
                {b.status}
              </ToneBadge>
              {!b.expected ? <ToneBadge tone="neutral">Not expected</ToneBadge> : null}
            </li>
          ))}
          {health.bss.length === 0 ? <li className="px-3 py-2 text-xs text-muted-foreground">No networks reported.</li> : null}
        </ul>
      </div>
    </div>
  )
}

/**
 * The AP's Wi-Fi as it runs (`wifi.health`, protocol.md 3.7): radios up or
 * not, radar checks, each network's hostapd state, problems. "Check now" asks
 * the agent instead of showing the stored result.
 */
export function ApHealthPanel({ ap }: { ap: ApConfig }) {
  const [fresh, setFresh] = useState(false)
  const stored = useApHealth(ap.apId, { fresh: false, enabled: !fresh })
  const live = useApHealth(ap.apId, { fresh: true, enabled: fresh })
  const query = fresh ? live : stored
  const health = query.data ?? (fresh ? stored.data : null) ?? ap.health

  return (
    <Panel
      title="Health"
      description="What the access point runs right now, checked after every change and when something goes down."
      actions={
        <Button
          size="sm"
          variant="outline"
          disabled={!ap.online || live.isFetching}
          onClick={() => (fresh ? void live.refetch() : setFresh(true))}
        >
          {live.isFetching ? <Spinner className="size-3.5" /> : <ArrowClockwise />}
          Check now
        </Button>
      }
    >
      {health ? (
        <HealthBody health={health} />
      ) : query.isPending ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : (
        <p className="text-xs text-muted-foreground">Not checked yet.</p>
      )}
      <ErrorLine message={query.error ? wifiRefusalMessage(query.error) : null} />
    </Panel>
  )
}
