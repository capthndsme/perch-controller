import type Gateway from '#models/gateway'
import { itemsOf } from '#services/gateway_config/canonical'
import {
  DNS_SETTINGS_DOMAIN_KEY,
  dnsEditGuard,
  dnsInstanceSettings,
  dnsSettingsDomain,
  parseAddressItem,
  parseLocalDomain,
  parseRebindItem,
  parseServerItem,
  suggestRebindDomain,
  editOwnedItems,
  type ControllerHost,
  type DnsInstanceSettings,
} from '#services/gateway_config/domains/dns_settings'
import { isDnsName, scalarOption, withOptions } from '#services/gateway_config/domains/verbatim'
import { planeError } from '#services/gateway_config/errors'
import { editSections, findGateway } from '#services/gateway_config/gateway_config_service'
import { loadSections } from '#services/gateway_config/gateway_store'
import {
  applyNow,
  asSynced,
  contentOf,
  controllerHostOf,
  localDnsNames,
  requireManaged,
  requireSynced,
  sectionsOf,
  syncOf,
  type SyncInfo,
  type WriteResult,
} from '#services/gateway_config/native_common'
import { readObservedFacts, type ObservedFacts } from '#services/gateway_config/observed_facts'
import type { SectionState } from '#services/gateway_config/sync_engine'
import type { UciOptions } from '#services/gateway_config/types'

/**
 * DNS settings on the managed gateway (plan 2 sections 4.2 and 5;
 * docs/gateway/native-sync.md section 3): upstream servers, domain
 * forwards and address overrides, the local domain, rebind protection and
 * its allowed domains. Items the router added stay the router's (plan 2
 * P4): the page shows them with `owner: 'router'` and a PATCH only ever
 * edits the items Perch owns. The front resolver (AdGuard Home on the live
 * gateway, dnsmasq behind it on :54) is observed, never configured
 * (decision 12); dnsmasq's `port` is the router's.
 */

export type DnsInstanceView = {
  perchId: string
  section: string
  settings: DnsInstanceSettings
  suggestRebindDomain: boolean
  sync: SyncInfo
}

export type DnsSettingsView = {
  gatewayId: number
  /** dnsmasq's DNS port as the router reports it (0 = its DNS is off; null = not reported). */
  dnsmasqPort: number | null
  /** The process on :53 when it is not dnsmasq (AdGuard Home, unbound, …): observe only. */
  frontResolver: string | null
  adguard: boolean
  instances: DnsInstanceView[]
  controllerHost: {
    name: string | null
    addresses: string[]
    error: string | null
    /** Where the name came from: the router's resolver report, or `APP_URL`. */
    source: string
    /** Edits that would change its answer are refused (409 `dns_controller_name_pinned`). */
    pinned: boolean
    /** The router answers it from its own records. */
    local: boolean
  }
  observedAt: string | null
}

function instanceView(s: SectionState, host: ControllerHost): DnsInstanceView {
  const options = contentOf(s)!.options
  const owned = s.ownership && s.ownership.kind === 'options' ? (s.ownership.items ?? null) : null
  return {
    perchId: s.perchId,
    section: s.name,
    settings: dnsInstanceSettings(options, s.scope === 'synced' ? owned : null),
    suggestRebindDomain: suggestRebindDomain(options, host),
    sync: syncOf(s),
  }
}

function hostContext(
  gateway: Gateway,
  facts: ObservedFacts,
  states: SectionState[]
): ControllerHost & { error: string | null; source: string } {
  const host = controllerHostOf(gateway, facts)
  const first = sectionsOf(states, 'dhcp', ['dnsmasq'])[0]
  const domain = first ? scalarOption(contentOf(first)!.options, 'domain') : null
  return { ...host, localNames: localDnsNames(states, domain) }
}

export function dnsSettingsView(
  gateway: Gateway,
  states: SectionState[],
  facts: ObservedFacts
): DnsSettingsView {
  const host = hostContext(gateway, facts, states)
  const resolver = facts.resolver
  const front =
    resolver?.port53Process && !/^dnsmasq$/i.test(resolver.port53Process)
      ? resolver.port53Process
      : null
  return {
    gatewayId: gateway.id,
    dnsmasqPort: resolver?.dnsmasqPort ?? null,
    frontResolver: front,
    adguard: Boolean(front && /adguard/i.test(front)),
    instances: sectionsOf(states, 'dhcp', ['dnsmasq']).map((s) => instanceView(s, host)),
    controllerHost: {
      name: host.name,
      addresses: host.addresses,
      error: host.error,
      source: host.source,
      pinned: host.name !== null,
      local: host.name !== null && host.localNames.includes(host.name),
    },
    observedAt: facts.observedAt.resolver ?? null,
  }
}

