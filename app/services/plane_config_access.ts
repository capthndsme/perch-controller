import type Gateway from '#models/gateway'

/**
 * Whether a gateway's router lets the config plane write a config
 * (docs/gateway/qos.md section 6.3; README 7.7, decision 7): the router
 * refuses configs outside its effective allowlist (`config_not_allowed`),
 * which is `managed_config` plus the configs of installed sibling packages
 * (`sqm-scripts` → `sqm`, `perch-qos` → `perch-qos`), minus what the router
 * opted out. The QoS writers refuse early with the same words, and
 * `GET /qos` shows it (`planeAccess`).
 */

/** What a config's package is called, for messages. */
const PACKAGE_OF: Record<string, string> = {
  'sqm': 'sqm-scripts',
  'perch-qos': 'perch-qos',
}

/**
 * Whether the router lets the plane write a config (`capabilities.
 * allowedConfigs`, README 7.7: installed sibling packages join it by
 * themselves). null = the router did not say (an older collector).
 */
export function configAllowed(gateway: Gateway, config: string): boolean | null {
  const allowed = gateway.capabilities?.allowedConfigs
  return Array.isArray(allowed) ? allowed.includes(config) : null
}

/** The dashboard's "allow <config> on the router" state (qos.md section 6.3). */
export interface PlaneConfigAccess {
  config: string
  package: string
  /** null = unknown (no capabilities yet, or an older collector). */
  allowed: boolean | null
  installed: boolean | null
  /** What the router owner does about it, when not allowed. */
  hint: string | null
}

export function planeConfigAccess(gateway: Gateway, config: string): PlaneConfigAccess {
  const pkg = PACKAGE_OF[config] ?? config
  const allowed = configAllowed(gateway, config)
  const packages = gateway.capabilities?.packages
  const installed = packages && typeof packages === 'object' ? pkg in packages : null
  const sibling = gateway.capabilities?.siblingConfigs?.find((c) => c.config === config)
  let hint: string | null = null
  if (allowed === false) {
    hint =
      installed === false
        ? `Install ${pkg} on the gateway (its config then joins the router's allowlist by itself).`
        : sibling?.reason === 'opted_out'
          ? `The router opted ${config} out of management (perch-collector managed_config_exclude); remove that line to allow it.`
          : `Allow ${config} on the router: add "list managed_config '${config}'" to /etc/config/perch-collector (or update perch-collector, which allows installed sibling packages by itself), then restart perch-collector.`
  }
  return { config, package: pkg, allowed, installed, hint }
}

export function notAllowed(
  gateway: Gateway,
  config: string
): { code: string; message: string } | null {
  if (configAllowed(gateway, config) !== false) return null
  const access = planeConfigAccess(gateway, config)
  return {
    code: 'config_not_allowed',
    message: `The router does not let Perch write ${config}. ${access.hint ?? ''}`.trim(),
  }
}
