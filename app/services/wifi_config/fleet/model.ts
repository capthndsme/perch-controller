import type { Issue } from '#services/gateway_config/types'
import type {
  Advanced,
  ApCapabilities,
  ApMode,
  ApRadioCaps,
  CountryMode,
  Roaming,
  WifiBand,
  WifiNetworkApSpec,
  WifiNetworkSpec,
} from '#services/wifi_config/types'
import { createHash } from 'node:crypto'

/**
 * The fleet model (docs/design/wifi controller.md section 5.1): a network is
 * a template plus a scope plus per-AP overrides; radios are per-AP objects.
 * Pure helpers shared by render, reconcile, adoption and impact.
 */

/** An AP as the fleet layer sees it. */
export interface FleetAp {
  id: number
  name: string
  mode: ApMode
  /** `managed` mode: render writes onto it. */
  managed: boolean
  caps: ApCapabilities | null
  /** The AP's management network (`lan` bindings land there). */
  management: { network: string | null }
  /**
   * The country policy (decision D10) with the effective code: `fleet` →
   * Settings `countryDefault`, `fixed` → `ap_configs.country`, `router` →
   * never written. A null code writes nothing.
   */
  country: { mode: CountryMode; code: string | null }
}

/** A finding of the fleet layer: the core's `Issue` plus where it applies. */
export type FleetIssue = Issue & { networkId?: number; apId?: number; radio?: string }

export const DEFAULT_ADVANCED: Readonly<Advanced> = Object.freeze({
  pmf: 'default',
  multicastToUnicast: null,
  maxClients: null,
  dtimPeriod: null,
})

/** Roaming for a new network (decision D14: 802.11r off unless Settings say otherwise). */
export function defaultRoaming(fastRoaming = false): Roaming {
  return { ft: fastRoaming, mobilityDomain: null, rrm: false, btm: false }
}

/** The default mobility domain of a network: 4 hex of SHA-256("perch-md-v1:" + id) (12 → 0e68). */
export function mobilityDomainFor(networkId: number): string {
  return createHash('sha256').update(`perch-md-v1:${networkId}`).digest('hex').slice(0, 4)
}

/** The mobility domain a network renders with FT on. */
export function effectiveMobilityDomain(network: Pick<WifiNetworkSpec, 'id' | 'roaming'>): string {
  return network.roaming.mobilityDomain ?? mobilityDomainFor(network.id)
}

/** The section name of a slot Perch creates (distinct from the device groups' names). */
export function slotSectionName(networkId: number, radio: string): string {
  return `perch_n${networkId}_${radio.replace(/[^A-Za-z0-9_]/g, '_')}`.slice(0, 64)
}

/**
 * Does an AP carry a network (controller.md 5.2 step 1)? Scope `all`: unless
 * the membership excludes it; `selected`: only when the membership includes it.
 */
export function carries(
  network: Pick<WifiNetworkSpec, 'apScope'>,
  membership: Pick<WifiNetworkApSpec, 'included'> | null
): boolean {
  if (network.apScope === 'all') return membership?.included !== false
  return membership?.included === true
}

/** Radios with hardware behind them (stale sections never get slots). */
export function presentRadios(caps: ApCapabilities | null): ApRadioCaps[] {
  return (caps?.radios ?? []).filter((r) => r.present)
}

const BAND_ORDER: WifiBand[] = ['2g', '5g', '6g']

export function sortBands(bands: Iterable<string>): WifiBand[] {
  const set = new Set(bands)
  return BAND_ORDER.filter((b) => set.has(b))
}

/**
 * The radios a carried network lands on (controller.md 5.2 step 2): the
 * membership's `radios`, else every present radio whose band is in the
 * membership's `bands` or the network's.
 */
export function slotRadios(
  network: Pick<WifiNetworkSpec, 'id' | 'bands'>,
  membership: Pick<WifiNetworkApSpec, 'radios' | 'bands'> | null,
  caps: ApCapabilities | null,
  apId?: number
): { radios: ApRadioCaps[]; issues: FleetIssue[] } {
  const present = presentRadios(caps)
  const issues: FleetIssue[] = []
  if (membership?.radios && membership.radios.length > 0) {
    const radios: ApRadioCaps[] = []
    for (const name of membership.radios) {
      const radio = present.find((r) => r.section === name)
      if (radio) radios.push(radio)
      else {
        issues.push({
          severity: 'error',
          code: 'radio_unknown',
          message: `${name} is not a working radio of this access point`,
          networkId: network.id,
          ...(apId !== undefined ? { apId } : {}),
          radio: name,
        })
      }
    }
    return { radios, issues }
  }
  const bands = membership?.bands ?? network.bands
  return {
    radios: present.filter((r) => r.band !== null && bands.includes(r.band as WifiBand)),
    issues,
  }
}

/** Canonical JSON (sorted keys) for fingerprints and stable ids. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
