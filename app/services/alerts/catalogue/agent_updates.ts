import { defineAlertTypes } from '#services/alerts/registry'
import { duration, listNames, pNum, pStr } from '#services/alerts/render'
import type { AlertTypeDef, RenderInput } from '#services/alerts/model'

/**
 * Alert types of the agent-updates area (docs/design/agent-updates/README.md
 * §16): one per event of `ALERT_EVENTS` in `app/services/agent_updates/events.ts`,
 * same names. All are notices (a moment in an update's life); the updates area
 * also writes each one to `agent_update_events`, its own record. Device events
 * have the device as subject (`ap` / `collector`), fleet events the controller.
 */

const UPDATES_PATH = '/settings/updates'

type Device = { kind?: unknown; id?: unknown; name?: unknown }

function productName(product: unknown): string {
  return product === 'perch-collector' || product === 'collector'
    ? 'Perch Network Collector'
    : 'Perch AP Daemon'
}

function deviceName(a: RenderInput): string {
  const device = (a.payload.device ?? null) as Device | null
  return typeof device?.name === 'string' && device.name ? device.name : a.label
}

function versions(a: RenderInput): string {
  const from = pStr(a.payload, 'fromVersion')
  const to = pStr(a.payload, 'toVersion')
  if (from && to) return `${from} → ${to}`
  return to || from
}

function rolloutPath(a: RenderInput): string {
  const id = pNum(a.payload, 'rolloutId')
  return id ? `${UPDATES_PATH}/rollouts/${id}` : UPDATES_PATH
}

type NoticeSpec = Pick<AlertTypeDef, 'type' | 'severity' | 'subjects' | 'label' | 'description'> & {
  defaults?: AlertTypeDef['defaults']
  render: AlertTypeDef['render']
}

function notice(spec: NoticeSpec): AlertTypeDef {
  return {
    category: 'updates',
    kind: 'notice',
    owner: 'agent-updates',
    ...spec,
  }
}

const DEVICE: AlertTypeDef['subjects'] = ['ap', 'collector']

