import type { QosOverview } from '@/types/api'

/**
 * A short, in-browser history of the live rates `GET /qos` reports (the
 * controller keeps only the latest report: docs/gateway/qos.md 7.2), so the
 * shaping page can draw the last few minutes. Appended by the overview query
 * each time a new report arrives; bounded per gateway and in gateways.
 */
export type QosLiveSample = {
  t: number
  /** WAN device → Mbit/s (download = the ingress ifb, upload = the device's egress) and peak delay. */
  wan: Record<string, { down: number | null; up: number | null; delayMs: number | null }>
  /** Policy id → its bucket's Mbit/s. */
  buckets: Record<number, { down: number | null; up: number | null }>
}

const MAX_SAMPLES = 180 // 15 minutes at the 5 s poll
const MAX_GATEWAYS = 8
const buffers = new Map<string, QosLiveSample[]>()

const mbit = (kbit: number | null | undefined) => (kbit === null || kbit === undefined ? null : kbit / 1000)

/** Record the overview's rates once per router report; returns the new (immutable) list. */
export function recordQosSample(gatewayKey: string, overview: QosOverview): QosLiveSample[] {
  const list = buffers.get(gatewayKey) ?? []
  const reportedAt = overview.report?.reportedAt ? Date.parse(overview.report.reportedAt) : NaN
  if (!Number.isFinite(reportedAt) || (list.length && list[list.length - 1].t >= reportedAt)) return list
  const sample: QosLiveSample = { t: reportedAt, wan: {}, buckets: {} }
  for (const q of overview.wan) {
    if (!q.live) continue
    const delays = [q.live.ingress?.peakDelayUs, q.live.egress?.peakDelayUs].filter((v): v is number => typeof v === 'number')
    sample.wan[q.device] = {
      down: mbit(q.live.ingress?.rateKbit),
      up: mbit(q.live.egress?.rateKbit),
      delayMs: delays.length ? Math.max(...delays) / 1000 : null,
    }
  }
  for (const p of overview.policies) {
    if (p.live && p.shared) sample.buckets[p.id] = { down: mbit(p.live.downloadKbit), up: mbit(p.live.uploadKbit) }
  }
  const next = [...list, sample].slice(-MAX_SAMPLES)
  buffers.delete(gatewayKey)
  buffers.set(gatewayKey, next)
  while (buffers.size > MAX_GATEWAYS) buffers.delete(buffers.keys().next().value!)
  return next
}

export function qosSamples(gatewayKey: string): QosLiveSample[] {
  return buffers.get(gatewayKey) ?? []
}