/** `GET /gateways/:id/dns` (the settings half; `device_names.dnsOverview` has records and names). */
export async function dnsSettings(gatewayId: number): Promise<DnsSettingsView> {
  const gateway = await findGateway(gatewayId)
  const { states } = await loadSections(gateway.id)
  return dnsSettingsView(gateway, states, await readObservedFacts(gateway.collectorId))
}

export type DnsSettingsPatch = {
  /** The dnsmasq section (perch id); default the first. */
  instance?: string
  domain?: string | null
  local?: string | null
  rebindProtection?: boolean
  noresolv?: boolean
  /** Perch's upstream servers (`ip[#port]`); router-owned ones stay. */
  upstreams?: string[]
  /** Perch's domain forwards: `server` null or '' = answer locally only. */
  forwards?: Array<{ domain: string; server: string | null }>
  /** Perch's address overrides: `address` null or '' = NXDOMAIN. */
  addresses?: Array<{ domain: string; address: string | null }>
  /** Perch's rebind exceptions. */
  rebindDomains?: string[]
  apply?: boolean
}

export function hasSettingsPatch(patch: DnsSettingsPatch): boolean {
  return (
    [
      'domain',
      'local',
      'rebindProtection',
      'noresolv',
      'upstreams',
      'forwards',
      'addresses',
      'rebindDomains',
    ] as const
  ).some((k) => patch[k] !== undefined)
}

function cleanDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '')
}

/** The options after a settings patch; 422 on malformed input. */
export function patchedDnsOptions(
  current: UciOptions,
  owned: Partial<Record<string, string[]>>,
  patch: DnsSettingsPatch
): UciOptions {
  const set: Record<string, string | string[] | null | undefined> = {}
  if (patch.domain !== undefined) {
    if (patch.domain !== null && patch.domain !== '' && !isDnsName(patch.domain)) {
      throw planeError(422, 'dns_domain_invalid', `"${patch.domain}" is not a domain.`)
    }
    set.domain = patch.domain || null
  }
  if (patch.local !== undefined) {
    const local = patch.local ? `/${cleanDomain(patch.local)}/` : null
    if (local !== null && !parseLocalDomain(local)) {
      throw planeError(422, 'dns_local_invalid', `"${patch.local}" is not a domain.`)
    }
    set.local = local
  }
  if (patch.rebindProtection !== undefined)
    set.rebind_protection = patch.rebindProtection ? '1' : '0'
  if (patch.noresolv !== undefined) set.noresolv = patch.noresolv ? '1' : null

  const servers = itemsOf(current.server)
  let nextServers = servers
  if (patch.upstreams !== undefined) {
    for (const u of patch.upstreams) {
      if (parseServerItem(u)?.kind !== 'upstream') {
        throw planeError(422, 'dns_server_invalid', `"${u}" is not a DNS server (ip[#port]).`, {
          field: 'upstreams',
        })
      }
    }
    nextServers = editOwnedItems(
      nextServers,
      owned.server ?? [],
      patch.upstreams.map((u) => u.trim()),
      (item) => parseServerItem(item)?.kind === 'upstream'
    )
  }
  if (patch.forwards !== undefined) {
    const items = patch.forwards.map((f) => {
      const item = `/${cleanDomain(f.domain)}/${f.server?.trim() ?? ''}`
      const parsed = parseServerItem(item)
      if (!parsed || parsed.kind === 'upstream' || !cleanDomain(f.domain)) {
        throw planeError(422, 'dns_server_invalid', `"${item}" is not a domain forward.`, {
          field: 'forwards',
        })
      }
      return item
    })
    nextServers = editOwnedItems(nextServers, owned.server ?? [], items, (item) => {
      const kind = parseServerItem(item)?.kind
      return kind === 'forward' || kind === 'local'
    })
  }
  if (nextServers !== servers) set.server = nextServers
  if (patch.addresses !== undefined) {
    const items = patch.addresses.map((a) => {
      const item = `/${cleanDomain(a.domain)}/${a.address?.trim() ?? ''}`
      if (!parseAddressItem(item) || !cleanDomain(a.domain)) {
        throw planeError(422, 'dns_address_invalid', `"${item}" is not an address override.`, {
          field: 'addresses',
        })
      }
      return item
    })
    set.address = editOwnedItems(itemsOf(current.address), owned.address ?? [], items)
  }
  if (patch.rebindDomains !== undefined) {
    const items = patch.rebindDomains.map((d) => {
      const item = cleanDomain(d)
      if (!parseRebindItem(item)) {
        throw planeError(422, 'dns_rebind_domain_invalid', `"${d}" is not a domain.`, {
          field: 'rebindDomains',
        })
      }
      return item
    })
    set.rebind_domain = editOwnedItems(
      itemsOf(current.rebind_domain),
      owned.rebind_domain ?? [],
      items
    )
  }
  return withOptions(current, set)
}