export default defineAlertTypes([
  notice({
    type: 'agent_update.available',
    severity: 'info',
    subjects: ['controller'],
    label: 'Agent update available',
    description: 'A new signed release of an agent is ready for devices that run an older version.',
    render: (a) => {
      const devices = Array.isArray(a.payload.devices) ? (a.payload.devices as Device[]) : []
      const names = devices.map((d) => (typeof d.name === 'string' ? d.name : '')).filter(Boolean)
      const product = productName(a.payload.product)
      const version = pStr(a.payload, 'version')
      return {
        title: `${product} ${version} is available`,
        body: names.length
          ? `${names.length === 1 ? 'One device runs' : `${names.length} devices run`} an older version (${listNames(names, 3)}).`
          : 'Every device already runs it.',
        path: UPDATES_PATH,
      }
    },
  }),
  notice({
    type: 'agent_update.started',
    severity: 'info',
    subjects: DEVICE,
    label: 'Agent update started',
    description: 'A device started installing an update.',
    defaults: { notify: false },
    render: (a) => ({
      title: `Updating ${deviceName(a)}`,
      body: `${versions(a)}. It reconnects on its own when done.`,
      path: rolloutPath(a),
    }),
  }),
  notice({
    type: 'agent_update.confirmed',
    severity: 'info',
    subjects: DEVICE,
    label: 'Agent update confirmed',
    description: 'A device runs its new version and passed its health check.',
    render: (a) => {
      const seconds = pNum(a.payload, 'seconds')
      return {
        title: `${deviceName(a)} updated to ${pStr(a.payload, 'toVersion')}`,
        body: `${versions(a)}${seconds ? `, confirmed after ${duration(seconds)}` : ''}.`,
        path: rolloutPath(a),
      }
    },
  }),
  notice({
    type: 'agent_update.failed',
    severity: 'warning',
    subjects: DEVICE,
    label: 'Agent update failed',
    description: 'An update stopped before anything on the device changed.',
    render: (a) => ({
      title: `Update of ${deviceName(a)} failed`,
      body: `${pStr(a.payload, 'toVersion') ? `To ${pStr(a.payload, 'toVersion')}: ` : ''}${pStr(a.payload, 'detail') || pStr(a.payload, 'reason', 'no reason given')}. Nothing on the device changed.`,
      path: rolloutPath(a),
    }),
  }),
  notice({
    type: 'agent_update.rolled_back',
    severity: 'warning',
    subjects: DEVICE,
    label: 'Agent update rolled back',
    description: "A device's watchdog or boot guard restored the previous version.",
    render: (a) => ({
      title: `${deviceName(a)} rolled back to ${pStr(a.payload, 'fromVersion', 'its previous version')}`,
      body: `The update to ${pStr(a.payload, 'toVersion', 'the new version')} did not pass (${pStr(a.payload, 'detail') || pStr(a.payload, 'reason', 'no reason given')}). The previous version runs again.`,
      path: rolloutPath(a),
    }),
  }),
  notice({
    type: 'agent_update.unknown',
    severity: 'warning',
    subjects: DEVICE,
    label: 'Agent update outcome unknown',
    description: 'A device went silent during an update and did not come back in time.',
    render: (a) => ({
      title: `${deviceName(a)} did not come back from its update`,
      body: `No report since the update to ${pStr(a.payload, 'toVersion', 'the new version')} began. Its watchdog restores the previous version on its own; check the device if it stays silent.`,
      path: rolloutPath(a),
    }),
  }),
  notice({
    type: 'agent_update.rollback_failed',
    severity: 'critical',
    subjects: DEVICE,
    label: 'Agent rollback failed',
    description: 'A restored file did not match its copy: the device needs a hand.',
    render: (a) => ({
      title: `Rollback on ${deviceName(a)} failed`,
      body: `${pStr(a.payload, 'detail', 'A restored file does not match its copy')}. Reinstall the agent package on the device.`,
      path: rolloutPath(a),
    }),
  }),
  notice({
    type: 'agent_update.rollback_unavailable',
    severity: 'critical',
    subjects: DEVICE,
    label: 'Agent rollback copy lost',
    description: 'A device lost its in-memory rollback copy and could not fetch it again.',
    render: (a) => ({
      title: `${deviceName(a)} has no rollback copy`,
      body: `It runs ${pStr(a.payload, 'runningVersion', 'an unconfirmed version')} and could not fetch the previous one. Reinstall the agent package if it misbehaves.`,
      path: rolloutPath(a),
    }),
  }),
  notice({
    type: 'agent_update.rollout_paused',
    severity: 'warning',
    subjects: ['controller'],
    label: 'Agent rollout paused',
    description: 'A rollout stopped after a failure, or an admin paused it.',
    render: (a) => {
      const device = (a.payload.device ?? null) as Device | null
      const on = typeof device?.name === 'string' && device.name ? ` after ${device.name}` : ''
      return {
        title: `Rollout of ${productName(a.payload.product)} ${pStr(a.payload, 'version')} paused`,
        body: `Paused${on}: ${pStr(a.payload, 'reason', 'no reason given')}. The devices not yet updated keep their version.`,
        path: rolloutPath(a),
      }
    },
  }),
  notice({
    type: 'agent_update.rollout_completed',
    severity: 'info',
    subjects: ['controller'],
    label: 'Agent rollout completed',
    description: 'Every device of a rollout is done.',
    render: (a) => {
      const confirmed = pNum(a.payload, 'confirmed') ?? 0
      const skipped = pNum(a.payload, 'skipped') ?? 0
      return {
        title: `${productName(a.payload.product)} ${pStr(a.payload, 'version')} rolled out`,
        body: `${confirmed} ${confirmed === 1 ? 'device' : 'devices'} updated${skipped ? `, ${skipped} skipped` : ''}.`,
        path: rolloutPath(a),
      }
    },
  }),
  notice({
    type: 'agent_update.release_rejected',
    severity: 'critical',
    subjects: ['controller'],
    label: 'Agent release rejected',
    description: 'A release failed its signature or hash check and was not offered to any device.',
    render: (a) => ({
      title: `Rejected ${productName(a.payload.product)} ${pStr(a.payload, 'version')}`,
      body: `Its ${pStr(a.payload, 'source', 'manifest')} failed the check: ${pStr(a.payload, 'reason', 'no reason given')}. No device was offered it. A release that is not signed with your key never installs.`,
      path: UPDATES_PATH,
    }),
  }),
  notice({
    type: 'agent_update.version_changed',
    severity: 'info',
    subjects: DEVICE,
    label: 'Agent version changed by hand',
    description:
      'A device reports another version without an update from Perch (a manual install).',
    render: (a) => ({
      title: `${deviceName(a)} now runs ${pStr(a.payload, 'toVersion')}`,
      body: `It ran ${pStr(a.payload, 'fromVersion', 'another version')}; the change did not come from Perch.`,
      path: UPDATES_PATH,
    }),
  }),
])
