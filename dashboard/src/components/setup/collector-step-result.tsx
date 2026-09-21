import { ArrowRight, Broadcast, CheckCircle, WarningCircle } from '@phosphor-icons/react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import type { CollectorTransport } from '@/types/api'
import type { CollectorProbe } from '@/types/setup'

/** What the collector step shows after an adoption or an add by address. */
export type CollectorStepResult = {
  kind: 'adopted' | 'added'
  name: string
  /** `null` for a socket collector with nothing to poll. */
  baseUrl: string | null
  /** Absent for an add by address, which is always polled. */
  transport?: CollectorTransport
  /** Where a socket collector connects from. */
  address?: string | null
  pollIntervalSeconds: number
  probe: CollectorProbe
}

type CollectorStepResultCardProps = {
  result: CollectorStepResult
  /** Collectors still waiting for adoption. */
  waiting: number
  leaving: boolean
  onAdoptAnother: () => void
  onOpenDashboard: () => void
}

export function CollectorStepResultCard({
  result,
  waiting,
  leaving,
  onAdoptAnother,
  onOpenDashboard,
}: CollectorStepResultCardProps) {
  const { probe } = result
  const socket = result.transport === 'agent'

  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader className="border-b">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-lg">
              {result.kind === 'adopted' ? 'Collector adopted' : 'Collector added'}
            </CardTitle>
            <CardDescription>
              {result.name} is registered and setup is complete.
            </CardDescription>
          </div>
          <Badge variant={probe.ok ? 'secondary' : 'destructive'} className="rounded-md">
            {probe.ok ? 'Probe OK' : 'Probe failed'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-6">
        {probe.ok ? (
          <Alert className="rounded-lg border-primary/20 bg-primary/5">
            <CheckCircle className="size-4 text-primary" />
            <AlertTitle>Connected</AlertTitle>
            <AlertDescription>
              {probe.latencyMs != null ? `${Math.round(probe.latencyMs)} ms · ` : ''}
              {probe.totalDevices ?? 0} devices seen
              {probe.captureInterface ? ` on ${probe.captureInterface}` : ''}
            </AlertDescription>
          </Alert>
        ) : (
          <Alert variant="destructive" className="rounded-lg">
            <WarningCircle className="size-4" />
            <AlertTitle>Could not reach the collector</AlertTitle>
            <AlertDescription>
              {socket
                ? `${probe.error ?? 'Unknown error'}. It stays adopted and starts pushing as soon as it connects.`
                : `${probe.error ?? 'Unknown error'}. It stays registered; fix the address or the key later under Settings → Collectors.`}
            </AlertDescription>
          </Alert>
        )}
        <dl className="grid gap-2 rounded-lg border bg-muted/20 p-4 text-xs">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Name</dt>
            <dd>{result.name}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{socket ? 'Connected from' : 'Polled at'}</dt>
            <dd className="font-mono break-all">
              {socket ? (result.address ?? '—') : (result.baseUrl ?? '—')}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{socket ? 'Push interval' : 'Poll interval'}</dt>
            <dd>{result.pollIntervalSeconds}s</dd>
          </div>
        </dl>
      </CardContent>
      <CardFooter className="flex-wrap justify-end gap-2 border-t bg-muted/20">
        {waiting > 0 ? (
          <Button variant="outline" onClick={onAdoptAnother} disabled={leaving}>
            <Broadcast className="size-3.5" />
            Adopt another ({waiting} waiting)
          </Button>
        ) : null}
        <Button onClick={onOpenDashboard} disabled={leaving}>
          {leaving ? 'Opening…' : 'Open dashboard'}
          {!leaving ? <ArrowRight className="size-3.5" /> : null}
        </Button>
      </CardFooter>
    </Card>
  )
}
