import type { WifiAccessPointStatus } from '#models/wifi_access_point'
import { mapSamplesByMetric, parsePrometheusText } from '#services/prometheus_text_parser'
import { DateTime } from 'luxon'

const DEFAULT_TIMEOUT_MS = 5000

export type ProbeWifiAccessPointOptions = {
  timeoutMs?: number
  fetcher?: typeof fetch
}

/**
 * Probes an OpenWrt Prometheus endpoint and extracts identity hints from
 * `node_openwrt_info` / `node_uname_info`.
 */
export async function probeWifiAccessPoint(
  metricsUrl: string,
  options: ProbeWifiAccessPointOptions = {}
): Promise<WifiAccessPointStatus> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetcher = options.fetcher ?? fetch
  const checkedAt = DateTime.utc().toISO()!
  const url = metricsUrl.trim()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const start = performance.now()

  try {
    const response = await fetcher(url, {
      headers: { Accept: 'text/plain' },
      signal: controller.signal,
    })
    const latencyMs = Math.round(performance.now() - start)
    if (!response.ok) {
      return {
        ok: false,
        checkedAt,
        latencyMs,
        error: `HTTP ${response.status} ${response.statusText}`.trim(),
      }
    }

    const body = await response.text()
    const samples = parsePrometheusText(body)
    const metrics = mapSamplesByMetric(samples)

    const openwrtInfo = metrics.get('node_openwrt_info')?.[0]
    const unameInfo = metrics.get('node_uname_info')?.[0]
    if (!openwrtInfo) {
      return {
        ok: false,
        checkedAt,
        latencyMs,
        metricFamilies: metrics.size,
        error: 'missing node_openwrt_info metric',
      }
    }

    return {
      ok: true,
      checkedAt,
      latencyMs,
      metricFamilies: metrics.size,
      model: openwrtInfo.labels.model,
      nodename: unameInfo?.labels.nodename,
      openwrtRelease: openwrtInfo.labels.release,
    }
  } catch (error) {
    const latencyMs = Math.round(performance.now() - start)
    const message =
      error instanceof Error
        ? error.name === 'AbortError'
          ? `timeout after ${timeoutMs}ms`
          : error.message
        : String(error)
    return { ok: false, checkedAt, latencyMs, error: message }
  } finally {
    clearTimeout(timer)
  }
}
