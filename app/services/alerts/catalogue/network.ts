import { defineAlertTypes } from '#services/alerts/registry'
import {
  conditionRender,
  duration,
  hhmm,
  listNames,
  pNum,
  pStr,
  pTime,
  secondsBetween,
} from '#services/alerts/render'
import db from '@adonisjs/lucid/services/db'
import type { RenderContext, RenderInput } from '#services/alerts/model'

function portName(a: RenderInput): { port: string; node: string } {
  return { port: pStr(a.payload, 'port', a.label), node: pStr(a.payload, 'node', '') }
}

function portTitle(a: RenderInput, what: string): string {
  const { port, node } = portName(a)
  return node ? `Port ${port} on ${node} ${what}` : `Port ${a.label} ${what}`
}

function farEnd(payload: Record<string, unknown>): string {
  const v = payload.farEnd
  if (typeof v === 'string') return v
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>
    const node = typeof o.node === 'string' ? o.node : ''
    const port = typeof o.port === 'string' ? o.port : ''
    return [node, port].filter(Boolean).join(' ')
  }
  return ''
}

/** "Pixel-8" / MAC; under `redact` neither. */
function deviceName(a: RenderInput, ctx: RenderContext): string {
  if (ctx.redact) return 'A device'
  return pStr(a.payload, 'name', a.label)
}

function via(payload: Record<string, unknown>): string {
  if (payload.via === 'wifi') {
    const ap = pStr(payload, 'apName')
    const ssid = pStr(payload, 'ssid')
    return [ap, ssid].filter(Boolean).join(' / ') || 'Wi-Fi'
  }
  if (typeof payload.via === 'string' && payload.via !== '') {
    return payload.via === 'lan' ? 'the wired network' : payload.via
  }
  return 'the network'
}

/**
 * Ports and devices (events.md §3.4, §3.5). Detectors `ports.ts` and
 * `devices.ts`.
 */
