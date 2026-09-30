import {
  ENCRYPTION_OF_SECURITY,
  encryptionFor,
  securityFeature,
  securityNeedsKey,
  securityOfEncryption,
} from '#services/wifi_config/domains/wifi_ifaces'
import type {
  ApCapabilities,
  OfferedSecurity,
  PmfMode,
  WifiSecurity,
} from '#services/wifi_config/types'
import { OFFERED_SECURITIES } from '#services/wifi_config/types'
import { createHash } from 'node:crypto'

/**
 * Security mapping of the fleet (docs/design/wifi controller.md section 5.1):
 * which UCI `encryption` a security renders to and is parsed from, what an
 * AP needs to carry it, passphrase rules. The UCI half lives with the
 * `wifi_ifaces` domain and is re-exported here.
 */
export {
  ENCRYPTION_OF_SECURITY,
  encryptionFor,
  securityFeature,
  securityNeedsKey,
  securityOfEncryption,
}

/** The table of controller.md 5.1, for the REST choices and the dashboard. */
export const SECURITY_TABLE: ReadonlyArray<{
  security: WifiSecurity
  render: string | null
  alsoParsed: string[]
  needs: 'owe' | 'sae' | null
  offered: boolean
}> = Object.freeze([
  { security: 'open', render: 'none', alsoParsed: ['(absent)'], needs: null, offered: true },
  { security: 'owe', render: 'owe', alsoParsed: [], needs: 'owe', offered: true },
  {
    security: 'wpa2',
    render: 'psk2',
    alsoParsed: ['psk2+ccmp', 'psk2+aes', 'psk2+tkip+ccmp'],
    needs: null,
    offered: true,
  },
  {
    security: 'wpa2_wpa3',
    render: 'sae-mixed',
    alsoParsed: ['sae-mixed+ccmp'],
    needs: 'sae',
    offered: true,
  },
  { security: 'wpa3', render: 'sae', alsoParsed: ['sae+ccmp'], needs: 'sae', offered: true },
  { security: 'wpa_wpa2', render: null, alsoParsed: ['psk-mixed*'], needs: null, offered: false },
])

export function isOfferedSecurity(value: unknown): value is OfferedSecurity {
  return (OFFERED_SECURITIES as readonly unknown[]).includes(value)
}

/**
 * Whether an AP can carry a security: true / false from its hostapd
 * features, null when the AP did not report them (older agent: not refused).
 */
export function supportsSecurity(
  caps: ApCapabilities | null,
  security: WifiSecurity
): boolean | null {
  const feature = securityFeature(security)
  if (feature === null) return true
  const features = caps?.hostapd?.features
  if (!features) return null
  return features[feature] === true
}

/** Whether the AP can do 802.11r (null when unknown). */
export function supportsFastRoaming(caps: ApCapabilities | null): boolean | null {
  const features = caps?.hostapd?.features
  return features ? features['11r'] === true : null
}

/**
 * A WPA passphrase: 8–63 printable ASCII characters, or 64 hex digits (a raw
 * PSK). Returns the refusal code or null.
 */
export function passphraseError(passphrase: unknown): 'passphrase_invalid' | null {
  if (typeof passphrase !== 'string') return 'passphrase_invalid'
  if (/^[0-9a-fA-F]{64}$/.test(passphrase)) return null
  if (passphrase.length < 8 || passphrase.length > 63) return 'passphrase_invalid'
  return /^[\x20-\x7e]+$/.test(passphrase) ? null : 'passphrase_invalid'
}

/** PMF against a security (controller.md 5.1): WPA3 cannot run without it. */
export function pmfError(security: WifiSecurity, pmf: PmfMode): 'pmf_required' | null {
  return security === 'wpa3' && pmf === 'disabled' ? 'pmf_required' : null
}

/** SHA-256 hex of a passphrase: what the device-group PSK guard compares (`wifi_secrets.digest`). */
export function passphraseDigest(passphrase: string): string {
  return createHash('sha256').update(passphrase, 'utf8').digest('hex')
}

/**
 * Which slots a candidate passphrase matches (controller.md 5.5): the
 * candidate's unbound fingerprint against each linked slot's router
 * fingerprint. A slot without a fingerprint (no key on the AP) never matches.
 */
export function passphraseMatches(
  candidateFingerprint: string,
  slots: Array<{ apId: number; radio: string; fingerprint: string | null }>
): { all: boolean; matches: Array<{ apId: number; radio: string; match: boolean }> } {
  const matches = slots.map((s) => ({
    apId: s.apId,
    radio: s.radio,
    match: s.fingerprint !== null && s.fingerprint === candidateFingerprint,
  }))
  return { all: matches.every((m) => m.match), matches }
}

/**
 * The key fingerprint each network's slots are expected to carry: the known
 * passphrase's, else the one most of its linked slots report (an adopted,
 * never-typed passphrase), else null (unknown: no key divergence is raised).
 */
export function expectedKeyFingerprints(
  networks: Array<{ id: number; passphraseRef: string | null; security: WifiSecurity }>,
  secrets: Record<string, { fingerprint: string }>,
  slots: Array<{ networkId: number; fingerprint: string | null }>
): Record<number, string | null> {
  const out: Record<number, string | null> = {}
  for (const network of networks) {
    if (!securityNeedsKey(network.security)) {
      out[network.id] = null
      continue
    }
    const known = network.passphraseRef ? secrets[network.passphraseRef]?.fingerprint : undefined
    if (known) {
      out[network.id] = known
      continue
    }
    const counts = new Map<string, number>()
    for (const s of slots) {
      if (s.networkId !== network.id || !s.fingerprint) continue
      counts.set(s.fingerprint, (counts.get(s.fingerprint) ?? 0) + 1)
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
    out[network.id] =
      ranked.length > 0 && (ranked.length === 1 || ranked[0][1] > ranked[1][1])
        ? ranked[0][0]
        : null
  }
  return out
}
