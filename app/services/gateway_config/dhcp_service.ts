import type Gateway from '#models/gateway'
import { lanNetworks } from '#services/gateway_config/apply_lifecycle'
import { itemsOf } from '#services/gateway_config/canonical'
import { checkName, reservationView } from '#services/gateway_config/device_names'
import {
  dhcpHostsDomain,
  DHCP_HOST_EXTRA_OWNED,
  hostTags,
} from '#services/gateway_config/domains/dhcp_hosts'
import { dhcpPoolsDomain, poolEnabled } from '#services/gateway_config/domains/dhcp_pools'
import {
  DHCP_TAGS_DOMAIN_KEY,
  dhcpTagsDomain,
  parseDhcpOption,
  TAG_NAME,
} from '#services/gateway_config/domains/dhcp_tags'
import {
  isDnsName,
  isIpv4Address,
  parsePrefix,
  prefixContains,
  scalarOption,
  withOptions,
  type VerbatimSection,
} from '#services/gateway_config/domains/verbatim'
import { planeError } from '#services/gateway_config/errors'
import { editSections, findGateway } from '#services/gateway_config/gateway_config_service'
import { loadSections } from '#services/gateway_config/gateway_store'
import {
  applyNow,
  asSynced,
  contentOf,
  requireManaged,
  requireSynced,
  sectionsOf,
  syncOf,
  widenOwnership,
  type SyncInfo,
  type WriteResult,
} from '#services/gateway_config/native_common'
import type { SectionState } from '#services/gateway_config/sync_engine'
import type { UciOptions } from '#services/gateway_config/types'

/**
 * DHCP beyond the IPv4 core (plan 2 sections 4.1 and 5;
 * docs/gateway/native-sync.md section 2): per-network options pushed to
 * clients (router, DNS servers, NTP servers, domain, any other code),
 * lease range and time, DHCP tags with their own options, and the tags of a
 * reservation. IPv6 (RA, DHCPv6, NDP; odhcpd) stays the router's: shown,
 * never written.
 */

// ── options ──────────────────────────────────────────────────────────────

/** The options codes the pages edit by name. */
export const NAMED_CODES = { gateway: 3, dnsServers: 6, domain: 15, ntpServers: 42 } as const
const NAMED = new Set<number>(Object.values(NAMED_CODES))

export type DhcpOptionsView = {
  gateway: string | null
  dnsServers: string[]
  ntpServers: string[]
  domain: string | null
  /** Every other item: its code (null for a name dnsmasq knows but the page does not), value and the raw item. */
  other: Array<{ code: number | null; name: string | null; value: string; raw: string }>
}

export function dhcpOptionsView(items: string[]): DhcpOptionsView {
  const view: DhcpOptionsView = {
    gateway: null,
    dnsServers: [],
    ntpServers: [],
    domain: null,
    other: [],
  }
  for (const raw of items) {
    const parsed = parseDhcpOption(raw)
    if (!parsed || parsed.tags.length > 0 || parsed.code === null || !NAMED.has(parsed.code)) {
      view.other.push({
        code: parsed?.code ?? null,
        name: parsed?.name ?? null,
        value: parsed?.value ?? raw,
        raw,
      })
      continue
    }
    const values = parsed.value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
    if (parsed.code === 3) view.gateway = values[0] ?? ''
    if (parsed.code === 6) view.dnsServers.push(...values)
    if (parsed.code === 42) view.ntpServers.push(...values)
    if (parsed.code === 15) view.domain = parsed.value
  }
  return view
}

export type DhcpOptionsInput = {
  gateway?: string | null
  dnsServers?: string[] | null
  ntpServers?: string[] | null
  domain?: string | null
  other?: Array<{ code: number; value: string }> | null
}

function isCode(raw: string, code: number): boolean {
  const parsed = parseDhcpOption(raw)
  return parsed !== null && parsed.tags.length === 0 && parsed.code === code
}

