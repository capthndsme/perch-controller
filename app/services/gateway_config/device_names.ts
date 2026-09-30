import Gateway from '#models/gateway'
import GatewayHost from '#models/gateway_host'
import { listDeviceLabels, normalizeMac } from '#services/device_labels'
import { requestApply } from '#services/gateway_config/apply_lifecycle'
import type { SectionEdit } from '#services/gateway_config/domain'
import {
  dhcpHostsDomain,
  macsOf,
  type DhcpReservation,
} from '#services/gateway_config/domains/dhcp_hosts'
import {
  dnsRecordsDomain,
  HOSTNAME,
  isReservedName,
  isValidIp,
  slugifyLabel,
  type DnsRecord,
} from '#services/gateway_config/domains/dns_records'
import { GatewayPlaneError, planeError } from '#services/gateway_config/errors'
import { recordGatewayEvent } from '#services/gateway_config/events'
import { editSections, findGateway } from '#services/gateway_config/gateway_config_service'
import { loadSections } from '#services/gateway_config/gateway_store'
import { checkRecordPin } from '#services/gateway_config/dns_service'

async function loadStates(gatewayId: number) {
  const loaded = await loadSections(gatewayId)
  return loaded.states
}
import { normalizeMode } from '#services/gateway_config/gateway_registry'
import type { SectionState } from '#services/gateway_config/sync_engine'
import type { Issue } from '#services/gateway_config/types'
import env from '#start/env'

/**
 * The first managed domains on the device page and the DNS page (README M3;
 * plan 2 sections 4.1, 4.2 and 5): DHCP reservations with their DNS name,
 * local DNS records, and device label names in DNS under the `review`
 * policy (README 7.10: an admin approves; reserved names are always
 * refused). Every write goes through `editSections` into the draft and, by
 * default, straight into an apply of the touched sections.
 */

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

// ── which gateway ────────────────────────────────────────────────────────

/**
 * The gateway a device-page write goes to: the one named, else the only
 * managed one. 404 when there is none, 409 `gateway_ambiguous` when several
 * could be meant.
 */
export async function resolveManagedGateway(gatewayId?: number): Promise<Gateway> {
  if (gatewayId !== undefined) {
    const gateway = await findGateway(gatewayId)
    if (normalizeMode(gateway.mode) !== 'managed') {
      throw planeError(409, 'not_managed', 'The gateway is not in managed mode.')
    }
    return gateway
  }
  const managed = await Gateway.query().where('mode', 'managed')
  if (managed.length === 0) {
    throw planeError(404, 'gateway_not_found', 'No gateway is managed by Perch.')
  }
  if (managed.length > 1) {
    throw planeError(409, 'gateway_ambiguous', 'Several gateways are managed; name one.', {
      gatewayIds: managed.map((g) => g.id),
    })
  }
  return managed[0]
}

/** Names a label or record may never take, plus the controller's own host label. */
export function reservedNames(gateway: Gateway): string[] {
  const out: string[] = []
  try {
    const host = new URL(env.get('APP_URL')).hostname
    if (host && !IPV4.test(host) && !host.includes(':')) out.push(host.split('.')[0])
  } catch {
    // no usable APP_URL
  }
  const caps = gateway.capabilities as Record<string, unknown> | null
  const system = caps?.system as Record<string, unknown> | undefined
  if (typeof system?.hostname === 'string') out.push(system.hostname)
  if (typeof caps?.hostname === 'string') out.push(caps.hostname)
  return out
}

export function checkName(gateway: Gateway, name: string, field = 'hostname') {
  if (!HOSTNAME.test(name)) {
    throw planeError(422, 'dns_name_invalid', `"${name}" is not a valid DNS name.`, { field })
  }
  if (isReservedName(name, reservedNames(gateway))) {
    throw planeError(422, 'dns_name_reserved', `"${name}" is reserved.`, { field })
  }
}

