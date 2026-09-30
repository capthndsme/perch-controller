import { defineAlertTypes } from '#services/alerts/registry'
import {
  conditionRender,
  hhmm,
  listNames,
  plural,
  pNum,
  pStr,
  pTime,
} from '#services/alerts/render'

function sectionNames(payload: Record<string, unknown>): string[] {
  const examples = payload.examples
  if (!Array.isArray(examples)) return []
  return examples
    .map((e) => {
      if (typeof e !== 'object' || e === null) return ''
      const o = e as Record<string, unknown>
      return typeof o.config === 'string' && typeof o.section === 'string'
        ? `${o.config}.${o.section}`
        : ''
    })
    .filter((s) => s !== '')
}

function configSection(payload: Record<string, unknown>): string {
  const config = pStr(payload, 'config')
  const section = pStr(payload, 'section')
  return config && section ? `${config}.${section}` : config || section || 'A section'
}

/**
 * Gateway config plane (events.md §3.3). Notices from `scans.ts` over new
 * `gateway_config_events` rows; conditions from `gateway.ts` over state. The
 * gateway-sync area adds its domains' types in `gateway_sync.ts`.
 */
export default defineAlertTypes([
  {
    type: 'gateway.apply_rolled_back',
    category: 'gateway',
    kind: 'notice',
    severity: 'warning',
    subjects: ['gateway'],
    owner: 'alerts',
    label: 'Gateway change rolled back',
    description:
      'A config change was rolled back by the router (for example, not confirmed in time).',
    render: (a) => {
      const revision = pNum(a.payload, 'revision')
      const reason = pStr(a.payload, 'reason')
      const what = revision !== null ? `Revision ${revision}` : 'The change'
      const why =
        reason === 'confirm_timeout'
          ? `was not confirmed in time (${reason})`
          : `was rolled back${reason ? ` (${reason})` : ''}`
      return {
        title: 'Gateway change rolled back',
        body: `${what} ${why}; the router restored the previous config.`,
      }
    },
  },
  {
    type: 'gateway.apply_failed',
    category: 'gateway',
    kind: 'notice',
    severity: 'warning',
    subjects: ['gateway'],
    owner: 'alerts',
    label: 'Gateway change failed',
    description: 'A config change could not be applied on the router.',
    render: (a) => ({
      title: 'Gateway change failed',
      body: pStr(
        a.payload,
        'message',
        pStr(a.payload, 'error', 'The router did not apply the change.')
      ),
    }),
  },
  {
    type: 'gateway.apply_expired',
    category: 'gateway',
    kind: 'notice',
    severity: 'info',
    subjects: ['gateway'],
    owner: 'alerts',
    label: 'Queued gateway change expired',
    description:
      'A change queued while the gateway was offline expired before it could be applied.',
    render: (a) => {
      const hours = pNum(a.payload, 'queueExpiryHours')
      return {
        title: 'Queued gateway change expired',
        body: `The gateway was offline for longer than ${hours !== null ? `${hours} h` : 'the queue allows'}; the change was not applied.`,
      }
    },
  },
  {
    type: 'gateway.apply_awaiting_confirm',
    category: 'gateway',
    kind: 'condition',
    severity: 'warning',
    subjects: ['gateway'],
    owner: 'alerts',
    label: 'Gateway change waits for your confirmation',
    description: 'An applied change rolls back unless an admin keeps it.',
    defaults: {
      notify: false,
      holdSeconds: 30,
      recoveryHoldSeconds: 0,
      notifyRecovery: false,
      flapThreshold: 0,
    },
    render: conditionRender({
      state: 'waiting for confirmation',
      opened: (a, c) => {
        const deadline = pTime(a.payload, 'deadlineAt')
        return {
          title: 'Confirm the gateway change',
          body: deadline
            ? `It rolls back at ${hhmm(deadline, c.zone)} unless you keep it.`
            : 'It rolls back unless you keep it.',
        }
      },
      resolved: () => ({
        title: 'Gateway change no longer waits for you',
        body: 'It was kept or rolled back.',
      }),
    }),
  },
  {
    type: 'gateway.drift',
    category: 'gateway',
    kind: 'condition',
    severity: 'warning',
    subjects: ['gateway'],
    owner: 'alerts',
    label: 'Router config changed outside Perch',
    description: 'Sections of the router’s config differ from what Perch applied.',
    defaults: {
      holdSeconds: 0,
      recoveryHoldSeconds: 0,
      notifyRecovery: false,
      flapThreshold: 0,
      groupSeconds: 60,
    },
    render: conditionRender({
      state: 'drifted',
      opened: (a) => {
        const count = pNum(a.payload, 'sections') ?? 0
        const names = sectionNames(a.payload)
        const list = names.length ? ` (${listNames(names, 3)})` : ''
        return {
          title: 'Router config changed outside Perch',
          body: `${plural(count, 'section differs', 'sections differ')} on ${a.label}${list}. Review them in Gateway → Configuration.`,
        }
      },
      resolved: (a) => ({
        title: `Router config is in sync again on ${a.label}`,
        body: 'No section differs any more.',
      }),
    }),
  },
  {
    type: 'gateway.conflict',
    category: 'gateway',
    kind: 'condition',
    severity: 'warning',
    subjects: ['gateway'],
    owner: 'alerts',
    label: 'Config conflict',
    description: 'Sections were changed both on the router and in Perch.',
    defaults: {
      holdSeconds: 0,
      recoveryHoldSeconds: 0,
      notifyRecovery: false,
      flapThreshold: 0,
      groupSeconds: 60,
    },
    render: conditionRender({
      state: 'in conflict',
      opened: (a) => {
        const count = pNum(a.payload, 'sections') ?? 0
        return {
          title: `Config conflict on ${a.label}`,
          body: `${plural(count, 'section was', 'sections were')} changed on both sides; the router's values stay live until you resolve them.`,
        }
      },
      resolved: (a) => ({
        title: `Config conflict resolved on ${a.label}`,
        body: 'No section is in conflict any more.',
      }),
    }),
  },
  {
    type: 'gateway.enforcement_suspended',
    category: 'gateway',
    kind: 'condition',
    severity: 'warning',
    subjects: ['gateway'],
    owner: 'alerts',
    label: 'Authoritative Mode stopped enforcing',
    description: 'Repeated failed reverts suspended enforcement; router edits stay.',
    defaults: { holdSeconds: 0, recoveryHoldSeconds: 0, flapThreshold: 0 },
    render: conditionRender({
      state: 'suspended',
      opened: () => ({
        title: 'Authoritative Mode stopped enforcing',
        body: 'Two reverts failed within 60 min; router edits are no longer reverted until you resume enforcement.',
      }),
      resolved: (a) => ({
        title: 'Authoritative Mode is enforcing again',
        body: `Enforcement resumed on ${a.label}.`,
      }),
    }),
  },
  {
    type: 'gateway.sqm_paused',
    category: 'gateway',
    kind: 'condition',
    severity: 'warning',
    subjects: ['gateway'],
    owner: 'alerts',
    label: 'Traffic shaping paused on the router',
    description: 'SQM was switched off on the router itself; Perch never re-enables it.',
    defaults: { holdSeconds: 0, recoveryHoldSeconds: 0, flapThreshold: 0 },
    render: conditionRender({
      state: 'paused',
      opened: (a, c) => {
        const since = pTime(a.payload, 'since') ?? a.raisedAt
        return {
          title: 'Traffic shaping is paused on the router',
          body: `SQM on ${pStr(a.payload, 'interface', 'the WAN')} was switched off on the router at ${hhmm(since, c.zone)}. Perch never re-enables it by itself.`,
        }
      },
      resolved: (a) => ({
        title: 'Traffic shaping is on again',
        body: `SQM on ${pStr(a.payload, 'interface', 'the WAN')} is enabled on the router.`,
      }),
    }),
  },
  {
    type: 'gateway.pairing_lost',
    category: 'gateway',
    kind: 'notice',
    severity: 'warning',
    subjects: ['gateway'],
    owner: 'alerts',
    label: 'Gateway pairing lost',
    description: 'The pairing that allows config writes over plain HTTP is gone.',
    render: () => ({
      title: 'Gateway pairing lost',
      body: 'Config writes over plain HTTP are off until you pair again.',
    }),
  },
  {
    type: 'gateway.rejoin_offered',
    category: 'gateway',
    kind: 'notice',
    severity: 'warning',
    subjects: ['gateway'],
    owner: 'alerts',
    label: 'Gateway was reset or re-joined',
    description: 'Perch offers the last confirmed config to a gateway that came back empty.',
    defaults: { dedupeMinutes: 1440 },
    render: (a) => {
      const revision = pNum(a.payload, 'revision')
      return {
        title: 'Gateway was reset or re-joined',
        body: `Perch offers the last confirmed config${revision !== null ? ` (revision ${revision})` : ''}. Review it in Gateway → Configuration.`,
      }
    },
  },
  {
    type: 'gateway.unmodeled_changed',
    category: 'gateway',
    kind: 'notice',
    severity: 'info',
    subjects: ['gateway'],
    owner: 'alerts',
    label: 'Unmanaged router section changed',
    description: 'The router changed a section Perch mirrors but does not manage.',
    defaults: { enabled: false, groupSeconds: 60 },
    render: (a) => ({
      title: 'Router changed a section Perch does not manage',
      body: configSection(a.payload),
    }),
    renderGroup: (alerts) => ({
      title: `Router changed ${alerts.length} sections Perch does not manage`,
      body: listNames(alerts.map((a) => configSection(a.payload))),
    }),
  },
  {
    type: 'gateway.section_ambiguous',
    category: 'gateway',
    kind: 'notice',
    severity: 'info',
    subjects: ['gateway'],
    owner: 'alerts',
    label: 'Ambiguous router section',
    description:
      'Perch cannot tell which rule a router section belongs to and mirrors it read-only.',
    defaults: { groupSeconds: 60, dedupeMinutes: 1440 },
    render: (a) => ({
      title: 'Perch cannot tell which rule a section belongs to',
      body: `${configSection(a.payload)} is mirrored read-only.`,
    }),
    renderGroup: (alerts) => ({
      title: `Perch cannot tell which rule ${alerts.length} sections belong to`,
      body: `${listNames(alerts.map((a) => configSection(a.payload)))} are mirrored read-only.`,
    }),
  },
])
