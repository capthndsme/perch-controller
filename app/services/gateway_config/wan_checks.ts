import type { CheckItem, ChecksCtx, ChecksPlan } from '#services/gateway_config/domain'
import type { GatewaySyncSettings } from '#services/gateway_config/gateway_sync_settings'
import {
  primaryUplink,
  uplinkNetworkOf,
  wanTopology,
  type WanTopology,
} from '#services/gateway_config/domains/wan'
import type { SectionContent, UciConfigSet } from '#services/gateway_config/types'

/**
 * The WAN's apply checks (docs/design/gateway-sync/domains.md 3.8), pure:
 * what the router must verify after a job that touches WAN sections.
 *
 * - Per uplink or IPv6 companion the job touches that is enabled after the
 *   job: `interface_up {network, family}` (6 for a companion). `mustPass`
 *   when the job enables it, or changes its proto, addressing, device or MAC
 *   while it was up at the last observation (the router never skips those,
 *   even when they failed before the job).
 * - Once per job that touches any uplink, alias, device or pool:
 *   `default_route {family: 4}`, `reach` (Settings → Gateway sync targets,
 *   `$gateway` = the primary uplink after the job, the TCP fallback port),
 *   `resolve` (a fresh label under the setting's name; omitted when it is
 *   empty), and `default_route {family: 6}` when an IPv6 companion was up.
 * - Budget: the largest per-proto timeout among the touched links.
 *
 * A job touching only a NAT link (a masqueraded side network) gets none: it
 * cannot take the internet away.
 */

/** Options whose change makes an up interface's own check `mustPass`. */
const CONNECTION_OPTIONS = [
  'proto',
  'device',
  'ifname',
  'ipaddr',
  'netmask',
  'gateway',
  'ip6addr',
  'ip6gw',
  'macaddr',
  'username',
  'service',
  'ac',
  'apn',
  'reqaddress',
  'reqprefix',
]
const DEVICE_CONNECTION_OPTIONS = ['macaddr', 'mtu', 'name', 'ipv6']

/** The per-proto check budget of an interface (Settings → Gateway sync). */
export function checkTimeoutForProto(settings: GatewaySyncSettings, proto: string): number {
  if (proto === 'dhcp' || proto === 'dhcpv6') return settings.checkTimeoutDhcpSeconds
  if (proto === 'static' || proto === 'none') return settings.checkTimeoutStaticSeconds
  if (proto === 'pppoe' || proto === 'pppoa') return settings.checkTimeoutPppoeSeconds
  if (['3g', 'qmi', 'ncm', 'mbim', 'modemmanager', 'wwan', 'directip'].includes(proto)) {
    return settings.checkTimeoutMobileSeconds
  }
  return settings.checkTimeoutOtherSeconds
}

function scalar(content: SectionContent | null, key: string): string | null {
  const v = content?.options[key]
  if (v === undefined) return null
  return Array.isArray(v) ? v.join(' ') : v
}

function enabled(content: SectionContent | null): boolean {
  if (!content) return false
  const disabled = scalar(content, 'disabled')
  const auto = scalar(content, 'auto')
  return (
    !['1', 'true', 'yes', 'on'].includes(disabled ?? '') &&
    !['0', 'false', 'no', 'off'].includes(auto ?? '')
  )
}

function differs(a: SectionContent | null, b: SectionContent | null, options: string[]): boolean {
  return options.some(
    (o) => JSON.stringify(a?.options[o] ?? null) !== JSON.stringify(b?.options[o] ?? null)
  )
}

/** A check id from a network: lowercase, `^[a-z0-9:_.-]{1,32}$`, unique in `taken`. */
function checkId(prefix: string, network: string, taken: Set<string>): string {
  const clean = network.toLowerCase().replace(/[^a-z0-9_.-]/g, '_')
  let id = `${prefix}${clean}`.slice(0, 32)
  let n = 2
  while (taken.has(id)) {
    const suffix = `.${n++}`
    id = `${prefix}${clean}`.slice(0, 32 - suffix.length) + suffix
  }
  taken.add(id)
  return id
}

function sectionContent(all: UciConfigSet, config: string, name: string): SectionContent | null {
  const s = all[config]?.sections.find((x) => x.name === name)
  return s ? { type: s.type, options: s.options } : null
}