// ── reservations ─────────────────────────────────────────────────────────

export type ReservationView = {
  perchId: string
  section: string
  macs: string[]
  ip: string | null
  hostname: string | null
  publishDns: boolean
  leaseTime: string | null
  deny: boolean
  owner: 'perch' | 'router'
  status: string
  scope: string
  applied: boolean
  conflict: boolean
  driftSince: string | null
}

function asSynced(s: SectionState, content = s.desired ?? s.router) {
  return content
    ? [
        {
          perchId: s.perchId,
          config: s.config,
          name: s.name,
          type: content.type,
          anonymous: s.anonymous,
          options: content.options,
        },
      ]
    : []
}

function hostOf(s: SectionState): DhcpReservation | null {
  if (s.config !== 'dhcp' || s.type !== 'host') return null
  return dhcpHostsDomain.parse(asSynced(s))[0] ?? null
}

export function reservationView(s: SectionState): ReservationView | null {
  const host = hostOf(s)
  if (!host) return null
  return {
    perchId: s.perchId,
    section: s.name,
    macs: host.macs,
    ip: host.ip === 'ignore' ? null : host.ip,
    hostname: host.name,
    publishDns: host.dns === '1' || host.dns === 'true',
    leaseTime: host.leasetime,
    deny: host.ip === 'ignore',
    owner: s.scope === 'synced' ? 'perch' : 'router',
    status: s.status,
    scope: s.scope,
    applied: s.router !== null && s.status === 'in_sync',
    conflict: s.conflict !== null,
    driftSince: s.driftSince,
  }
}

function hostsForMac(states: SectionState[], mac: string): SectionState[] {
  return states.filter((s) => {
    if (s.config !== 'dhcp' || s.type !== 'host') return false
    const content = s.desired ?? s.router
    return content ? macsOf(content.options.mac).includes(mac) : false
  })
}

export type DeviceWriteResult = {
  gatewayId: number
  object: ReservationView | null
  issues: Issue[]
  apply: unknown | null
  applyError: { error: string; message: string } | null
}

async function applyNow(
  gateway: Gateway,
  userId: number,
  perchIds: string[],
  wanted: boolean
): Promise<{ apply: unknown | null; applyError: DeviceWriteResult['applyError'] }> {
  if (!wanted || perchIds.length === 0) return { apply: null, applyError: null }
  try {
    const apply = await requestApply(gateway.id, { userId, perchIds })
    return { apply, applyError: null }
  } catch (error) {
    if (error instanceof GatewayPlaneError) {
      return { apply: null, applyError: { error: error.code, message: error.message } }
    }
    throw error
  }
}

export async function getDeviceReservation(macRaw: string, gatewayId?: number) {
  const mac = requireMac(macRaw)
  const gateway = await resolveManagedGateway(gatewayId)
  const { states } = await loadSections(gateway.id)
  const hosts = hostsForMac(states, mac)
  const synced = hosts.find((s) => s.scope === 'synced') ?? hosts[0] ?? null
  const view = synced ? reservationView(synced) : null
  const lease = await GatewayHost.query()
    .where('collector_id', gateway.collectorId ?? 0)
    .where('mac', mac)
    .first()
  return {
    gatewayId: gateway.id,
    reservation: view,
    dnsName: view?.hostname ?? null,
    lease: lease ? { ipv4: lease.ipv4, hostname: lease.hostname } : null,
  }
}

function requireMac(raw: string): string {
  const mac = normalizeMac(raw)
  if (!mac) throw planeError(400, 'invalid_mac', `"${raw}" is not a MAC address.`)
  return mac
}

export type ReservationInput = {
  gatewayId?: number
  ip: string | null
  hostname?: string | null
  publishDns?: boolean
  leaseTime?: string | null
  apply?: boolean
}

