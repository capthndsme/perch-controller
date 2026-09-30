import { emitAlertEvent, reconcileConditions } from '#services/alerts/emit'
import type { AlertSubject } from '#services/alerts/model'
import { setWifiAlertSink, type WifiAlertEvent } from '#services/wifi_config/events'

/**
 * S9: the Wi-Fi plane's events into the alerts area (docs/design/wifi/
 * operations.md 7, catalogue `app/services/alerts/catalogue/wifi.ts`). The
 * plane emits through `emitWifiAlert`; this sink maps each event to an alert
 * event. Recoveries are clears: `wifi.health.recovered` clears the AP's radio
 * and BSS conditions, `wifi.ap.caught_up` its "behind" condition. Events
 * about a rollout or a network are the controller's (the payload names the
 * rollout or network).
 */

const CONDITIONS = new Set(['wifi.ap.behind', 'wifi.radio.down', 'wifi.bss.down'])

function subjectOf(event: WifiAlertEvent): AlertSubject {
  return event.source.kind === 'ap' ? { kind: 'ap', id: event.source.id } : { kind: 'controller' }
}

export function forwardWifiAlert(event: WifiAlertEvent): void {
  const apId = Number(event.payload.apId ?? (event.source.kind === 'ap' ? event.source.id : 0))
  if (event.name === 'wifi.health.recovered') {
    for (const type of ['wifi.radio.down', 'wifi.bss.down']) {
      void reconcileConditions([type], [], { scope: `${type}:${apId}:` })
    }
    return
  }
  if (event.name === 'wifi.ap.caught_up') {
    const ids = Array.isArray(event.payload.apIds) ? (event.payload.apIds as unknown[]) : []
    for (const id of ids.length > 0 ? ids : [apId]) {
      emitAlertEvent({
        type: 'wifi.ap.behind',
        phase: 'clear',
        subject: { kind: 'ap', id: Number(id) },
        dedupeKey: `wifi.ap.behind:${Number(id)}`,
        source: 'wifi_config',
      })
    }
    return
  }
  emitAlertEvent({
    type: event.name,
    ...(CONDITIONS.has(event.name) ? { phase: 'raise' as const } : {}),
    subject: subjectOf(event),
    dedupeKey: event.dedupeKey,
    severity: event.severity,
    payload: event.payload,
    source: 'wifi_config',
  })
}

/** Installs the forwarder (the cross-area wiring at boot; tests install it themselves). */
export function installWifiAlerts(): void {
  setWifiAlertSink(forwardWifiAlert)
}
