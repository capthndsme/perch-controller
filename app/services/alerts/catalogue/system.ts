import { defineAlertTypes } from '#services/alerts/registry'
import {
  conditionRender,
  duration,
  hhmm,
  pBool,
  pNum,
  pStr,
  pTime,
  span,
} from '#services/alerts/render'

function gb(bytes: number | null): string {
  if (bytes === null) return '?'
  return `${(bytes / 1e9).toFixed(1)} GB`
}

/**
 * Perch itself (events.md §3.8, §3.9): the controller's disk, database,
 * rollups and retention, its notifications, restarts, and test alerts.
 */
export default defineAlertTypes([
  {
    type: 'system.disk_low',
    category: 'system',
    kind: 'condition',
    severity: 'warning',
    subjects: ['controller'],
    owner: 'alerts',
    label: 'Disk space low',
    description:
      'The controller’s data disk is nearly full; critical below the critical threshold.',
    defaults: { holdSeconds: 0, recoveryHoldSeconds: 0, flapThreshold: 0 },
    params: [
      { key: 'path', label: 'Path', kind: 'list', default: ['/data'], maxItems: 1, maxLength: 255 },
      {
        key: 'warnPercentFree',
        label: 'Warn below',
        kind: 'int',
        default: 10,
        min: 1,
        max: 50,
        unit: '% free',
      },
      {
        key: 'criticalPercentFree',
        label: 'Critical below',
        kind: 'int',
        default: 3,
        min: 1,
        max: 20,
        unit: '% free',
      },
    ],
    render: conditionRender({
      state: 'low on disk space',
      opened: (a) => {
        const pct = pNum(a.payload, 'freePercent')
        return {
          title: 'Disk space is low',
          body: `${gb(pNum(a.payload, 'freeBytes'))} free${pct !== null ? ` (${Math.round(pct)} %)` : ''} on the controller's data disk.`,
        }
      },
      resolved: (a) => ({
        title: 'Disk space is fine again',
        body: `${gb(pNum(a.payload, 'freeBytes'))} free on the controller's data disk.`,
      }),
    }),
  },
  {
    type: 'system.db_size',
    category: 'system',
    kind: 'condition',
    severity: 'warning',
    subjects: ['controller'],
    owner: 'alerts',
    label: 'Database size',
    description: 'The database grew past the size you set (off while the size is 0).',
    defaults: { holdSeconds: 0, recoveryHoldSeconds: 0, flapThreshold: 0 },
    params: [
      {
        key: 'warnGb',
        label: 'Warn above',
        kind: 'int',
        default: 0,
        min: 0,
        max: 10000,
        unit: 'GB',
      },
    ],
    render: conditionRender({
      state: 'too large',
      opened: (a) => ({
        title: `Database is larger than ${pNum(a.payload, 'warnGb') ?? '?'} GB`,
        body: `${gb(pNum(a.payload, 'sizeBytes'))}. Retention: native 30 d, 5-minute and hourly 730 d.`,
      }),
      resolved: (a) => ({
        title: 'Database size is below the limit again',
        body: `${gb(pNum(a.payload, 'sizeBytes'))}.`,
      }),
    }),
  },
  {
    type: 'system.rollup_stalled',
    category: 'system',
    kind: 'condition',
    severity: 'warning',
    subjects: ['controller'],
    owner: 'alerts',
    label: 'Rollups behind',
    description: 'Traffic arrives but the 5-minute rollups stopped: long charts go incomplete.',
    defaults: { holdSeconds: 0, recoveryHoldSeconds: 0, flapThreshold: 0 },
    params: [
      {
        key: 'lagMinutes',
        label: 'Behind by more than',
        kind: 'int',
        default: 30,
        min: 10,
        max: 1440,
        unit: 'min',
      },
    ],
    render: conditionRender({
      state: 'behind',
      opened: (a) => ({
        title: 'Rollups are behind',
        body: `The newest 5-minute rollup is ${duration((pNum(a.payload, 'ageMinutes') ?? 0) * 60)} old. Long charts will be incomplete.`,
      }),
      resolved: () => ({
        title: 'Rollups caught up',
        body: 'The 5-minute rollups are current again.',
      }),
    }),
  },
  {
    type: 'system.retention_stalled',
    category: 'system',
    kind: 'condition',
    severity: 'warning',
    subjects: ['controller'],
    owner: 'alerts',
    label: 'Old data not pruned',
    description:
      'The oldest traffic data is older than its retention: the nightly prune is not running.',
    defaults: { holdSeconds: 0, recoveryHoldSeconds: 0, flapThreshold: 0 },
    params: [
      { key: 'graceDays', label: 'Grace', kind: 'int', default: 2, min: 1, max: 30, unit: 'd' },
    ],
    render: conditionRender({
      state: 'behind',
      opened: (a) => ({
        title: 'Old data is not being pruned',
        body: `The oldest 5-second bucket is ${pNum(a.payload, 'oldestDays') ?? '?'} days old (retention ${pNum(a.payload, 'retentionDays') ?? '?'} d). Check the 03:30 prune task in the logs.`,
      }),
      resolved: () => ({
        title: 'Old data is pruned again',
        body: 'Retention is back on schedule.',
      }),
    }),
  },
  {
    type: 'system.delivery_failing',
    category: 'system',
    kind: 'condition',
    severity: 'warning',
    subjects: ['controller'],
    owner: 'alerts',
    label: 'Notifications failing',
    description: 'A push device or webhook failed several deliveries in a row.',
    defaults: { holdSeconds: 0, recoveryHoldSeconds: 0, flapThreshold: 0 },
    render: conditionRender({
      state: 'failing',
      opened: (a) => {
        const failures = pNum(a.payload, 'failures')
        const error = pStr(a.payload, 'lastError', 'unknown')
        return {
          title: `Notifications to ${pStr(a.payload, 'name', 'a destination')} are failing`,
          body: `Last error: ${error}${failures !== null ? ` (${failures} in a row)` : ''}. Check it in Settings → Notifications.`,
          path: '/settings/notifications',
        }
      },
      resolved: (a) => ({
        title: `Notifications to ${pStr(a.payload, 'name', 'a destination')} work again`,
        body: 'The last delivery succeeded.',
        path: '/settings/notifications',
      }),
    }),
  },
  {
    type: 'system.db_unreachable',
    category: 'system',
    kind: 'condition',
    severity: 'critical',
    subjects: ['controller'],
    owner: 'alerts',
    label: 'Database unreachable',
    description: 'The controller cannot reach its database (sent out of band).',
    defaults: { holdSeconds: 45, recoveryHoldSeconds: 0, flapThreshold: 0 },
    render: conditionRender({
      state: 'unreachable',
      opened: (a, c) => ({
        title: 'Perch cannot reach its database',
        body: `Since ${hhmm(pTime(a.payload, 'since') ?? a.raisedAt, c.zone)}. Charts and alerts are paused until it is back.`,
      }),
      resolved: (a, c) => ({
        title: 'Database is back',
        body: `It was unreachable ${span(a.raisedAt, a.resolvedAt ?? c.now, c.zone)}.`,
      }),
    }),
  },
  {
    type: 'controller.started',
    category: 'system',
    kind: 'notice',
    severity: 'info',
    subjects: ['controller'],
    owner: 'alerts',
    label: 'Perch restarted',
    description: 'The controller started; a warning when it stopped unexpectedly or was down long.',
    params: [
      {
        key: 'downWarnMinutes',
        label: 'Warn when down for',
        kind: 'int',
        default: 10,
        min: 1,
        max: 1440,
        unit: 'min',
      },
    ],
    render: (a, c) => {
      const version = pStr(a.payload, 'version')
      const previous = pStr(a.payload, 'previousVersion')
      const down = pNum(a.payload, 'downSeconds')
      if (!pBool(a.payload, 'clean')) {
        const last = pTime(a.payload, 'lastHeartbeatAt')
        return {
          title: 'Perch restarted after an unexpected stop',
          body: `It was down about ${duration(down ?? 0)}${last ? ` (last heartbeat ${hhmm(last, c.zone)})` : ''}.`,
        }
      }
      const was = previous && previous !== version ? ` (was ${previous})` : ''
      return {
        title: 'Perch restarted',
        body: `${version ? `Version ${version}${was}. ` : ''}Down for ${duration(down ?? 0)}.`,
      }
    },
  },
  {
    type: 'system.test',
    category: 'system',
    kind: 'notice',
    severity: 'info',
    subjects: ['controller'],
    owner: 'alerts',
    label: 'Test alert',
    description:
      'A test alert through the whole routing (Settings → Alerts, node ace alerts:emit).',
    defaults: { dedupeMinutes: 0 },
    render: (a, c) => ({
      title: pStr(a.payload, 'title', `Test alert (${a.severity})`),
      body: `Sent from ${pStr(a.payload, 'from', 'Settings → Alerts')} at ${hhmm(a.raisedAt, c.zone)}.`,
      path: '/settings/alerts',
    }),
  },
])