/**
 * `PUT /devices/:mac/reservation`: creates or edits the Perch reservation
 * of the device (a router-owned host with the MAC is refused, 409
 * `dhcp_host_exists`). `ip: 'current'` takes the lease the gateway reports;
 * `ip: null` keeps a name-only host (a DNS name that follows the lease).
 */
export async function putDeviceReservation(
  macRaw: string,
  userId: number,
  input: ReservationInput
): Promise<DeviceWriteResult> {
  const mac = requireMac(macRaw)
  const gateway = await resolveManagedGateway(input.gatewayId)
  const { states } = await loadSections(gateway.id)
  const hosts = hostsForMac(states, mac)
  const foreign = hosts.find((s) => s.scope !== 'synced')
  const own = hosts.find((s) => s.scope === 'synced') ?? null
  if (!own && foreign) {
    throw planeError(
      409,
      'dhcp_host_exists',
      'The router has its own host entry for this device.',
      {
        perchId: foreign.perchId,
        owner: 'router',
      }
    )
  }

  let ip = input.ip
  if (ip === 'current') {
    const lease = await GatewayHost.query()
      .where('collector_id', gateway.collectorId ?? 0)
      .where('mac', mac)
      .first()
    if (!lease?.ipv4) throw planeError(409, 'device_no_lease', 'The device has no current lease.')
    ip = lease.ipv4.split(',')[0].trim()
  }
  if (ip !== null && !IPV4.test(ip)) {
    throw planeError(422, 'dhcp_ip_invalid', `"${ip}" is not an IPv4 address.`)
  }
  const current = own ? hostOf(own) : null
  const hostname = input.hostname === undefined ? (current?.name ?? null) : input.hostname
  if (hostname !== null && hostname !== current?.name) checkName(gateway, hostname)
  if (ip === null && hostname === null) {
    throw planeError(422, 'dhcp_host_empty', 'A reservation needs an address or a name.')
  }
  const publishDns =
    input.publishDns === undefined ? current?.dns === '1' : Boolean(input.publishDns)
  const leaseTime = input.leaseTime === undefined ? (current?.leasetime ?? null) : input.leaseTime

  const obj: DhcpReservation = current
    ? { ...current }
    : {
        perchId: null,
        section: '',
        macs: [mac],
        macForm: 'string',
        ip: null,
        name: null,
        dns: null,
        leasetime: null,
        extra: {},
        secretNames: [],
        macRaw: null,
      }
  obj.ip = ip
  obj.name = hostname
  obj.dns = publishDns && ip !== null ? '1' : null
  obj.leasetime = leaseTime
  const edits = dhcpHostsDomain.render(obj, asSynced(own ?? states[0]))
  const outcome = await editSections(gateway.id, userId, 'dhcp_hosts', edits)
  const perchId = own?.perchId ?? outcome.perchIds[0]
  const { apply, applyError } = await applyNow(gateway, userId, [perchId], input.apply !== false)
  const reloaded = await loadSections(gateway.id)
  const after = reloaded.states.find((s) => s.perchId === perchId)
  return {
    gatewayId: gateway.id,
    object: after ? reservationView(after) : null,
    issues: outcome.issues,
    apply,
    applyError,
  }
}

/** `DELETE /devices/:mac/reservation`. */
export async function deleteDeviceReservation(
  macRaw: string,
  userId: number,
  input: { gatewayId?: number; apply?: boolean }
): Promise<DeviceWriteResult> {
  const mac = requireMac(macRaw)
  const gateway = await resolveManagedGateway(input.gatewayId)
  const { states } = await loadSections(gateway.id)
  const own = hostsForMac(states, mac).find((s) => s.scope === 'synced')
  if (!own)
    throw planeError(404, 'dhcp_reservation_not_found', 'No Perch reservation for this device.')
  const outcome = await editSections(gateway.id, userId, 'dhcp_hosts', [
    { op: 'delete', perchId: own.perchId },
  ])
  const stillThere = outcome.deleted.length === 0
  const { apply, applyError } = await applyNow(
    gateway,
    userId,
    stillThere ? [own.perchId] : [],
    input.apply !== false
  )
  return { gatewayId: gateway.id, object: null, issues: outcome.issues, apply, applyError }
}