export function deriveWanChecks(ctx: ChecksCtx): ChecksPlan | null {
  const settings = ctx.settings
  const after = wanTopology(ctx.after)
  const before = wanTopology(ctx.before)
  const observed = new Map((ctx.observed.interfaces ?? []).map((i) => [i.network, i]))
  const wasUp = (network: string) => observed.get(network)?.up === true

  const items: CheckItem[] = []
  const ids = new Set<string>()
  const touchedLinks = new Set<string>()
  let internetTouched = false
  let v6Up = false

  /** The uplink a section is part of, after or before the job. */
  const hostOf = (config: string, name: string): string | null => {
    for (const t of [after, before] as WanTopology[]) {
      if (config === 'dhcp') {
        const net = t.poolOf.get(name)
        if (net) return uplinkNetworkOf(t, net) ?? net
        continue
      }
      const viaDevice = t.deviceOf.get(name)
      if (viaDevice) return viaDevice
      const up = uplinkNetworkOf(t, name)
      if (up) return up
    }
    return null
  }

  const interfaceUp: Array<{ network: string; family: 4 | 6; mustPass: boolean }> = []
  for (const s of ctx.sections) {
    const host = hostOf(s.config, s.name)
    if (!host) continue // a NAT link or something unrelated to the internet
    internetTouched = true
    touchedLinks.add(host)
    if (s.config !== 'network') continue
    const content = s.after ?? s.before
    if (content?.type === 'device') {
      // A port change (MAC, MTU) of an up uplink must bring it back.
      if (differs(s.before, s.after, DEVICE_CONNECTION_OPTIONS)) {
        const up = interfaceUp.find((i) => i.network === host)
        if (up) up.mustPass = up.mustPass || wasUp(host)
        else if (after.uplinks.some((u) => u.network === host && u.enabled)) {
          interfaceUp.push({ network: host, family: 4, mustPass: wasUp(host) })
        }
      }
      continue
    }
    if (content?.type !== 'interface') continue
    const isUplink = after.uplinks.some((u) => u.network === s.name)
    const isCompanion = after.companionOf.has(s.name)
    if (!isUplink && !isCompanion) continue
    if (!enabled(s.after)) continue
    const turnedOn = !enabled(s.before)
    const changed = differs(s.before, s.after, CONNECTION_OPTIONS)
    const mustPass = turnedOn || (changed && wasUp(s.name))
    const existing = interfaceUp.find((i) => i.network === s.name)
    if (existing) existing.mustPass = existing.mustPass || mustPass
    else interfaceUp.push({ network: s.name, family: isCompanion ? 6 : 4, mustPass })
  }
  if (!internetTouched) return null

  for (const i of interfaceUp) {
    items.push({
      id: checkId('up:', i.network, ids),
      kind: 'interface_up',
      network: i.network,
      family: i.family,
      ...(i.mustPass ? { mustPass: true } : {}),
    })
  }
  items.push({ id: checkId('', 'route4', ids), kind: 'default_route', family: 4 })

  // Reach: the primary uplink after the job names `$gateway`; its own
  // targets (gateway_wans) win over the setting.
  const primary = primaryUplink(after)
  const targets = (primary && ctx.targets?.[primary.network]) || settings.checkTargets
  const reach = targets
    .map((t) => (t === '$gateway' ? (primary ? `$gateway:${primary.network}` : null) : t))
    .filter((t): t is string => t !== null)
  if (reach.length > 0) {
    items.push({
      id: checkId('', 'reach4', ids),
      kind: 'reach',
      family: 4,
      targets: [...new Set(reach)].slice(0, 8),
      tcpPort: settings.checkTcpPort,
    })
  }
  if (settings.checkResolveName !== '') {
    items.push({ id: checkId('', 'dns', ids), kind: 'resolve', name: settings.checkResolveName })
  }
  for (const [companion] of before.companionOf) if (wasUp(companion)) v6Up = true
  if (v6Up) items.push({ id: checkId('', 'route6', ids), kind: 'default_route', family: 6 })

  // Budget: the slowest proto among the touched links (before or after).
  let timeout = 0
  for (const network of touchedLinks) {
    const content =
      sectionContent(ctx.after, 'network', network) ??
      sectionContent(ctx.before, 'network', network)
    const proto = scalar(content, 'proto') ?? 'none'
    timeout = Math.max(timeout, checkTimeoutForProto(settings, proto))
    const companion = after.uplinks.find((u) => u.network === network)?.companion
    if (companion) {
      const c = sectionContent(ctx.after, 'network', companion)
      timeout = Math.max(timeout, checkTimeoutForProto(settings, scalar(c, 'proto') ?? 'none'))
    }
  }
  return { timeoutSeconds: Math.max(timeout, 10), items: items.slice(0, 16) }
}
