import { useState } from 'react'
import type { ReactNode } from 'react'
import { LinkBreak, Plugs, Trash, WarningCircle, Waves } from '@phosphor-icons/react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { AgentStatusBadge, TransportBadge } from '@/components/wifi/ap-agent-badges'
import { useForgetApAgent, usePingApAgent } from '@/hooks/use-ap-agents'
import { useDeleteWifiSource, useProbeWifiSource, useUpdateWifiSource } from '@/hooks/use-wifi'
import { ApiError } from '@/lib/api'
import { agentCapabilityLabel, apiErrorCode } from '@/lib/ap-agents'
import { formatLastSeen } from '@/lib/collectors'
import type { WifiSource, WifiSourceAgent } from '@/types/api'

function Fact({ label, mono, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={mono ? 'font-mono text-[11px] break-all' : 'text-xs'}>{children}</p>
    </div>
  )
}

function AgentFacts({ agent }: { agent: WifiSourceAgent }) {
  const board = [agent.boardName, agent.target].filter(Boolean).join(' · ')
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Fact label="Agent">
          {agent.version ? `v${agent.version}` : 'unknown version'}
          {agent.arch ? ` · ${agent.arch}` : ''}
        </Fact>
        <Fact label="Address" mono>
          {agent.lastAddress ?? '—'}
        </Fact>
        {agent.online ? (
          <Fact label="Connected">{formatLastSeen(agent.connectedAt)}</Fact>
        ) : (
          <Fact label="Disconnected">
            {agent.disconnectedAt ? formatLastSeen(agent.disconnectedAt) : 'never connected'}
          </Fact>
        )}
        <Fact label="Joined">{formatLastSeen(agent.joinedAt)}</Fact>
        <Fact label="Agent id" mono>
          {agent.idPrefix}…
        </Fact>
        {agent.kernel ? <Fact label="Kernel">{agent.kernel}</Fact> : null}
        {board ? (
          <div className="col-span-2 sm:col-span-3">
            <Fact label="Board" mono>
              {board}
            </Fact>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Can do</span>
        {agent.capabilities.length > 0 ? (
          agent.capabilities.map((capability) => (
            <Badge key={capability} variant="secondary">
              {agentCapabilityLabel(capability)}
            </Badge>
          ))
        ) : (
          <span className="text-[11px] text-muted-foreground">
            reported on the agent’s first connection
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * One registered WiFi source. Scrape rows (node_exporter over HTTP) show what
 * they always did; rows linked to a Perch AP Daemon show the agent
 * instead of the SSH settings, with Ping and Forget.
 */
export function WifiSourceCard({ source }: { source: WifiSource }) {
  const probe = useProbeWifiSource()
  const update = useUpdateWifiSource()
  const destroy = useDeleteWifiSource()
  const ping = usePingApAgent()
  const forget = useForgetApAgent()

  const [confirmForget, setConfirmForget] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const agent = source.transport === 'agent' ? source.agent : null
  const name = source.friendlyName ?? source.name

  function resetNotices() {
    setMessage(null)
    setError(null)
  }

  async function onPing() {
    resetNotices()
    try {
      const result = await ping.mutateAsync(source.id)
      setMessage(`Agent answered in ${Math.round(result.latencyMs)} ms.`)
    } catch (cause) {
      const code = apiErrorCode(cause)
      if (code === 'agent_offline') setError('Agent offline: it is not connected to this server.')
      else if (code === 'agent_timeout') setError('The agent did not answer in time.')
      else setError(cause instanceof ApiError ? cause.message : 'Ping failed.')
    }
  }

  async function onForget() {
    resetNotices()
    try {
      const updated = await forget.mutateAsync(source.id)
      setConfirmForget(false)
      setMessage(
        !updated.metricsUrl
          ? 'Agent forgotten. The source is disabled: it has no metrics URL.'
          : updated.enabled
            ? 'Agent forgotten. Metrics are scraped from the metrics URL again.'
            : 'Agent forgotten. The source stays disabled; enabling it scrapes the metrics URL.'
      )
    } catch (cause) {
      setConfirmForget(false)
      setError(cause instanceof ApiError ? cause.message : 'Could not forget the agent.')
    }
  }

  return (
    <Card className="rounded-lg py-3">
      <CardHeader className="px-3 pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm">{name}</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {agent ? (
              <AgentStatusBadge online={agent.online} />
            ) : (
              <Badge variant={source.lastStatus?.ok === false ? 'destructive' : 'outline'}>
                {source.lastStatus?.ok === false ? 'offline' : 'online'}
              </Badge>
            )}
            <Badge variant="outline">{source.pollIntervalSeconds}s</Badge>
            <TransportBadge transport={source.transport} />
          </div>
        </div>
        <CardDescription className={agent ? 'text-[11px]' : 'font-mono text-[11px]'}>
          {agent ? 'Metrics and commands via perch-apd' : (source.metricsUrl ?? 'No metrics URL')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          {source.model ? <Badge variant="outline">{source.model}</Badge> : null}
          {source.openwrtRelease ? <Badge variant="outline">{source.openwrtRelease}</Badge> : null}
          {source.nodename ? <Badge variant="outline">{source.nodename}</Badge> : null}
          <Badge variant="outline">{source.enabled ? 'Enabled' : 'Disabled'}</Badge>
          {agent ? null : (
            <Badge variant="outline">
              {source.enableTwoWayCommands ? 'Two-way on' : 'Two-way off'}
            </Badge>
          )}
        </div>

        {agent ? <AgentFacts agent={agent} /> : null}

        {agent && source.metricsUrl ? (
          <p className="text-[11px] text-muted-foreground">
            Metrics URL, used again if the agent is forgotten:{' '}
            <span className="font-mono break-all">{source.metricsUrl}</span>
          </p>
        ) : null}

        {source.lastStatus?.error ? (
          <p className="text-destructive">{source.lastStatus.error}</p>
        ) : null}
        {message ? <p className="text-primary">{message}</p> : null}
        {error ? <p className="text-destructive">{error}</p> : null}

        {confirmForget ? (
          <Alert className="rounded-lg border-destructive/20 bg-destructive/5">
            <WarningCircle className="size-4 text-destructive" />
            <AlertTitle>Forget the agent on {name}?</AlertTitle>
            <AlertDescription>
              <p>
                Its credentials are revoked and it disconnects; the history stays.{' '}
                {source.metricsUrl
                  ? `Metrics go back to being scraped from ${source.metricsUrl}.`
                  : 'There is no metrics URL to fall back to, so the source is disabled.'}{' '}
                To bring the AP back, run a join command with a new token on it.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="xs"
                  variant="destructive"
                  disabled={forget.isPending}
                  onClick={() => void onForget()}
                >
                  {forget.isPending ? 'Forgetting…' : 'Forget agent'}
                </Button>
                <Button type="button" size="xs" variant="outline" onClick={() => setConfirmForget(false)}>
                  Cancel
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
      <CardFooter className="flex-wrap justify-end gap-2 px-3">
        {agent ? (
          <>
            <Button variant="outline" size="sm" disabled={ping.isPending} onClick={() => void onPing()}>
              <Plugs className="size-3.5" />
              {ping.isPending ? 'Pinging…' : 'Ping'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={forget.isPending}
              onClick={() => {
                resetNotices()
                setConfirmForget(true)
              }}
            >
              <LinkBreak className="size-3.5" />
              Forget agent
            </Button>
          </>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          disabled={probe.isPending}
          onClick={() => probe.mutate(source.id)}
        >
          <Waves className="size-3.5" />
          Probe
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={update.isPending}
          onClick={() =>
            update.mutate({
              id: source.id,
              payload: { enabled: !source.enabled },
            })
          }
        >
          {source.enabled ? 'Disable' : 'Enable'}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={destroy.isPending}
          onClick={() => destroy.mutate(source.id)}
        >
          <Trash className="size-3.5" />
          Remove
        </Button>
      </CardFooter>
    </Card>
  )
}