// ── DNS records ──────────────────────────────────────────────────────────

export type DnsRecordView = {
  perchId: string
  section: string
  /** `host`: a MAC-less `dhcp` host that only publishes a name (gateway sync domains.md 6). */
  type: 'a' | 'cname' | 'host'
  name: string
  value: string
  /** `host` records: whether dnsmasq answers the name (`dns '1'`); null for the others. */
  publishDns: boolean | null
  owner: 'perch' | 'router'
  status: string
  applied: boolean
}

function recordOf(s: SectionState): DnsRecord | null {
  if (s.config !== 'dhcp' || !['domain', 'cname', 'host'].includes(s.type)) return null
  return dnsRecordsDomain.parse(asSynced(s))[0] ?? null
}

function publishDnsOf(r: DnsRecord): boolean | null {
  if (r.type !== 'host') return null
  const dns = r.extra.dns
  return typeof dns === 'string' && ['1', 'true', 'yes', 'on'].includes(dns.trim().toLowerCase())
}

function recordView(s: SectionState): DnsRecordView | null {
  const r = recordOf(s)
  if (!r) return null
  return {
    perchId: s.perchId,
    section: s.name,
    type: r.type,
    name: r.name,
    value: r.value,
    publishDns: publishDnsOf(r),
    owner: s.scope === 'synced' ? 'perch' : 'router',
    status: s.status,
    applied: s.router !== null && s.status === 'in_sync',
  }
}

/** `GET /gateways/:id/dns`. */
export async function dnsOverview(gatewayId: number) {
  const gateway = await findGateway(gatewayId)
  const { states } = await loadSections(gateway.id)
  return {
    labelNames: gateway.dnsLabelNames === 'off' ? 'off' : 'review',
    records: states.map(recordView).filter((r): r is DnsRecordView => r !== null),
    // A MAC-less host is a DNS record (type `host`), not a reservation's name.
    names: states
      .filter((s) => recordOf(s) === null)
      .map(reservationView)
      .filter((r): r is ReservationView => r !== null && r.hostname !== null)
      .map((r) => ({
        perchId: r.perchId,
        hostname: r.hostname,
        ip: r.ip,
        macs: r.macs,
        owner: r.owner,
      })),
    reserved: reservedNames(gateway),
    pendingLabelNames:
      gateway.dnsLabelNames === 'off' ? [] : await pendingLabelNames(gateway, states),
  }
}

export async function setDnsLabelPolicy(
  gatewayId: number,
  userId: number,
  policy: 'off' | 'review'
) {
  const gateway = await findGateway(gatewayId)
  if (gateway.dnsLabelNames !== policy) {
    gateway.dnsLabelNames = policy
    await gateway.save()
    await recordGatewayEvent(gateway.id, 'dns_label_names_changed', {
      userId,
      detail: { labelNames: policy },
    })
  }
  return dnsOverview(gatewayId)
}

function takenNames(states: SectionState[], exceptPerchId: string | null = null): Set<string> {
  const out = new Set<string>()
  for (const s of states) {
    if (s.perchId === exceptPerchId) continue
    const h = hostOf(s)
    if (h?.name) out.add(h.name.toLowerCase())
    const r = recordOf(s)
    if (r) out.add(r.name.toLowerCase())
  }
  return out
}

