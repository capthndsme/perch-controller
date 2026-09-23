import type { DeviceAttachment, InfraPort } from '@/types/api'

/**
 * Where a device sits on the network map (docs/infrastructure-view.md A4), in
 * the words the device views use. Kept apart from `lib/infra.ts` on purpose:
 * the device list and the device page import this, and `lib/infra.ts` carries
 * dagre, which must stay in the Infrastructure page's own chunk.
 */

/** A port as people say it: "port 3" for numbered switch ports, else its label. */
export function portDisplayName(port: Pick<InfraPort, 'label'>): string {
  return /^\d+$/.test(port.label) ? `port ${port.label}` : port.label
}

/** 100 → "100 Mb/s", 1000 → "1 Gb/s", 2500 → "2.5 Gb/s"; null when unknown. */
export function formatLinkSpeed(mbps: number | null | undefined): string | null {
  if (mbps === null || mbps === undefined || !Number.isFinite(mbps) || mbps <= 0) return null
  if (mbps >= 1000) {
    const gbps = mbps / 1000
    return `${Number.isInteger(gbps) ? gbps : Number(gbps.toFixed(1))} Gb/s`
  }
  return `${Math.round(mbps)} Mb/s`
}

/**
 * The far end of a device's cable: "Garage AP · lan1 · 100 Mb/s". The speed
 * only while the far end is a live agent port that reports the link up. Null
 * when the device has no box on the map, or its box has no cable.
 */
export function uplinkLine(attachment: DeviceAttachment | null | undefined): string | null {
  const uplink = attachment?.uplink
  if (!uplink) return null
  const speed = uplink.live && uplink.up ? formatLinkSpeed(uplink.speedMbps) : null
  return [uplink.nodeName, portDisplayName({ label: uplink.portLabel }), speed].filter(Boolean).join(' · ')
}

/** The Infrastructure page with this box selected and centred. */
export function infraNodePath(nodeId: number): string {
  return `/infrastructure?node=${nodeId}`
}
