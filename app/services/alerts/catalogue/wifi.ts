import type { AlertTypeDef, RenderInput } from '#services/alerts/model'
import { defineAlertTypes } from '#services/alerts/registry'
import { conditionRender, duration, forSpan, pNum, pStr } from '#services/alerts/render'

/**
 * Alert types of the wifi area (docs/design/wifi/operations.md 7): the
 * Wi-Fi config plane's applies, rollouts, drift and the APs' health checks.
 * Names are the design's; `app/services/wifi_config/alerts.ts` (S9) turns the
 * plane's events into these. Radio, BSS and "behind" problems
 * are conditions (they clear when the AP recovers or catches up); the rest
 * are notices. Passphrase events are audit notices nobody is notified of by
 * default.
 */

/** The dashboard's Wi-Fi config pages (`/wifi/sync`, one AP at `/wifi/sync/:apId`). */
const WIFI_PATH = '/wifi/sync'

function apName(a: RenderInput): string {
  return pStr(a.payload, 'apName', a.label)
}

function apPath(a: RenderInput): string {
  const id = pNum(a.payload, 'apId')
  return id ? `${WIFI_PATH}/${id}` : WIFI_PATH
}

type Spec = Omit<AlertTypeDef, 'category' | 'owner'>

function wifi(spec: Spec): AlertTypeDef {
  return { category: 'wifi', owner: 'wifi', ...spec }
}

const REASONS: Record<string, string> = {
  confirm_timeout: 'the change was not confirmed in time',
  admin: 'an admin reverted it',
  reboot: 'the AP rebooted before confirming',
  commit_failed: 'the AP could not save it',
  reload_failed: 'the Wi-Fi reload failed',
  health_failed: 'its health check failed',
}

