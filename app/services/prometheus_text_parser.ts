export type PrometheusSample = {
  name: string
  labels: Record<string, string>
  value: number
}

/**
 * Parsed Prometheus text exposition grouped by metric family name.
 */
export type PrometheusMetricMap = Map<string, PrometheusSample[]>

const SAMPLE_LINE_REGEX =
  /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{((?:[^"\\}]|"(?:\\.|[^"\\])*")*)\})?\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|NaN|[+-]?Inf)$/

/**
 * Parses one line of Prometheus labels (`k="v",x="y"`). The parser is
 * intentionally strict: malformed fragments are skipped instead of throwing.
 */
export function parsePrometheusLabels(raw: string): Record<string, string> {
  const labels: Record<string, string> = {}
  const source = raw.trim()
  if (!source) return labels

  const labelRegex = /([A-Za-z_][A-Za-z0-9_]*)="((?:\\.|[^"\\])*)"(?:,|$)/g
  let match: RegExpExecArray | null
  while ((match = labelRegex.exec(source))) {
    const key = match[1]
    const value = match[2].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    labels[key] = value
  }

  return labels
}

/**
 * Parses Prometheus text exposition into flat samples.
 *
 * Supports metric lines with optional labels and numeric values; ignores
 * comments (`# HELP`, `# TYPE`) and blank lines.
 */
export function parsePrometheusText(raw: string): PrometheusSample[] {
  const samples: PrometheusSample[] = []

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const match = SAMPLE_LINE_REGEX.exec(trimmed)
    if (!match) continue

    const name = match[1]
    const labels = parsePrometheusLabels(match[2] ?? '')
    const rawValue = match[3]
    let value: number
    if (rawValue === 'Inf' || rawValue === '+Inf') value = Number.POSITIVE_INFINITY
    else if (rawValue === '-Inf') value = Number.NEGATIVE_INFINITY
    else if (rawValue === 'NaN') value = Number.NaN
    else value = Number(rawValue)

    samples.push({ name, labels, value })
  }

  return samples
}

/**
 * Groups parsed samples by metric family for lookup by name.
 */
export function mapSamplesByMetric(samples: PrometheusSample[]): PrometheusMetricMap {
  const map: PrometheusMetricMap = new Map()
  for (const sample of samples) {
    const list = map.get(sample.name) ?? []
    list.push(sample)
    map.set(sample.name, list)
  }
  return map
}