function setCode(items: string[], code: number, value: string | null): string[] {
  const first = items.findIndex((i) => isCode(i, code))
  const rest = items.filter((i) => !isCode(i, code))
  if (value === null) return rest
  const item = `${code},${value}`
  const at = first === -1 ? rest.length : Math.min(first, rest.length)
  return [...rest.slice(0, at), item, ...rest.slice(at)]
}

/**
 * The `dhcp_option` list after an edit: each named field replaces the
 * items of its code (at the first one's place; `null`/`[]` removes them),
 * `other` replaces every untagged item of the other codes. Tagged and
 * unparseable items stay as they are.
 */
export function editDhcpOptions(items: string[], input: DhcpOptionsInput): string[] {
  let out = [...items]
  if (input.gateway !== undefined) out = setCode(out, 3, input.gateway || null)
  if (input.dnsServers !== undefined) {
    out = setCode(out, 6, input.dnsServers?.length ? input.dnsServers.join(',') : null)
  }
  if (input.ntpServers !== undefined) {
    out = setCode(out, 42, input.ntpServers?.length ? input.ntpServers.join(',') : null)
  }
  if (input.domain !== undefined) out = setCode(out, 15, input.domain || null)
  if (input.other !== undefined) {
    const isOther = (raw: string) => {
      const p = parseDhcpOption(raw)
      return p !== null && p.tags.length === 0 && p.code !== null && !NAMED.has(p.code)
    }
    out = [
      ...out.filter((i) => !isOther(i)),
      ...(input.other ?? []).map((o) => `${o.code},${o.value}`),
    ]
  }
  return out
}

/** 422 refusals of an options edit; `routerAddress` = the network's router address (option 3 check). */
function checkOptions(
  input: DhcpOptionsInput,
  ctx: { routerAddress: string | null; confirmed: boolean }
) {
  if (input.gateway) {
    if (!isIpv4Address(input.gateway)) {
      throw planeError(422, 'dhcp_gateway_invalid', `"${input.gateway}" is not an IPv4 address.`)
    }
    if (ctx.routerAddress !== null && input.gateway !== ctx.routerAddress && !ctx.confirmed) {
      throw planeError(
        422,
        'dhcp_gateway_not_router',
        `Clients would route through ${input.gateway}, not the router (${ctx.routerAddress}). Confirm with the network's name to do it anyway.`,
        { routerAddress: ctx.routerAddress }
      )
    }
  }
  for (const [field, list] of [
    ['dnsServers', input.dnsServers],
    ['ntpServers', input.ntpServers],
  ] as const) {
    for (const value of list ?? []) {
      if (!isIpv4Address(value)) {
        throw planeError(
          422,
          field === 'dnsServers' ? 'dhcp_dns_invalid' : 'dhcp_ntp_invalid',
          `"${value}" is not an IPv4 address.`,
          { field }
        )
      }
    }
  }
  if (input.domain && !isDnsName(input.domain)) {
    throw planeError(422, 'dhcp_domain_invalid', `"${input.domain}" is not a domain.`)
  }
  for (const o of input.other ?? []) {
    if (!Number.isInteger(o.code) || o.code < 1 || o.code > 254 || NAMED.has(o.code)) {
      throw planeError(
        422,
        'dhcp_option_invalid',
        `Option ${o.code} is not allowed here (1–254; 3, 6, 15 and 42 have their own fields).`
      )
    }
  }
}

// ── views ────────────────────────────────────────────────────────────────

export type DhcpPoolView = {
  network: string
  perchId: string
  section: string
  subnet: string | null
  routerAddress: string | null
  enabled: boolean
  start: number | null
  limit: number | null
  leaseTime: string | null
  force: boolean
  options: DhcpOptionsView
  /** Router-owned, shown only (odhcpd). */
  ipv6: { ra: string | null; dhcpv6: string | null; ndp: string | null; raFlags: string[] }
  management: boolean
  sync: SyncInfo
}

export type DhcpTagView = {
  perchId: string
  name: string
  options: DhcpOptionsView
  force: boolean
  /** Perch ids of reservations carrying the tag. */
  reservations: string[]
  sync: SyncInfo
}

