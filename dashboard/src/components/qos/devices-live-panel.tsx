import { Link } from 'react-router-dom'
import type { KnownDevice } from '@/components/qos/groups-panel'
import { QuotaBar, RateBar, StatePill } from '@/components/qos/qos-bits'
import { EmptyState } from '@/components/ui/empty-state'
import { Panel } from '@/components/ui/panel'
import { formatKbit, formatRatePair, SHAPING_STATE, viaLabel } from '@/lib/qos'
import { macPath } from '@/lib/traffic'
import type { DeviceShaping } from '@/types/api'

type Props = {
  rows: DeviceShaping[]
  devices: KnownDevice[]
  loading: boolean
}

/**
 * Every MAC the gateway shapes (`GET /qos/devices`): how it is capped, whether
 * the router enforces it, and its live rate against the cap. Usage comes from
 * a device's own class only; devices sharing a bucket's rest leaf show none.
 */
export function DevicesLivePanel({ rows, devices, loading }: Props) {
  const names = new Map(devices.map((d) => [d.mac, d.name]))
  return (
    <Panel title="Shaped devices" description="Live, every 5 seconds. Rates are the device's own class on the router." flush>
      {loading ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="px-4 pb-4">
          <EmptyState title="No device is shaped" description="No assignment or network default reaches a device yet." />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table min-w-[760px]">
            <thead>
              <tr>
                <th>Device</th>
                <th>Rule</th>
                <th>Cap</th>
                <th>Download now</th>
                <th>Upload now</th>
                <th>Quota</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const state = SHAPING_STATE[s.state]
                return (
                  <tr key={`${s.gatewayId}-${s.mac}`}>
                    <td>
                      <Link to={`/devices/${macPath(s.mac)}`} className="font-medium hover:underline">
                        {names.get(s.mac) ?? s.mac}
                      </Link>
                      <p className="font-mono text-[11px] text-muted-foreground">
                        {names.has(s.mac) ? s.mac : null}
                        {s.network ? `${names.has(s.mac) ? ' · ' : ''}${s.network}` : ''}
                      </p>
                    </td>
                    <td>
                      <p>{s.policy?.name ?? 'own rate'}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {viaLabel(s.via)}
                        {s.dynamic ? ' · dynamic' : ''}
                        {s.includeLan ? ' · + LAN' : ''}
                        {s.schedules.length ? ` · ${s.schedules.length} schedule${s.schedules.length === 1 ? '' : 's'}` : ''}
                      </p>
                    </td>
                    <td className="whitespace-nowrap">
                      <p>{formatRatePair(s.cap)}</p>
                      {s.bucket ? <p className="text-[11px] text-muted-foreground">in {s.bucket.name} ({formatRatePair(s.bucket.rate)})</p> : null}
                    </td>
                    <UsageCell kbit={s.usage?.downloadKbit ?? null} cap={s.cap.downloadKbit} drop={s.usage?.dropPct.download ?? null} shared={s.usage === null && s.classId !== null} />
                    <UsageCell kbit={s.usage?.uploadKbit ?? null} cap={s.cap.uploadKbit} drop={s.usage?.dropPct.upload ?? null} shared={s.usage === null && s.classId !== null} />
                    <td>{s.quota ? <QuotaBar quota={s.quota} compact /> : <span className="text-muted-foreground">—</span>}</td>
                    <td>
                      <StatePill tone={state.tone} title={state.hint}>
                        {state.label}
                      </StatePill>
                      {s.routerState && s.routerState !== 'shaped' ? <p className="mt-0.5 text-[11px] text-muted-foreground">router: {s.routerState}</p> : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

function UsageCell({ kbit, cap, drop, shared }: { kbit: number | null; cap: number | null; drop: number | null; shared: boolean }) {
  return (
    <td className="w-32">
      {kbit === null ? (
        <span className="text-[11px] text-muted-foreground">{shared ? 'in the shared bucket' : '—'}</span>
      ) : (
        <div className="space-y-0.5">
          <p className="font-mono text-[12px] tabular-nums">{formatKbit(kbit)}</p>
          <RateBar kbit={kbit} capKbit={cap} />
          {drop !== null && drop > 0.5 ? <p className="text-[10px] text-muted-foreground">{drop.toFixed(1)} % dropped</p> : null}
        </div>
      )}
    </td>
  )
}
