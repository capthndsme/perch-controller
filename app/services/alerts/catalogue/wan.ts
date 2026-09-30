import { defineAlertTypes } from '#services/alerts/registry'
import {
  conditionRender,
  duration,
  forSpan,
  hhmm,
  listNames,
  pBool,
  pStr,
  pTime,
  secondsBetween,
  span,
} from '#services/alerts/render'

const REASONS: Record<string, string> = {
  link_down: 'link lost',
  route_lost: 'default route lost',
  netifd_error: 'interface error',
  mwan3_offline: 'mwan3 reports it offline',
}

function activeWan(payload: Record<string, unknown>): { network: string; device: string } | null {
  const v = payload.activeWan
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  return {
    network: typeof o.network === 'string' ? o.network : '',
    device: typeof o.device === 'string' ? o.device : '',
  }
}

function endpoint(v: unknown): string {
  if (typeof v !== 'object' || v === null) return '?'
  const o = v as Record<string, unknown>
  return typeof o.network === 'string' ? o.network : '?'
}

/**
 * WAN (events.md §3.2). Detector `wan.ts` over the gateway's `interfaces` and
 * `mwan3` observation parts; the gateway-sync area may add more `wan.*` types
 * in its own catalogue file.
 */
export default defineAlertTypes([
  {
    type: 'wan.down',
    category: 'wan',
    kind: 'condition',
    severity: 'warning',
    subjects: ['network'],
    owner: 'alerts',
    label: 'WAN down',
    description: 'A WAN link lost its link or its default route; critical when no WAN is left.',
    defaults: { holdSeconds: 30, groupSeconds: 30 },
    params: [
      {
        key: 'forgetHours',
        label: 'Forget a WAN absent for',
        kind: 'int',
        default: 24,
        min: 1,
        max: 720,
        unit: 'h',
      },
    ],
    render: conditionRender({
      state: 'down',
      opened: (a, c) => {
        const network = pStr(a.payload, 'network', a.subject.label ?? a.label)
        const since = pTime(a.payload, 'since') ?? a.raisedAt
        if (a.severity === 'critical' || pBool(a.payload, 'allDown')) {
          return {
            title: 'Internet is down',
            body: `All WAN links are down since ${hhmm(since, c.zone)}.`,
          }
        }
        const reason = REASONS[pStr(a.payload, 'reason')] ?? pStr(a.payload, 'reason', 'down')
        const active = activeWan(a.payload)
        const moved = active
          ? ` Traffic moved to "${active.network}"${active.device ? ` (${active.device})` : ''}.`
          : ''
        return {
          title: `WAN "${network}" is down`,
          body: `Down since ${hhmm(since, c.zone)} (${reason}).${moved}`,
        }
      },
      resolved: (a, c) => ({
        title: `WAN "${pStr(a.payload, 'network', a.label)}" is back`,
        body: forSpan(a, c, 'Down'),
      }),
      was: (a, c) => {
        const to = a.resolvedAt ?? c.now
        const all = a.severity === 'critical' || pBool(a.payload, 'allDown')
        return {
          title: all
            ? 'Internet was down'
            : `WAN "${pStr(a.payload, 'network', a.label)}" was down`,
          body: `${span(a.raisedAt, to, c.zone)} (${duration(secondsBetween(a.raisedAt, to))}).`,
        }
      },
    }),
    renderGroup: (alerts, c) => {
      if (alerts.some((a) => a.severity === 'critical')) {
        return {
          title: 'Internet is down',
          body: `All WAN links are down since ${hhmm(alerts[0].raisedAt, c.zone)}.`,
        }
      }
      return {
        title: `${alerts.length} WAN links are down`,
        body: `${listNames(alerts.map((a) => pStr(a.payload, 'network', a.label)))} (since ${hhmm(alerts[0].raisedAt, c.zone)}).`,
      }
    },
  },
  {
    type: 'wan.failover',
    category: 'wan',
    kind: 'condition',
    severity: 'info',
    subjects: ['gateway'],
    owner: 'alerts',
    label: 'WAN failover',
    description: 'Traffic left the preferred WAN for a backup link.',
    defaults: { holdSeconds: 30 },
    render: conditionRender({
      state: 'failed over',
      opened: (a, c) => ({
        title: `Failed over to "${endpoint(a.payload.to)}"`,
        body: `"${endpoint(a.payload.from)}" is unavailable since ${hhmm(a.raisedAt, c.zone)}.`,
      }),
      resolved: (a, c) => ({
        title: `Back on "${endpoint(a.payload.from)}"`,
        body: `Failover lasted ${duration(secondsBetween(a.raisedAt, a.resolvedAt ?? c.now))}.`,
      }),
    }),
  },
  {
    type: 'wan.public_ip_changed',
    category: 'wan',
    kind: 'notice',
    severity: 'info',
    subjects: ['network'],
    owner: 'alerts',
    label: 'WAN address changed',
    description: 'The public IPv4 address of a WAN changed.',
    defaults: { enabled: false },
    pii: ['from', 'to'],
    render: (a, c) => ({
      title: `WAN address changed on "${pStr(a.payload, 'network', a.label)}"`,
      body: c.redact
        ? 'The WAN has a new public address.'
        : `${pStr(a.payload, 'from', '?')} → ${pStr(a.payload, 'to', '?')}.`,
    }),
  },
])