export type DhcpReservationRow = NonNullable<ReturnType<typeof reservationView>> & {
  tags: string[]
  network: string | null
}

function num(value: string | null): number | null {
  return value !== null && /^\d+$/.test(value) ? Number(value) : null
}

function poolView(gateway: Gateway, s: SectionState, states: SectionState[]): DhcpPoolView {
  const o = contentOf(s)!.options
  const network = scalarOption(o, 'interface') ?? s.name
  const cidr = lanNetworks(states).find((n) => n.name === network)?.ipv4[0] ?? null
  return {
    network,
    perchId: s.perchId,
    section: s.name,
    subnet: cidr,
    routerAddress: cidr ? cidr.split('/')[0] : null,
    enabled: poolEnabled(o),
    start: num(scalarOption(o, 'start')),
    limit: num(scalarOption(o, 'limit')),
    leaseTime: scalarOption(o, 'leasetime'),
    force: scalarOption(o, 'force') === '1',
    options: dhcpOptionsView(itemsOf(o.dhcp_option)),
    ipv6: {
      ra: scalarOption(o, 'ra'),
      dhcpv6: scalarOption(o, 'dhcpv6'),
      ndp: scalarOption(o, 'ndp'),
      raFlags: itemsOf(o.ra_flags),
    },
    management: gateway.managementPath?.network === network,
    sync: syncOf(s),
  }
}

function tagView(s: SectionState, states: SectionState[]): DhcpTagView {
  const o = contentOf(s)!.options
  return {
    perchId: s.perchId,
    name: s.name,
    options: dhcpOptionsView(itemsOf(o.dhcp_option)),
    force: scalarOption(o, 'force') === '1',
    reservations: sectionsOf(states, 'dhcp', ['host'])
      .filter((h) => hostTags(contentOf(h)!.options).includes(s.name))
      .map((h) => h.perchId),
    sync: syncOf(s),
  }
}

function reservationRow(s: SectionState, states: SectionState[]): DhcpReservationRow | null {
  const view = reservationView(s)
  if (!view) return null
  const ip = view.ip
  const network =
    ip === null
      ? null
      : (lanNetworks(states).find((n) =>
          n.ipv4.some((c) => {
            const p = parsePrefix(c)
            return p !== null && prefixContains(p, ip)
          })
        )?.name ?? null)
  return { ...view, tags: hostTags(contentOf(s)!.options), network }
}

/** `GET /gateways/:id/dhcp`. */
export async function dhcpOverview(gatewayId: number) {
  const gateway = await findGateway(gatewayId)
  const { states } = await loadSections(gateway.id)
  const odhcpd = sectionsOf(states, 'dhcp', ['odhcpd'])[0] ?? null
  return {
    gatewayId: gateway.id,
    pools: sectionsOf(states, 'dhcp', ['dhcp']).map((s) => poolView(gateway, s, states)),
    reservations: sectionsOf(states, 'dhcp', ['host'])
      .map((s) => reservationRow(s, states))
      .filter((r): r is DhcpReservationRow => r !== null),
    tags: sectionsOf(states, 'dhcp', ['tag']).map((s) => tagView(s, states)),
    odhcpd: odhcpd
      ? { maindhcp: scalarOption(contentOf(odhcpd)!.options, 'maindhcp') === '1' }
      : null,
  }
}

// ── pools ────────────────────────────────────────────────────────────────

export type PoolPatch = {
  enabled?: boolean
  start?: number
  limit?: number
  leaseTime?: string
  force?: boolean
  options?: DhcpOptionsInput
  /** The network's name: confirms a risky change (a disabled pool on the path, a foreign gateway). */
  confirm?: string
  clientIp?: string | null
  apply?: boolean
}

function clientInSubnet(clientIp: string | null | undefined, cidr: string | null): boolean {
  if (!clientIp || !cidr) return false
  const p = parsePrefix(cidr)
  return p !== null && prefixContains(p, clientIp.replace(/^::ffff:/, ''))
}