export async function createDnsRecord(
  gatewayId: number,
  userId: number,
  input: { type: 'a' | 'cname'; name: string; value: string; apply?: boolean }
) {
  const gateway = await findGateway(gatewayId)
  checkName(gateway, input.name, 'name')
  if (input.type === 'a' && !isValidIp(input.value)) {
    throw planeError(422, 'dns_value_invalid', `"${input.value}" is not an IP address.`)
  }
  const { states } = await loadSections(gateway.id)
  if (input.type === 'cname' && takenNames(states).has(input.name.toLowerCase())) {
    throw planeError(409, 'dns_name_taken', `${input.name} is already in use.`)
  }
  await checkRecordPin(gateway, null, { name: input.name, value: input.value })
  const edits = dnsRecordsDomain.render(
    {
      perchId: null,
      section: '',
      type: input.type,
      name: input.name,
      value: input.value,
      extra: {},
    },
    []
  )
  const outcome = await editSections(gateway.id, userId, 'dns_records', edits)
  return finishRecord(gateway, userId, outcome.perchIds[0], outcome.issues, input.apply)
}

export async function updateDnsRecord(
  gatewayId: number,
  userId: number,
  perchId: string,
  input: { name?: string; value?: string; publishDns?: boolean; apply?: boolean }
) {
  const gateway = await findGateway(gatewayId)
  const { states } = await loadSections(gateway.id)
  const row = states.find((s) => s.perchId === perchId)
  const record = row ? recordOf(row) : null
  if (!row || !record) throw planeError(404, 'dns_record_not_found', `No DNS record ${perchId}.`)
  if (row.scope !== 'synced') {
    throw planeError(409, 'not_synced', 'This record is the router’s; include it first.')
  }
  if (input.name !== undefined && input.name !== record.name) checkName(gateway, input.name, 'name')
  const extra = { ...record.extra }
  if (record.type === 'host' && input.publishDns !== undefined) {
    // `dns '1'` makes dnsmasq answer the name; a host without it publishes nothing.
    if (input.publishDns) extra.dns = '1'
    else delete extra.dns
  }
  const next = {
    ...record,
    name: input.name ?? record.name,
    value: input.value ?? record.value,
    extra,
  }
  if ((next.type === 'a' || next.type === 'host') && !isValidIp(next.value)) {
    throw planeError(422, 'dns_value_invalid', `"${next.value}" is not an IP address.`)
  }
  await checkRecordPin(gateway, record, next)
  const outcome = await editSections(
    gateway.id,
    userId,
    'dns_records',
    dnsRecordsDomain.render(next, [])
  )
  return finishRecord(gateway, userId, perchId, outcome.issues, input.apply)
}

export async function deleteDnsRecord(
  gatewayId: number,
  userId: number,
  perchId: string,
  options: { apply?: boolean } = {}
) {
  const gateway = await findGateway(gatewayId)
  const { states } = await loadSections(gateway.id)
  const row = states.find((s) => s.perchId === perchId)
  const existing = row ? recordOf(row) : null
  if (!row || !existing) throw planeError(404, 'dns_record_not_found', `No DNS record ${perchId}.`)
  await checkRecordPin(gateway, existing, null)
  const outcome = await editSections(gateway.id, userId, 'dns_records', [{ op: 'delete', perchId }])
  const { apply, applyError } = await applyNow(
    gateway,
    userId,
    outcome.deleted.includes(perchId) ? [] : [perchId],
    options.apply !== false
  )
  return { object: null, issues: outcome.issues, apply, applyError }
}

async function finishRecord(
  gateway: Gateway,
  userId: number,
  perchId: string,
  issues: Issue[],
  wanted: boolean | undefined
) {
  const { apply, applyError } = await applyNow(gateway, userId, [perchId], wanted !== false)
  const reloaded = await loadSections(gateway.id)
  const row = reloaded.states.find((s) => s.perchId === perchId)
  return { object: row ? recordView(row) : null, issues, apply, applyError }
}

// ── label names (README 7.10: review) ────────────────────────────────────

export type PendingLabelName = {
  mac: string
  label: string
  slug: string
  current: string | null
  perchId: string | null
  /** Why it cannot be applied: a reserved name, or the router owns the device's host entry. */
  blocked: 'reserved' | 'router_owned' | null
}