export default defineAlertTypes([
  wifi({
    type: 'wifi.apply.rolled_back',
    kind: 'notice',
    severity: 'warning',
    subjects: ['ap'],
    label: 'Wi-Fi change rolled back on an AP',
    description: 'An access point restored its previous Wi-Fi config after a change.',
    render: (a) => ({
      title: `${apName(a)} rolled back a Wi-Fi change`,
      body: `The previous config runs again: ${REASONS[pStr(a.payload, 'reason')] ?? pStr(a.payload, 'reason', 'no reason given')}.`,
      path: apPath(a),
    }),
  }),
  wifi({
    type: 'wifi.apply.failed',
    kind: 'notice',
    severity: 'warning',
    subjects: ['ap'],
    label: 'Wi-Fi change failed on an AP',
    description: 'An access point refused a Wi-Fi change, or restoring after one failed.',
    render: (a) => ({
      title: `Wi-Fi change failed on ${apName(a)}`,
      body: pStr(a.payload, 'message') || pStr(a.payload, 'error', 'The AP refused it.'),
      path: apPath(a),
    }),
  }),
  wifi({
    type: 'wifi.rollout.stopped',
    kind: 'notice',
    severity: 'warning',
    subjects: ['controller'],
    label: 'Wi-Fi rollout stopped',
    description:
      'A Wi-Fi change stopped at the first AP that failed; the APs after it keep their config.',
    render: (a) => {
      const done = Array.isArray(a.payload.completedApIds) ? a.payload.completedApIds.length : 0
      return {
        title: 'A Wi-Fi rollout stopped',
        body: `${done} ${done === 1 ? 'AP was' : 'APs were'} updated before it stopped (${pStr(a.payload, 'reason', 'an AP failed')}). Retry, skip or roll back from the rollout.`,
        path: WIFI_PATH,
      }
    },
  }),
  wifi({
    type: 'wifi.rollout.completed',
    kind: 'notice',
    severity: 'info',
    subjects: ['controller'],
    label: 'Wi-Fi rollout completed',
    description: 'A Wi-Fi change reached every access point.',
    defaults: { notify: false },
    render: (a) => {
      const done = Array.isArray(a.payload.apIds) ? a.payload.apIds.length : 0
      const skipped = Array.isArray(a.payload.skippedApIds) ? a.payload.skippedApIds.length : 0
      const seconds = pNum(a.payload, 'durationSeconds')
      return {
        title: 'Wi-Fi change rolled out',
        body: `${done} ${done === 1 ? 'AP' : 'APs'} updated${skipped ? `, ${skipped} skipped (offline; caught up when back)` : ''}${seconds ? ` in ${duration(seconds)}` : ''}.`,
        path: WIFI_PATH,
      }
    },
  }),
  wifi({
    type: 'wifi.ap.behind',
    kind: 'condition',
    severity: 'warning',
    subjects: ['ap'],
    label: 'Access point missed a Wi-Fi change',
    description:
      'An access point was offline during a Wi-Fi change; it catches up when it comes back.',
    defaults: { holdSeconds: 0 },
    render: conditionRender({
      state: 'behind',
      opened: (a) => ({
        title: `${apName(a)} missed a Wi-Fi change`,
        body: a.payload.passphraseChanged
          ? 'It was offline while a Wi-Fi password changed: its clients cannot join until it catches up.'
          : 'It was offline during the change and gets it as soon as it reconnects.',
        path: apPath(a),
      }),
      resolved: (a, c) => ({
        title: `${apName(a)} caught up`,
        body: forSpan(a, c, 'Behind'),
      }),
    }),
  }),
  wifi({
    type: 'wifi.divergence.opened',
    kind: 'notice',
    severity: 'info',
    subjects: ['ap'],
    label: 'Wi-Fi edited on an AP',
    description: 'Someone changed a Perch-managed Wi-Fi option on one AP (LuCI or uci).',
    render: (a) => ({
      title: `Wi-Fi edited on ${apName(a)}`,
      body: `${pStr(a.payload, 'option', 'An option')} differs from the other APs${pStr(a.payload, 'author') ? ` (by ${pStr(a.payload, 'author')})` : ''}. Keep it everywhere or put it back.`,
      path: apPath(a),
    }),
  }),
  wifi({
    type: 'wifi.drift.detected',
    kind: 'notice',
    severity: 'info',
    subjects: ['ap'],
    label: 'Wi-Fi drift on an AP',
    description: 'Authoritative Mode found a Wi-Fi edit on an AP and will put it back.',
    defaults: { notify: false },
    render: (a) => ({
      title: `Wi-Fi drift on ${apName(a)}`,
      body: 'A managed Wi-Fi option was changed on the AP; Perch puts it back.',
      path: apPath(a),
    }),
  }),
  wifi({
    type: 'wifi.drift.reverted',
    kind: 'notice',
    severity: 'info',
    subjects: ['ap'],
    label: 'Wi-Fi drift reverted',
    description: 'Authoritative Mode put a Wi-Fi edit on an AP back.',
    defaults: { notify: false },
    render: (a) => ({
      title: `Wi-Fi drift reverted on ${apName(a)}`,
      body: 'The AP runs Perch’s Wi-Fi config again.',
      path: apPath(a),
    }),
  }),
  wifi({
    type: 'wifi.enforcement.suspended',
    kind: 'notice',
    severity: 'warning',
    subjects: ['ap'],
    label: 'Wi-Fi enforcement paused on an AP',
    description: 'Putting Wi-Fi drift back failed repeatedly, so Perch stopped trying on that AP.',
    render: (a) => ({
      title: `Stopped enforcing Wi-Fi on ${apName(a)}`,
      body: `${pNum(a.payload, 'failures') ?? 'Several'} reverts failed within ${pNum(a.payload, 'windowMinutes') ?? 'a few'} minutes. Resume once the AP is fixed.`,
      path: apPath(a),
    }),
  }),
  wifi({
    type: 'wifi.radio.down',
    kind: 'condition',
    severity: 'warning',
    subjects: ['ap'],
    label: 'Radio down on an AP',
    description: 'A radio that should be up is down or failed to set up (outside an apply).',
    defaults: { holdSeconds: 60 },
    render: conditionRender({
      state: 'down',
      opened: (a) => ({
        title: `Radio ${pStr(a.payload, 'radio')} is down on ${apName(a)}`,
        body:
          pStr(a.payload, 'problem') === 'radio_setup_failed'
            ? 'It failed to set up (country, channel or driver).'
            : 'It reports no running Wi-Fi.',
        path: apPath(a),
      }),
      resolved: (a, c) => ({
        title: `Radio ${pStr(a.payload, 'radio')} is back on ${apName(a)}`,
        body: forSpan(a, c, 'Down'),
      }),
    }),
  }),
  wifi({
    type: 'wifi.bss.down',
    kind: 'condition',
    severity: 'warning',
    subjects: ['ap'],
    label: 'Wi-Fi network missing on an AP',
    description:
      'An expected Wi-Fi network (BSS) is not broadcasting on an AP for over a minute (outside DFS waits).',
    defaults: { holdSeconds: 60 },
    render: conditionRender({
      state: 'missing',
      opened: (a) => ({
        title: `A Wi-Fi network is missing on ${apName(a)}`,
        body: `${pStr(a.payload, 'ssid') || pStr(a.payload, 'section', 'A network')} is not broadcasting (${pStr(a.payload, 'status', 'down')}).`,
        path: apPath(a),
      }),
    }),
  }),
  wifi({
    type: 'wifi.passphrase.changed',
    kind: 'notice',
    severity: 'info',
    subjects: ['controller'],
    label: 'Wi-Fi password changed',
    description: 'An admin changed a Wi-Fi network’s password (audit).',
    defaults: { notify: false },
    render: (a) => ({
      title: 'A Wi-Fi password changed',
      body: `${pStr(a.payload, 'networkName', 'A network')}: the new password goes to every AP of it.`,
      path: '/wifi/networks',
    }),
  }),
  wifi({
    type: 'wifi.passphrase.revealed',
    kind: 'notice',
    severity: 'info',
    subjects: ['controller'],
    label: 'Wi-Fi password shown',
    description: 'An admin revealed a Wi-Fi network’s password (audit).',
    defaults: { notify: false },
    render: (a) => ({
      title: 'A Wi-Fi password was shown',
      body: `${pStr(a.payload, 'networkName', 'A network')}'s password was revealed in the dashboard.`,
      path: '/wifi/networks',
    }),
  }),
])