/** `PATCH /gateways/:id/dhcp/pools/:network`. */
export async function updatePool(
  gatewayId: number,
  userId: number,
  network: string,
  patch: PoolPatch
): Promise<WriteResult<DhcpPoolView | null>> {
  const gateway = await findGateway(gatewayId)
  requireManaged(gateway)
  const { states } = await loadSections(gateway.id)
  const pool = sectionsOf(states, 'dhcp', ['dhcp']).find(
    (s) => scalarOption(contentOf(s)!.options, 'interface') === network
  )
  if (!pool) throw planeError(404, 'dhcp_pool_not_found', `No DHCP pool for "${network}".`)
  requireSynced(pool, 'This pool')
  const view = poolView(gateway, pool, states)
  const confirmed = patch.confirm === network

  if (patch.enabled === false && view.enabled && !confirmed) {
    const reason = view.management
      ? 'the gateway agent reaches the controller through this network'
      : clientInSubnet(patch.clientIp, view.subnet)
        ? 'your own device gets its address from it'
        : null
    if (reason) {
      throw planeError(
        409,
        'dhcp_confirm_required',
        `Switching this pool off cuts clients at their next renewal, and ${reason}. Confirm with the network's name.`,
        { network }
      )
    }
  }
  if (patch.options) checkOptions(patch.options, { routerAddress: view.routerAddress, confirmed })
  if (patch.leaseTime !== undefined && !/^(\d+[smhdw]?|infinite)$/i.test(patch.leaseTime)) {
    throw planeError(422, 'dhcp_leasetime_invalid', `"${patch.leaseTime}" is not a lease time.`)
  }
  const start = patch.start ?? view.start ?? 100
  const limit = patch.limit ?? view.limit ?? 150
  if (view.subnet && (patch.start !== undefined || patch.limit !== undefined)) {
    const p = parsePrefix(view.subnet)
    if (p && start + limit - 1 > 2 ** (32 - p.prefix) - 2) {
      throw planeError(422, 'dhcp_range_outside_subnet', `The pool does not fit ${view.subnet}.`)
    }
  }

  const current = contentOf(pool)!.options
  const set: Record<string, string | string[] | null | undefined> = {
    start: patch.start !== undefined ? String(patch.start) : undefined,
    limit: patch.limit !== undefined ? String(patch.limit) : undefined,
    leasetime: patch.leaseTime,
    force: patch.force === undefined ? undefined : patch.force ? '1' : null,
    dhcp_option: patch.options
      ? editDhcpOptions(itemsOf(current.dhcp_option), patch.options)
      : undefined,
  }
  if (patch.enabled !== undefined) {
    set.ignore = patch.enabled ? null : '1'
    if (patch.enabled && scalarOption(current, 'dhcpv4') === 'disabled') set.dhcpv4 = 'server'
  }
  const [obj] = dhcpPoolsDomain.parse(asSynced(pool))
  const options = withOptions(current, set)
  const edits = dhcpPoolsDomain.render(
    { ...obj, fields: pickOwned(options, obj.fields, obj.extra), extra: obj.extra },
    asSynced(pool)
  )
  const outcome = await editSections(gateway.id, userId, 'dhcp_pools', edits)
  const { apply, applyError } = await applyNow(
    gateway,
    userId,
    [pool.perchId],
    patch.apply !== false
  )
  const { states: after } = await loadSections(gateway.id)
  const row = after.find((s) => s.perchId === pool.perchId)
  return {
    gatewayId: gateway.id,
    object: row ? poolView(gateway, row, after) : null,
    issues: outcome.issues,
    apply,
    applyError,
  }
}

/** The pool's modeled fields from edited options (extras stay as they were). */
function pickOwned(options: UciOptions, _before: UciOptions, extra: UciOptions): UciOptions {
  const out: UciOptions = {}
  for (const [k, v] of Object.entries(options)) if (!(k in extra)) out[k] = v
  return out
}

// ── tags ─────────────────────────────────────────────────────────────────

export type TagInput = {
  name?: string
  options?: DhcpOptionsInput
  force?: boolean
  apply?: boolean
}