/** `PATCH /gateways/:id/dns` (settings part). */
export async function updateDnsSettings(
  gatewayId: number,
  userId: number,
  patch: DnsSettingsPatch
): Promise<WriteResult<DnsSettingsView>> {
  const gateway = await findGateway(gatewayId)
  requireManaged(gateway)
  const { states } = await loadSections(gateway.id)
  const instances = sectionsOf(states, 'dhcp', ['dnsmasq'])
  const row = patch.instance ? instances.find((s) => s.perchId === patch.instance) : instances[0]
  if (!row) throw planeError(404, 'dns_instance_not_found', 'No dnsmasq instance to edit.')
  requireSynced(row, 'This dnsmasq instance')
  const current = contentOf(row)!.options
  const owned = row.ownership && row.ownership.kind === 'options' ? (row.ownership.items ?? {}) : {}
  const next = patchedDnsOptions(current, owned, patch)

  const facts = await readObservedFacts(gateway.collectorId)
  const refusal = dnsEditGuard(current, next, hostContext(gateway, facts, states))
  if (refusal) throw planeError(refusal.status, refusal.code, refusal.message)

  const [obj] = dnsSettingsDomain.parse(asSynced(row))
  const outcome = await editSections(
    gateway.id,
    userId,
    DNS_SETTINGS_DOMAIN_KEY,
    dnsSettingsDomain.render({ ...obj, options: next }, asSynced(row))
  )
  const { apply, applyError } = await applyNow(
    gateway,
    userId,
    [row.perchId],
    patch.apply !== false
  )
  const { states: after } = await loadSections(gateway.id)
  return {
    gatewayId: gateway.id,
    object: dnsSettingsView(gateway, after, facts),
    issues: outcome.issues,
    apply,
    applyError,
  }
}

/**
 * The record-level pin (plan 2 section 4.2): a DNS record for the
 * controller's name that answers anything else than what the router
 * resolves today, or dropping the record that answers it, is refused.
 */
export async function checkRecordPin(
  gateway: Gateway,
  before: { name: string; value: string } | null,
  after: { name: string; value: string } | null
): Promise<void> {
  const facts = await readObservedFacts(gateway.collectorId)
  const { states } = await loadSections(gateway.id)
  const host = hostContext(gateway, facts, states)
  if (!host.name) return
  const first = sectionsOf(states, 'dhcp', ['dnsmasq'])[0]
  const domain = first ? scalarOption(contentOf(first)!.options, 'domain') : null
  const fqdn = (name: string) => {
    const n = name.toLowerCase().replace(/\.$/, '')
    return !n.includes('.') && domain ? [n, `${n}.${domain.toLowerCase()}`] : [n]
  }
  const hits = (r: { name: string } | null) => r !== null && fqdn(r.name).includes(host.name!)
  const refuse = () => {
    throw planeError(
      409,
      'dns_controller_name_pinned',
      `${host.name} is the name the gateway agents dial; this record would change its answer.`
    )
  }
  if (hits(after) && !host.addresses.includes(after!.value) && after!.value !== before?.value) {
    refuse()
  }
  if (hits(before) && !hits(after)) refuse()
}