export default defineAlertTypes([
  {
    type: 'port.down',
    category: 'network',
    kind: 'condition',
    severity: 'warning',
    subjects: ['port'],
    owner: 'alerts',
    label: 'Port down',
    description: 'An Ethernet port of a Perch agent lost its link.',
    defaults: { holdSeconds: 30, groupSeconds: 30 },
    params: [
      {
        key: 'scope',
        label: 'Ports watched',
        kind: 'enum',
        default: 'cabled',
        options: ['cabled', 'all'],
      },
    ],
    render: conditionRender({
      state: 'down',
      opened: (a, c) => {
        const since = pTime(a.payload, 'since') ?? a.raisedAt
        const end = farEnd(a.payload)
        return {
          title: portTitle(a, 'is down'),
          body: `Link lost at ${hhmm(since, c.zone)}.${end ? ` It connects to ${end}.` : ''}`,
        }
      },
      resolved: (a, c) => ({
        title: portTitle(a, 'is up again'),
        body: `Down for ${duration(secondsBetween(a.raisedAt, a.resolvedAt ?? c.now))}.`,
      }),
    }),
    renderGroup: (alerts) => ({
      title: `${alerts.length} ports are down`,
      body: listNames(alerts.map((a) => a.label)),
    }),
  },
  {
    type: 'port.flapping',
    category: 'network',
    kind: 'condition',
    severity: 'warning',
    subjects: ['port'],
    owner: 'alerts',
    label: 'Port flapping',
    description:
      'A port’s link goes up and down repeatedly: often a bad cable or a failing device.',
    defaults: { holdSeconds: 0, recoveryHoldSeconds: 0, flapThreshold: 0 },
    params: [
      { key: 'changes', label: 'Link changes', kind: 'int', default: 6, min: 2, max: 200 },
      {
        key: 'windowMinutes',
        label: 'Within',
        kind: 'int',
        default: 15,
        min: 1,
        max: 240,
        unit: 'min',
      },
      {
        key: 'scope',
        label: 'Ports watched',
        kind: 'enum',
        default: 'all',
        options: ['cabled', 'all'],
      },
    ],
    available: async () => {
      const row = await db
        .from('infra_ports')
        .where('origin', 'agent')
        .whereNotNull('carrier_changes')
        .select('id')
        .first()
      return row ? null : 'needs perch-apd ≥ 1.0.0 or a collector that reports ports'
    },
    render: conditionRender({
      state: 'flapping',
      opened: (a) => {
        const changes = pNum(a.payload, 'changes')
        const window = pNum(a.payload, 'windowMinutes')
        return {
          title: portTitle(a, 'is flapping'),
          body: `${changes ?? 'Many'} link changes${window ? ` in ${window} min` : ''}. Check the cable and the device on it.`,
        }
      },
      resolved: (a) => {
        const window = pNum(a.payload, 'windowMinutes')
        return {
          title: portTitle(a, 'is stable'),
          body: `No link change for ${window ?? 15} min.`,
        }
      },
    }),
  },
  {
    type: 'port.speed_degraded',
    category: 'network',
    kind: 'notice',
    severity: 'info',
    subjects: ['port'],
    owner: 'alerts',
    label: 'Port speed dropped',
    description: 'A cabled port links at a lower speed than it used to: often a cable fault.',
    defaults: { enabled: false, dedupeMinutes: 1440 },
    render: (a) => {
      const speed = pNum(a.payload, 'speedMbps')
      const before = pNum(a.payload, 'previousMbps')
      return {
        title: portTitle(a, `dropped to ${speed ?? '?'} Mb/s`),
        body: `It ran at ${before ?? '?'} Mb/s before. Often a cable fault.`,
      }
    },
  },
  {
    type: 'device.new',
    category: 'network',
    kind: 'notice',
    severity: 'info',
    subjects: ['device'],
    owner: 'alerts',
    label: 'New device',
    description: 'A device Perch has never seen before stayed on the network.',
    defaults: { groupSeconds: 300, dedupeMinutes: 0 },
    params: [
      {
        key: 'minPresenceMinutes',
        label: 'Seen for at least',
        kind: 'int',
        default: 10,
        min: 0,
        max: 1440,
        unit: 'min',
      },
      {
        key: 'ignoreRandomizedMacs',
        label: 'Ignore randomized MACs',
        kind: 'bool',
        default: false,
      },
      {
        key: 'excludePortalNetworks',
        label: 'Ignore guest portal networks',
        kind: 'bool',
        default: true,
      },
      {
        key: 'excludeNetworks',
        label: 'Ignore networks',
        kind: 'list',
        default: [],
        maxItems: 32,
        maxLength: 64,
      },
    ],
    pii: ['mac', 'name', 'ip'],
    render: (a, c) => {
      const first = pTime(a.payload, 'firstSeenAt') ?? a.raisedAt
      const network = pStr(a.payload, 'network')
      if (c.redact) {
        return {
          title: 'New device on the network',
          body: `${network ? `On ${network}, first` : 'First'} seen ${hhmm(first, c.zone)}.`,
        }
      }
      const name = pStr(a.payload, 'name', pStr(a.payload, 'mac', a.label))
      return {
        title: 'New device on the network',
        body: `${name}${network ? ` on ${network}` : ''} via ${via(a.payload)}, first seen ${hhmm(first, c.zone)}.`,
      }
    },
    renderGroup: (alerts, c) => ({
      title: `${alerts.length} new devices joined`,
      body: c.redact
        ? `First seen from ${hhmm(alerts[0].raisedAt, c.zone)}.`
        : listNames(alerts.map((a) => pStr(a.payload, 'name', pStr(a.payload, 'mac', a.label)))),
    }),
  },
  {
    type: 'device.offline',
    category: 'network',
    kind: 'condition',
    severity: 'warning',
    subjects: ['device'],
    owner: 'alerts',
    label: 'Watched device offline',
    description: 'A device you watch disconnected (set from the device page).',
    defaults: { groupSeconds: 30 },
    withheldBy: ['collector.offline', 'ap.offline', 'system.agents_unreachable'],
    pii: ['mac', 'name'],
    render: conditionRender({
      state: 'offline',
      opened: (a, c) => {
        const last = pTime(a.payload, 'lastSeenAt') ?? a.raisedAt
        return {
          title: `${deviceName(a, c)} is offline`,
          body: `Last seen ${hhmm(last, c.zone)} on ${via(a.payload)}.`,
        }
      },
      resolved: (a, c) => ({
        title: `${deviceName(a, c)} is back`,
        body: `Offline for ${duration(secondsBetween(a.raisedAt, a.resolvedAt ?? c.now))}.`,
      }),
    }),
    renderGroup: (alerts, c) => ({
      title: `${alerts.length} watched devices are offline`,
      body: c.redact ? '' : listNames(alerts.map((a) => pStr(a.payload, 'name', a.label))),
    }),
  },
  {
    type: 'device.arrived',
    category: 'network',
    kind: 'notice',
    severity: 'info',
    subjects: ['device'],
    owner: 'alerts',
    label: 'Watched device connected',
    description: 'A device you watch for arrivals connected.',
    defaults: { groupSeconds: 60, dedupeMinutes: 60 },
    pii: ['mac', 'name'],
    render: (a, c) => ({
      title: `${deviceName(a, c)} connected`,
      body: `At ${hhmm(a.raisedAt, c.zone)} via ${via(a.payload)}.`,
    }),
    renderGroup: (alerts, c) => ({
      title: `${alerts.length} watched devices connected`,
      body: c.redact ? '' : listNames(alerts.map((a) => pStr(a.payload, 'name', a.label))),
    }),
  },
])