/**
 * Device labels whose DNS name (a slug of the label) differs from the name
 * the device's host entry has, for devices the gateway knows (a lease or a
 * host entry). A slug another host or record uses gets `-2`, `-3`, ….
 */
export async function pendingLabelNames(
  gateway: Gateway,
  statesIn?: SectionState[]
): Promise<PendingLabelName[]> {
  const states = statesIn ?? (await loadStates(gateway.id))
  const leases = await GatewayHost.query()
    .where('collector_id', gateway.collectorId ?? 0)
    .select('mac')
  const known = new Set(leases.map((l) => l.mac.toLowerCase()))
  for (const s of states) {
    const h = hostOf(s)
    for (const m of h?.macs ?? []) known.add(m)
  }
  const reserved = reservedNames(gateway)
  const out: PendingLabelName[] = []
  const claimed = new Set<string>()
  for (const label of await listDeviceLabels()) {
    const mac = label.mac.toLowerCase()
    if (!label.name || !known.has(mac)) continue
    const base = slugifyLabel(label.name)
    if (!base) continue
    const hosts = hostsForMac(states, mac)
    const own = hosts.find((s) => s.scope === 'synced') ?? null
    const foreign = !own && hosts.length > 0
    const current = own
      ? (hostOf(own)?.name ?? null)
      : foreign
        ? (hostOf(hosts[0])?.name ?? null)
        : null
    if (current === base) continue
    const taken = takenNames(states, own?.perchId ?? null)
    let slug = base
    for (let n = 2; (taken.has(slug) || claimed.has(slug)) && n < 100; n++) {
      slug = `${base.slice(0, 60)}-${n}`
    }
    if (current === slug) continue
    claimed.add(slug)
    out.push({
      mac,
      label: label.name,
      slug,
      current,
      perchId: own?.perchId ?? null,
      blocked: isReservedName(base, reserved) ? 'reserved' : foreign ? 'router_owned' : null,
    })
  }
  return out.sort((a, b) => a.mac.localeCompare(b.mac))
}

/** `POST /gateways/:id/dns/label-names/apply {macs?}`: the admin approves (some of) the list. */
export async function applyLabelNames(
  gatewayId: number,
  userId: number,
  input: { macs?: string[]; apply?: boolean }
) {
  const gateway = await findGateway(gatewayId)
  if (gateway.dnsLabelNames === 'off') {
    throw planeError(409, 'dns_label_names_off', 'Label names in DNS are switched off.')
  }
  const { states } = await loadSections(gateway.id)
  const wanted = input.macs ? new Set(input.macs.map((m) => m.toLowerCase())) : null
  const all = await pendingLabelNames(gateway, states)
  const pending = all.filter((p) => p.blocked === null && (!wanted || wanted.has(p.mac)))
  if (pending.length === 0) throw planeError(409, 'nothing_to_apply', 'No label names to apply.')
  const edits: SectionEdit[] = []
  for (const p of pending) {
    const own = p.perchId ? states.find((s) => s.perchId === p.perchId) : null
    const current = own ? hostOf(own) : null
    const obj: DhcpReservation = current
      ? { ...current, name: p.slug }
      : {
          perchId: null,
          section: '',
          macs: [p.mac],
          macForm: 'string',
          ip: null,
          name: p.slug,
          dns: null,
          leasetime: null,
          extra: {},
          secretNames: [],
          macRaw: null,
        }
    edits.push(...dhcpHostsDomain.render(obj, own ? asSynced(own) : []))
  }
  const outcome = await editSections(gateway.id, userId, 'dhcp_hosts', edits)
  const perchIds = [
    ...pending.map((p) => p.perchId).filter((id): id is string => id !== null),
    ...outcome.perchIds,
  ]
  const { apply, applyError } = await applyNow(
    gateway,
    userId,
    [...new Set(perchIds)],
    input.apply !== false
  )
  return { applied: pending, issues: outcome.issues, apply, applyError }
}
