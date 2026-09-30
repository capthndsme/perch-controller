import type { AgentUpdateSettings } from '#services/agent_updates/settings'
import { parsePublicKey, type SignifyPublicKey } from '#services/agent_updates/signify'

/**
 * Release keys the controller trusts (agent-updates README section 6, D1).
 *
 * `RELEASE_KEYS` mirrors the keyring compiled into the kit
 * (`perch-agentkit/update/keys.go`): the owner's primary key and the cold
 * backup. It stays empty until the owner generates them; until then the only
 * trusted keys are the admin's `extraTrustedKeys` (the lab's test key), and
 * devices without a UCI `update_key` report `no_trusted_keys`.
 *
 * The controller's check decides what it offers and stores. The device checks
 * against its own pinned keys; a key added here never makes a device accept
 * anything.
 */
export const RELEASE_KEYS: ReadonlyArray<{ label: string; line: string }> = []

export type TrustedKey = SignifyPublicKey & { label: string; builtIn: boolean }

let builtIn: TrustedKey[] | null = null

function builtInKeys(): TrustedKey[] {
  if (builtIn) return builtIn
  builtIn = RELEASE_KEYS.map(({ label, line }) => ({
    ...parsePublicKey(line),
    label,
    builtIn: true,
  }))
  return builtIn
}

/** Parses one `extraTrustedKeys` entry; null when it is not a key. */
export function parseExtraKey(line: string): SignifyPublicKey | null {
  try {
    return parsePublicKey(line)
  } catch {
    return null
  }
}

/** Built-in keys plus the setting's extra keys (invalid entries are skipped). */
export function trustedKeys(settings: Pick<AgentUpdateSettings, 'extraTrustedKeys'>): TrustedKey[] {
  const keys = [...builtInKeys()]
  for (const line of settings.extraTrustedKeys) {
    const parsed = parseExtraKey(line)
    if (!parsed || keys.some((key) => key.keyId === parsed.keyId)) continue
    // signify-openbsd writes "<comment> public key" into a .pub file's comment.
    const label = parsed.comment?.replace(/ public key$/, '') || `Extra key ${parsed.keyId}`
    keys.push({ ...parsed, label, builtIn: false })
  }
  return keys
}

/** The label shown for a key id ("Perch release key 1"), or null when unknown. */
export function keyLabel(
  keyId: string,
  settings: Pick<AgentUpdateSettings, 'extraTrustedKeys'>
): string | null {
  return trustedKeys(settings).find((key) => key.keyId === keyId)?.label ?? null
}