function findTag(states: SectionState[], perchId: string): SectionState {
  const s = sectionsOf(states, 'dhcp', ['tag']).find((t) => t.perchId === perchId)
  if (!s) throw planeError(404, 'dhcp_tag_not_found', `No DHCP tag ${perchId}.`)
  return s
}

async function tagResult(
  gateway: Gateway,
  userId: number,
  perchId: string,
  issues: WriteResult<unknown>['issues'],
  wanted: boolean
): Promise<WriteResult<DhcpTagView | null>> {
  const { apply, applyError } = await applyNow(gateway, userId, [perchId], wanted)
  const { states: after } = await loadSections(gateway.id)
  const row = after.find((s) => s.perchId === perchId)
  return {
    gatewayId: gateway.id,
    object: row && contentOf(row) ? tagView(row, after) : null,
    issues,
    apply,
    applyError,
  }
}

/** `POST /gateways/:id/dhcp/tags`. */
export async function createTag(gatewayId: number, userId: number, input: TagInput) {
  const gateway = await findGateway(gatewayId)
  requireManaged(gateway)
  const name = input.name ?? ''
  if (!TAG_NAME.test(name)) {
    throw planeError(422, 'dhcp_tag_invalid', 'A tag name is 1–32 letters, digits or _.')
  }
  const { states } = await loadSections(gateway.id)
  if (states.some((s) => s.config === 'dhcp' && s.name === name)) {
    throw planeError(409, 'dhcp_tag_exists', `The dhcp config already has a section "${name}".`)
  }
  if (input.options) checkOptions(input.options, { routerAddress: null, confirmed: true })
  const options: UciOptions = {}
  const items = editDhcpOptions([], input.options ?? {})
  if (items.length > 0) options.dhcp_option = items
  if (input.force) options.force = '1'
  const obj: VerbatimSection = {
    perchId: null,
    section: name,
    type: 'tag',
    options,
    secretNames: [],
  }
  const outcome = await editSections(
    gateway.id,
    userId,
    DHCP_TAGS_DOMAIN_KEY,
    dhcpTagsDomain.render(obj, [])
  )
  return tagResult(gateway, userId, outcome.perchIds[0], outcome.issues, input.apply !== false)
}

/** `PATCH /gateways/:id/dhcp/tags/:perchId`. */
export async function updateTag(
  gatewayId: number,
  userId: number,
  perchId: string,
  input: TagInput
) {
  const gateway = await findGateway(gatewayId)
  requireManaged(gateway)
  const { states } = await loadSections(gateway.id)
  const tag = findTag(states, perchId)
  requireSynced(tag, 'This tag')
  if (input.options) checkOptions(input.options, { routerAddress: null, confirmed: true })
  const current = contentOf(tag)!.options
  const options = withOptions(current, {
    dhcp_option: input.options
      ? editDhcpOptions(itemsOf(current.dhcp_option), input.options)
      : undefined,
    force: input.force === undefined ? undefined : input.force ? '1' : null,
  })
  const [obj] = dhcpTagsDomain.parse(asSynced(tag))
  const outcome = await editSections(
    gateway.id,
    userId,
    DHCP_TAGS_DOMAIN_KEY,
    dhcpTagsDomain.render({ ...obj, options }, asSynced(tag))
  )
  return tagResult(gateway, userId, perchId, outcome.issues, input.apply !== false)
}

/** `DELETE /gateways/:id/dhcp/tags/:perchId`: refused while a reservation carries the tag. */
export async function deleteTag(
  gatewayId: number,
  userId: number,
  perchId: string,
  input: { apply?: boolean } = {}
): Promise<WriteResult<null>> {
  const gateway = await findGateway(gatewayId)
  requireManaged(gateway)
  const { states } = await loadSections(gateway.id)
  const tag = findTag(states, perchId)
  requireSynced(tag, 'This tag')
  const users = tagView(tag, states).reservations
  if (users.length > 0) {
    throw planeError(409, 'dhcp_tag_in_use', 'Reservations still carry this tag.', {
      reservations: users,
    })
  }
  const outcome = await editSections(gateway.id, userId, DHCP_TAGS_DOMAIN_KEY, [
    { op: 'delete', perchId },
  ])
  const { apply, applyError } = await applyNow(
    gateway,
    userId,
    outcome.deleted.includes(perchId) ? [] : [perchId],
    input.apply !== false
  )
  return { gatewayId: gateway.id, object: null, issues: outcome.issues, apply, applyError }
}

