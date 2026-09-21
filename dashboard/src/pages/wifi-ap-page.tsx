import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Crosshair, Power, Stop, WarningCircle } from '@phosphor-icons/react'
import { DashboardToolbar } from '@/components/dashboard/dashboard-toolbar'
import { TimePicker } from '@/components/dashboard/time-picker'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ApChannelBadges } from '@/components/wifi/ap-agent-badges'
import { useDashboardTime } from '@/hooks/use-dashboard-time'
import { useProfile } from '@/hooks/use-auth'
import { useLocateWifiAp, useRebootWifiAp, useWifiApHealth, useWifiAps } from '@/hooks/use-wifi'
import { controlDisabledReason, wifiCommandErrorMessage } from '@/lib/ap-agents'
import { type TimeWindow } from '@/lib/time-window'

const DEFAULT_WIFI_AP_WINDOW: TimeWindow = { kind: 'relative', range: '24h' }

/** How long "Locate" blinks an agent AP; the agent restores its LEDs afterwards. */
const AGENT_LOCATE_SECONDS = 30

export function WifiApPage() {
  const { id } = useParams()
  const apId = id ? Number(id) : undefined
  const {
    window,
    resolutionMode,
    refreshInterval,
    setWindow,
    setResolutionMode,
    setRefreshInterval,
  } = useDashboardTime(DEFAULT_WIFI_AP_WINDOW)
  const profile = useProfile()
  const reboot = useRebootWifiAp()
  const locate = useLocateWifiAp()
  const health = useWifiApHealth(apId, { window, refreshInterval })
  // Controls follow the agent's connection; the list refreshes every 15 s.
  const aps = useWifiAps({ includeDisabled: true })
  const ap = aps.data?.find((candidate) => candidate.id === apId)
  const controls = ap?.controls ?? null

  const [confirmReboot, setConfirmReboot] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [locateEndsAt, setLocateEndsAt] = useState<number | null>(null)
  const [now, setNow] = useState(0)

  // Bare setInterval: `window` in this component is the time window.
  useEffect(() => {
    if (locateEndsAt === null) return
    const tick = setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (current >= locateEndsAt) setLocateEndsAt(null)
    }, 1000)
    return () => clearInterval(tick)
  }, [locateEndsAt])

  const locateRemaining =
    locateEndsAt === null ? 0 : Math.max(0, Math.ceil((locateEndsAt - now) / 1000))
  const locating = locateRemaining > 0
  const stopping = locate.isPending && locate.variables?.stop === true

  const disabledReasons = controls
    ? [
        ...new Set(
          [controlDisabledReason(controls, 'locate'), controlDisabledReason(controls, 'reboot')].filter(
            (reason): reason is string => reason !== null
          )
        ),
      ]
    : aps.data && !ap
      ? ['This AP is not registered any more.']
      : []

  function resetNotices() {
    setMessage(null)
    setError(null)
  }

  async function onLocate() {
    if (!apId || !controls) return
    resetNotices()
    try {
      if (controls.via === 'agent') {
        const result = await locate.mutateAsync({ apId, durationSeconds: AGENT_LOCATE_SECONDS })
        const start = Date.now()
        setNow(start)
        setLocateEndsAt(start + (result.durationSeconds ?? AGENT_LOCATE_SECONDS) * 1000)
      } else {
        await locate.mutateAsync({ apId })
        setMessage('The AP blinked its LEDs.')
      }
    } catch (cause) {
      setError(wifiCommandErrorMessage(cause, 'Locate failed.'))
    }
  }

  async function onStopLocate() {
    if (!apId) return
    resetNotices()
    try {
      await locate.mutateAsync({ apId, stop: true })
      setLocateEndsAt(null)
      setMessage('Stopped. The LEDs are back to normal.')
    } catch (cause) {
      setError(wifiCommandErrorMessage(cause, 'Could not stop locating.'))
    }
  }

  async function onReboot() {
    if (!apId) return
    resetNotices()
    try {
      await reboot.mutateAsync(apId)
      setConfirmReboot(false)
      setLocateEndsAt(null)
      setMessage('Reboot sent. The AP drops its clients and is back in a minute or two.')
    } catch (cause) {
      setConfirmReboot(false)
      setError(wifiCommandErrorMessage(cause, 'Reboot failed.'))
    }
  }

  const title = health.data?.ap.friendlyName ?? health.data?.ap.name ?? ap?.friendlyName ?? ap?.name

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link to="/wifi">
            <ArrowLeft className="size-3.5" />
            WiFi
          </Link>
        </Button>
      </div>

      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">{title ?? `AP ${id}`}</h1>
        <p className="text-muted-foreground">System health history for this access point.</p>
        {ap ? (
          <div className="flex flex-wrap items-center gap-2">
            <ApChannelBadges transport={ap.transport} controls={ap.controls} />
          </div>
        ) : null}
        {profile.data?.role === 'admin' && apId ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {locating ? (
                <>
                  <Button size="sm" variant="outline" disabled>
                    <Crosshair className="size-3.5" />
                    Locating… {locateRemaining} s
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={stopping}
                    onClick={() => void onStopLocate()}
                  >
                    <Stop className="size-3.5" />
                    {stopping ? 'Stopping…' : 'Stop'}
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!controls?.locate || locate.isPending}
                  onClick={() => void onLocate()}
                >
                  <Crosshair className="size-3.5" />
                  {locate.isPending ? 'Locating…' : 'Locate AP'}
                </Button>
              )}
              <Button
                size="sm"
                variant="destructive"
                disabled={!controls?.reboot || reboot.isPending || confirmReboot}
                onClick={() => {
                  resetNotices()
                  setConfirmReboot(true)
                }}
              >
                <Power className="size-3.5" />
                {reboot.isPending ? 'Rebooting…' : 'Reboot AP'}
              </Button>
            </div>
            {disabledReasons.map((reason) => (
              <p key={reason} className="text-xs text-muted-foreground">
                {reason}
              </p>
            ))}
            {locating ? (
              <p className="text-xs text-muted-foreground">
                Every LED on the AP is blinking; they go back to normal when the timer runs out.
              </p>
            ) : null}
            {message ? <p className="text-xs text-primary">{message}</p> : null}
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            {confirmReboot ? (
              <Alert className="max-w-xl rounded-lg border-destructive/20 bg-destructive/5">
                <WarningCircle className="size-4 text-destructive" />
                <AlertTitle>Reboot {title ?? 'this AP'}?</AlertTitle>
                <AlertDescription>
                  <p>Its clients drop off and roam or wait until it is back, usually a minute or two.</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="xs"
                      variant="destructive"
                      disabled={reboot.isPending}
                      onClick={() => void onReboot()}
                    >
                      {reboot.isPending ? 'Rebooting…' : 'Reboot'}
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => setConfirmReboot(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        ) : null}
      </div>

      <DashboardToolbar>
        <TimePicker
          window={window}
          resolutionMode={resolutionMode}
          refreshInterval={refreshInterval}
          onWindowChange={setWindow}
          onResolutionModeChange={setResolutionMode}
          onRefreshIntervalChange={setRefreshInterval}
        />
      </DashboardToolbar>

      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">Health buckets</h2>
          <p className="text-xs text-muted-foreground">
            Load, memory, and conntrack samples grouped by the selected resolution.
          </p>
        </div>
        {health.isPending ? (
          <p className="text-sm text-muted-foreground">Loading AP health…</p>
        ) : health.error ? (
          <p className="text-sm text-destructive">{health.error.message}</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <div className="grid grid-cols-[1fr_0.6fr_0.8fr_0.8fr] gap-3 border-b bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <span>Bucket</span>
              <span className="text-right">Load1</span>
              <span className="text-right">Mem usage</span>
              <span className="text-right">Conntrack</span>
            </div>
            <div className="divide-y divide-border">
              {(health.data?.buckets ?? []).map((bucket) => {
                const memUsagePct =
                  bucket.memTotal && bucket.memAvailable !== null
                    ? Math.max(0, Math.min(1, 1 - bucket.memAvailable / bucket.memTotal))
                    : null
                const conntrackPct =
                  bucket.conntrackEntries !== null &&
                  bucket.conntrackLimit !== null &&
                  bucket.conntrackLimit > 0
                    ? (bucket.conntrackEntries / bucket.conntrackLimit) * 100
                    : null
                return (
                  <div
                    key={bucket.bucketStart}
                    className="grid grid-cols-[1fr_0.6fr_0.8fr_0.8fr] items-center gap-3 px-3 py-2 text-xs"
                  >
                    <span className="truncate text-muted-foreground">{bucket.bucketStart}</span>
                    <span className="text-right tabular-nums">
                      {bucket.load1 !== null ? bucket.load1.toFixed(2) : 'n/a'}
                    </span>
                    <span className="text-right tabular-nums">
                      {memUsagePct !== null ? `${Math.round(memUsagePct * 100)}%` : 'n/a'}
                    </span>
                    <span className="text-right tabular-nums">
                      {conntrackPct !== null ? `${conntrackPct.toFixed(1)}%` : 'n/a'}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
