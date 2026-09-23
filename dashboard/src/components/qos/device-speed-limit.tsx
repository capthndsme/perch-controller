import { Link } from 'react-router-dom'
import { QuotaBar, RateBar, StatePill } from '@/components/qos/qos-bits'
import { Panel } from '@/components/ui/panel'
import { useDeviceShaping } from '@/hooks/use-qos'
import { formatKbit, formatRatePair, SHAPING_STATE, viaLabel } from '@/lib/qos'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-[12.5px]">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  )
}

/**
 * The device page's "Speed limit" card (plan 3 WP-F): how a managed gateway
 * caps this device, live usage against the cap, and its quota. Hidden when no
 * gateway shapes it.
 */
export function DeviceSpeedLimitCard({ mac }: { mac: string }) {
  const shaping = useDeviceShaping(mac)
  const s = shaping.data
  if (shaping.isPending || shaping.error) return null
  // No gateway shapes it: nothing to say (most devices, and every device on a watch-only gateway).
  if (!s) return null
  const state = SHAPING_STATE[s.state]
  return (
    <Panel
      title="Speed limit"
      actions={
        <StatePill tone={state.tone} title={state.hint}>
          {state.label}
        </StatePill>
      }
    >
      <div className="divide-y divide-border/70">
        <Row label="Cap">{formatRatePair(s.cap)}</Row>
        {s.bucket ? <Row label="Shares">{`${s.bucket.name} · ${formatRatePair(s.bucket.rate)}`}</Row> : null}
        <Row label="From">
          {s.policy ? `${s.policy.name} · ` : ''}
          {viaLabel(s.via).toLowerCase()}
          {s.dynamic ? ' (dynamic)' : ''}
        </Row>
        <Row label="Counts">{s.includeLan ? 'internet and LAN' : 'internet only'}</Row>
        {s.usage ? (
          <div className="space-y-1 py-1.5 text-[12.5px]">
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">Now</span>
              <span className="font-mono tabular-nums">
                ↓ {formatKbit(s.usage.downloadKbit)} · ↑ {formatKbit(s.usage.uploadKbit)}
              </span>
            </div>
            <RateBar kbit={s.usage.downloadKbit} capKbit={s.cap.downloadKbit} />
          </div>
        ) : null}
        {s.quota ? (
          <div className="space-y-1 py-1.5 text-[12.5px]">
            <span className="text-muted-foreground">Quota</span>
            <QuotaBar quota={s.quota} />
            <p className="text-[11px] text-muted-foreground">
              then {s.quota.onExhausted === 'block' ? 'blocked' : `throttled to ${formatRatePair(s.quota.throttle)}`}
            </p>
          </div>
        ) : null}
        {s.schedules.length ? <Row label="Schedules">{s.schedules.length} can change it</Row> : null}
      </div>
      <Link to="/shaping?tab=devices" className="mt-2 inline-block text-xs text-brand underline-offset-2 hover:underline">
        Traffic shaping
      </Link>
    </Panel>
  )
}