// ── reservations ─────────────────────────────────────────────────────────

export type ReservationPatch = {
  ip?: string | null
  hostname?: string | null
  leaseTime?: string | null
  publishDns?: boolean
  tags?: string[]
  apply?: boolean
}

/**
 * `PATCH /gateways/:id/dhcp/reservations/:perchId`: a Perch reservation's
 * address, name, lease time, DNS flag and tags. The device page keeps its
 * own MAC-keyed route (`PUT /devices/:mac/reservation`).
 */
export async function updateReservation(
  gatewayId: number,
  userId: number,
  perchId: string,
  patch: ReservationPatch
): Promise<WriteResult<DhcpReservationRow | null>> {
  const gateway = await findGateway(gatewayId)
  requireManaged(gateway)
  const { states } = await loadSections(gateway.id)
  const row = sectionsOf(states, 'dhcp', ['host']).find((s) => s.perchId === perchId)
  if (!row || !reservationView(row)) {
    throw planeError(404, 'dhcp_reservation_not_found', `No reservation ${perchId}.`)
  }
  requireSynced(row, 'This reservation')
  const [obj] = dhcpHostsDomain.parse(asSynced(row))
  if (patch.ip !== undefined && patch.ip !== null && !isIpv4Address(patch.ip)) {
    throw planeError(422, 'dhcp_ip_invalid', `"${patch.ip}" is not an IPv4 address.`)
  }
  if (patch.hostname !== undefined && patch.hostname !== null && patch.hostname !== obj.name) {
    checkName(gateway, patch.hostname)
  }
  if (patch.leaseTime && !/^(\d+[smhdw]?|infinite)$/i.test(patch.leaseTime)) {
    throw planeError(422, 'dhcp_leasetime_invalid', `"${patch.leaseTime}" is not a lease time.`)
  }
  for (const tag of patch.tags ?? []) {
    if (!TAG_NAME.test(tag))
      throw planeError(422, 'dhcp_tag_invalid', `"${tag}" is not a tag name.`)
  }
  const next = { ...obj, extra: { ...obj.extra } }
  if (patch.ip !== undefined) next.ip = patch.ip
  if (patch.hostname !== undefined) next.name = patch.hostname
  if (patch.leaseTime !== undefined) next.leasetime = patch.leaseTime
  if (patch.publishDns !== undefined) next.dns = patch.publishDns && next.ip !== null ? '1' : null
  else if (next.ip === null) next.dns = null
  if (next.ip === null && next.name === null) {
    throw planeError(422, 'dhcp_host_empty', 'A reservation needs an address or a name.')
  }
  if (patch.tags !== undefined) {
    const tags = [...new Set(patch.tags)]
    const before = obj.extra.tag
    if (tags.length === 0) delete next.extra.tag
    else next.extra.tag = typeof before === 'string' ? tags.join(' ') : tags
    await widenOwnership(gateway.id, perchId, DHCP_HOST_EXTRA_OWNED)
  }
  const outcome = await editSections(
    gateway.id,
    userId,
    'dhcp_hosts',
    dhcpHostsDomain.render(next, asSynced(row))
  )
  const { apply, applyError } = await applyNow(gateway, userId, [perchId], patch.apply !== false)
  const { states: after } = await loadSections(gateway.id)
  const updated = after.find((s) => s.perchId === perchId)
  return {
    gatewayId: gateway.id,
    object: updated ? reservationRow(updated, after) : null,
    issues: outcome.issues,
    apply,
    applyError,
  }
}
