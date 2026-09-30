import { defineAlertTypes } from '#services/alerts/registry'
import {
  conditionRender,
  duration,
  forSpan,
  hhmm,
  listNames,
  pNum,
  pStr,
  pTime,
} from '#services/alerts/render'

/**
 * Agents (events.md §3.1): the collectors and access points Perch talks to.
 * Detectors: `agents.ts` (conditions), `scans.ts` (notices), `gateway.ts`
 * (`ap.groups_failed`).
 */
export default defineAlertTypes([
  {
    type: 'collector.offline',
    category: 'agents',
    kind: 'condition',
    severity: 'warning',
    subjects: ['collector'],
    owner: 'alerts',
    label: 'Collector offline',
    description: 'A collector stopped reporting for longer than its silence bound.',
    bootGrace: true,
    withheldBy: ['system.agents_unreachable'],
    render: conditionRender({
      state: 'offline',
      opened: (a, c) => {
        const name = pStr(a.payload, 'name', a.label)
        const since = pTime(a.payload, 'lastSeenAt') ?? a.raisedAt
        const silent = pNum(a.payload, 'silentSeconds')
        const gateway =
          a.payload.gatewayId !== null && a.payload.gatewayId !== undefined
            ? ' Gateway stats, host names and config sync pause until it is back.'
            : ''
        return {
          title: `Collector ${name} is offline`,
          body: `No data for ${duration(silent ?? c.now.diff(since, 'seconds').seconds)} (since ${hhmm(since, c.zone)}).${gateway}`,
        }
      },
      resolved: (a, c) => ({
        title: `Collector ${pStr(a.payload, 'name', a.label)} is back`,
        body: forSpan(a, c, 'Offline'),
      }),
    }),
  },
  {
    type: 'ap.offline',
    category: 'agents',
    kind: 'condition',
    severity: 'warning',
    subjects: ['ap'],
    owner: 'alerts',
    label: 'Access point offline',
    description: 'An access point stopped reporting for longer than its silence bound.',
    defaults: { groupSeconds: 30 },
    bootGrace: true,
    withheldBy: ['system.agents_unreachable'],
    render: conditionRender({
      state: 'offline',
      opened: (a, c) => {
        const name = pStr(a.payload, 'name', a.label)
        const since = pTime(a.payload, 'lastSeenAt') ?? a.raisedAt
        const silent = pNum(a.payload, 'silentSeconds')
        const clients = pNum(a.payload, 'clientsAtLastReport')
        const on =
          clients && clients > 0
            ? ` ${clients} ${clients === 1 ? 'client was' : 'clients were'} on it.`
            : ''
        return {
          title: `${name} is offline`,
          body: `No report for ${duration(silent ?? c.now.diff(since, 'seconds').seconds)} (since ${hhmm(since, c.zone)}).${on}`,
        }
      },
      resolved: (a, c) => ({
        title: `${pStr(a.payload, 'name', a.label)} is back online`,
        body: forSpan(a, c, 'Offline'),
      }),
    }),
    renderGroup: (alerts, c) => {
      const since = alerts.reduce(
        (min, a) => (a.raisedAt < min ? a.raisedAt : min),
        alerts[0].raisedAt
      )
      return {
        title: `${alerts.length} access points are offline`,
        body: `${listNames(alerts.map((a) => pStr(a.payload, 'name', a.label)))} (since ${hhmm(since, c.zone)}).`,
      }
    },
  },
  {
    type: 'system.agents_unreachable',
    category: 'agents',
    kind: 'condition',
    severity: 'warning',
    subjects: ['controller'],
    owner: 'alerts',
    label: 'Lost contact with most devices at once',
    description:
      'Most agents fell silent in the same moment: likely the controller’s own network, not the devices.',
    defaults: { holdSeconds: 0, flapThreshold: 0 },
    bootGrace: true,
    render: conditionRender({
      state: 'unreachable',
      opened: (a, c) => {
        const silent = pNum(a.payload, 'silent') ?? 0
        const monitored = pNum(a.payload, 'monitored') ?? silent
        return {
          title: `Perch lost contact with ${silent} of ${monitored} devices`,
          body: `All at ${hhmm(a.raisedAt, c.zone)}. Most likely the controller's own network or host, not the devices.`,
        }
      },
      resolved: (a, c) => ({
        title: 'Perch is in contact with its devices again',
        body: forSpan(a, c, 'Lost'),
      }),
      was: (a, c) => ({
        title: 'Perch lost contact with its devices',
        body: forSpan(a, c, 'Lost'),
      }),
    }),
  },
  {
    type: 'collector.pending',
    category: 'agents',
    kind: 'notice',
    severity: 'info',
    subjects: ['collector'],
    owner: 'alerts',
    label: 'Collector waiting for adoption',
    description: 'A new collector announced itself and waits for an admin to adopt it.',
    defaults: { dedupeMinutes: 1440 },
    pii: ['address'],
    render: (a) => {
      const host = pStr(a.payload, 'hostname', a.label)
      const version = pStr(a.payload, 'version')
      return {
        title: 'A collector is waiting for adoption',
        body: `${host}${version ? ` (${version})` : ''} announced itself. Adopt it in Settings → Collectors.`,
        path: '/settings/collectors',
      }
    },
  },
  {
    type: 'ap.joined',
    category: 'agents',
    kind: 'notice',
    severity: 'info',
    subjects: ['ap'],
    owner: 'alerts',
    label: 'Access point joined',
    description: 'A Perch AP Daemon joined with a join token.',
    render: (a) => {
      const version = pStr(a.payload, 'agentVersion')
      const model = pStr(a.payload, 'model')
      return {
        title: `${pStr(a.payload, 'name', a.label)} joined`,
        body: `Perch AP Daemon${version ? ` ${version}` : ''}${model ? ` on ${model}` : ''} is connected.`,
      }
    },
  },
  {
    type: 'ap.groups_failed',
    category: 'wifi',
    kind: 'condition',
    severity: 'warning',
    subjects: ['ap'],
    owner: 'alerts',
    label: 'Device groups not applied on an AP',
    description: 'An access point failed or rolled back its device-group Wi-Fi settings.',
    defaults: { holdSeconds: 0, recoveryHoldSeconds: 0, flapThreshold: 0 },
    render: conditionRender({
      state: 'failing',
      opened: (a) => {
        const state = pStr(a.payload, 'state', 'failed')
        const error = pStr(a.payload, 'error')
        return {
          title: `Device groups could not be applied on ${pStr(a.payload, 'name', a.label)}`,
          body: `${state}${error ? `: ${error}` : ''}. The AP kept its previous Wi-Fi settings.`,
        }
      },
      resolved: (a) => ({
        title: `Device groups applied on ${pStr(a.payload, 'name', a.label)}`,
        body: 'The access point confirmed its device-group settings.',
      }),
    }),
  },
])
