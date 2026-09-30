import GatewayApply from '#models/gateway_apply'
import GatewayWireguardPeer from '#models/gateway_wireguard_peer'
import type User from '#models/user'
import { normalizeMac } from '#services/device_labels'
import { itemsOf } from '#services/gateway_config/canonical'
import {
  keptSecrets,
  secretStateOf,
  secretsTravelSecurely,
  stageSecret,
  storeStagedSecrets,
  type SecretState,
  type StagedSecret,
} from '#services/gateway_config/controller_secrets'
import type { SecretEdit, SectionEdit } from '#services/gateway_config/domain'
import { FIREWALL_DOMAIN_KEY, wanZones, zonesOf } from '#services/gateway_config/domains/firewall'
import {
  flagOf,
  parsePrefix,
  scalarOption,
  withOptions,
} from '#services/gateway_config/domains/verbatim'
import {
  interfaceOfPeerType,
  isWgKey,
  peerTypeOf,
  prefixesOf,
  roleOf,
  WIREGUARD_KEY,
  WIREGUARD_PACKAGES,
  wireguardDomain,
} from '#services/gateway_config/domains/wireguard'
import { planeError } from '#services/gateway_config/errors'
import { recordGatewayEvent } from '#services/gateway_config/events'
import { networkZoneEdits } from '#services/gateway_config/firewall_service'
import {
  editDomainSections,
  findGateway,
  type DomainEditBatch,
} from '#services/gateway_config/gateway_config_service'
import { normalizeMode } from '#services/gateway_config/gateway_registry'
import { loadSections } from '#services/gateway_config/gateway_store'
import { getGatewaySyncSettings } from '#services/gateway_config/gateway_sync_settings'
import {
  applyNow,
  contentOf,
  requireManaged,
  requireSynced,
  sectionsOf,
  syncOf,
  type SyncInfo,
  type WriteResult,
} from '#services/gateway_config/native_common'
import { readObservedFacts } from '#services/gateway_config/observed_facts'
import type { SectionState } from '#services/gateway_config/sync_engine'
import { configAllowed, hasFeature, type UciOptions } from '#services/gateway_config/types'
import {
  clientConfigText,
  wgKeyPair,
  wgPresharedKey,
} from '#services/gateway_config/wireguard_keys'
import hash from '@adonisjs/core/services/hash'
import { DateTime } from 'luxon'
import { randomBytes } from 'node:crypto'

/**
 * The WireGuard REST layer (docs/design/gateway-sync/rest.md 4, domains.md 4,
 * README 5.2). Interfaces and their peers on the gateway; a new interface's
 * private key is generated on the router (`$generate`, feature
 * `config.generate.wg_key`) unless an admin pastes a provider's key (TLS
 * only). A peer is remote access into the LAN: creating one (or an
 * interface) needs the admin's password when Settings → Gateway sync
 * `wgStepUp` is on. "Generate keys" for a peer makes a client key pair in
 * memory and returns the wg-quick config once: the private key is never
 * stored, logged or sent to the router, and nothing can return the config
 * again (`client_config_issued_at` records that it was handed out).
 */

export type DeviceRef = { mac: string; name: string | null }

export type WgPeerView = {
  id: string
  interface: string
  label: string | null
  publicKey: string
  presharedKey: SecretState
  allowedIps: string[]
  routeAllowedIps: boolean
  endpoint: { host: string; port: number } | null
  keepalive: number | null
  device: DeviceRef | null
  clientConfigIssuedAt: string | null
  live: {
    endpoint: string | null
    latestHandshakeAt: string | null
    online: boolean
    rxBytes: number
    txBytes: number
  } | null
  extra: Record<string, string | string[]>
  sync: SyncInfo
}

export type WgInterfaceView = {
  id: string
  network: string
  role: 'server' | 'client' | 'site'
  enabled: boolean
  publicKey: string | null
  privateKey: SecretState & { generatedOnRouter: boolean | null }
  listenPort: number | null
  addresses: string[]
  mtu: number | null
  zone: string | null
  portOpen: { rule: string; zones: string[] } | null
  management: boolean
  peers: WgPeerView[]
  live: { up: boolean; observedAt: string } | null
  extra: Record<string, string | string[]>
  sync: SyncInfo
}

export type WgOverview = {
  gatewayId: number
  available: boolean
  unavailableReason: 'capability_missing' | 'not_installed' | 'router_access' | 'not_managed' | null
  installPackages: string[]
  canGenerateKeys: boolean
  secureTransport: boolean
  interfaces: WgInterfaceView[]
  orphanPeers: Array<{ perchId: string; section: string; type: string }>
}

export type WgClientConfig = { text: string; filename: string }

const INTERFACE_MODELED = new Set([
  'proto',
  'private_key',
  'listen_port',
  'addresses',
  'mtu',
  'disabled',
])
const PEER_MODELED = new Set([
  'public_key',
  'preshared_key',
  'description',
  'allowed_ips',
  'route_allowed_ips',
  'endpoint_host',
  'endpoint_port',
  'persistent_keepalive',
])
const NETWORK_NAME = /^[a-z][a-z0-9_]{0,14}$/
const DEFAULT_PORT = 51820

function extraOf(options: UciOptions, modeled: Set<string>): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(options)
      .filter(([k]) => !modeled.has(k))
      .map(([k, v]) => [k, Array.isArray(v) ? [...v] : v])
  )
}

function num(value: string | null): number | null {
  return value !== null && /^\d+$/.test(value.trim()) ? Number(value) : null
}

async function context(gatewayId: number) {
  const gateway = await findGateway(gatewayId)
  const { states } = await loadSections(gateway.id)
  const facts = await readObservedFacts(gateway.collectorId)
  const settings = await getGatewaySyncSettings()
  const meta = await GatewayWireguardPeer.query().where('gateway_id', gateway.id)
  return { gateway, states, facts, settings, meta }
}

type Ctx = Awaited<ReturnType<typeof context>>

function interfaceRows(states: SectionState[]): SectionState[] {
  return sectionsOf(states, 'network', ['interface']).filter((s) => {
    const c = contentOf(s) ?? s.router
    return c !== null && scalarOption(c.options, 'proto') === 'wireguard'
  })
}

function peerRows(states: SectionState[], iface: string): SectionState[] {
  return sectionsOf(states, 'network', [peerTypeOf(iface)])
}

function optionsOf(row: SectionState): UciOptions {
  return (contentOf(row) ?? row.router)!.options
}

function isInstalled(ctx: Ctx): boolean {
  const packages = (ctx.gateway.capabilities?.packages ?? {}) as Record<string, string>
  return 'wireguard-tools' in packages || interfaceRows(ctx.states).length > 0
}

function unavailable(ctx: Ctx): WgOverview['unavailableReason'] {
  if (normalizeMode(ctx.gateway.mode) !== 'managed') return 'not_managed'
  if (wireguardDomain.requires!(ctx.gateway.capabilities ?? {})) return 'capability_missing'
  if (!isInstalled(ctx)) return 'not_installed'
  if (!configAllowed(ctx.gateway.capabilities, 'network')) return 'router_access'
  return null
}

/** The public key the router has for an interface: observed, else the last apply's `generated`. */
async function publicKeyOf(ctx: Ctx, iface: string): Promise<string | null> {
  const live = ctx.facts.wireguard?.interfaces.find((i) => i.network === iface || i.name === iface)
  if (live?.publicKey) return live.publicKey
  const applies = await GatewayApply.query()
    .where('gateway_id', ctx.gateway.id)
    .whereNotNull('outcome')
    .orderBy('id', 'desc')
    .limit(50)
  for (const apply of applies) {
    const generated = (apply.outcome?.generated ?? []) as Array<{
      config: string
      section: string
      publicKey: string
    }>
    const hit = generated.find((g) => g.config === 'network' && g.section === iface)
    if (hit && ['confirmed', 'applied'].includes(apply.state)) return hit.publicKey
  }
  return null
}

function zoneInfos(states: SectionState[]) {
  return zonesOf(
    sectionsOf(states, 'firewall', ['zone']).map((s) => ({ type: 'zone', options: optionsOf(s) }))
  )
}

/** The Perch rule that opens an interface's port toward the WAN zones. */
function portRuleOf(states: SectionState[], iface: string, port: number | null) {
  if (port === null) return null
  return (
    sectionsOf(states, 'firewall', ['rule']).find((s) => {
      const o = optionsOf(s)
      return (
        scalarOption(o, 'target')?.toUpperCase() === 'ACCEPT' &&
        itemsOf(o.proto).join(' ').toLowerCase().includes('udp') &&
        scalarOption(o, 'dest_port') === String(port) &&
        !scalarOption(o, 'dest') &&
        (scalarOption(o, 'name') === portRuleName(iface) || scalarOption(o, 'src') !== null)
      )
    }) ?? null
  )
}

function portRuleName(iface: string): string {
  return `Allow-WireGuard-${iface}`
}

function peerView(ctx: Ctx, iface: string, row: SectionState): WgPeerView {
  const o = optionsOf(row)
  const publicKey = scalarOption(o, 'public_key')?.trim() ?? ''
  const meta = ctx.meta.find((m) => m.interface === iface && m.publicKey === publicKey)
  const live = ctx.facts.wireguard?.interfaces
    .find((i) => i.network === iface || i.name === iface)
    ?.peers.find((p) => p.publicKey === publicKey)
  const handshake = live?.latestHandshake ? live.latestHandshake : null
  const staleSeconds = ctx.settings.wgPeerStaleMinutes * 60
  const host = scalarOption(o, 'endpoint_host')
  const port = num(scalarOption(o, 'endpoint_port'))
  return {
    id: row.perchId,
    interface: iface,
    label: scalarOption(o, 'description'),
    publicKey,
    presharedKey: secretStateOf(row, 'preshared_key'),
    allowedIps: itemsOf(o.allowed_ips)
      .flatMap((v) => v.split(/\s+/))
      .filter(Boolean),
    routeAllowedIps: flagOf(o, 'route_allowed_ips', false),
    endpoint: host ? { host, port: port ?? DEFAULT_PORT } : null,
    keepalive: num(scalarOption(o, 'persistent_keepalive')),
    device: meta?.deviceMac ? { mac: meta.deviceMac, name: null } : null,
    clientConfigIssuedAt:
      meta?.clientConfigIssuedAt?.toUTC().toISO({ suppressMilliseconds: true }) ?? null,
    live: live
      ? {
          endpoint: live.endpoint,
          latestHandshakeAt: handshake
            ? new Date(handshake * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
            : null,
          online: handshake !== null && Date.now() / 1000 - handshake <= staleSeconds,
          rxBytes: live.rxBytes ?? 0,
          txBytes: live.txBytes ?? 0,
        }
      : null,
    extra: extraOf(o, PEER_MODELED),
    sync: syncOf(row),
  }
}

async function interfaceView(ctx: Ctx, row: SectionState): Promise<WgInterfaceView> {
  const o = optionsOf(row)
  const iface = row.name
  const peers = peerRows(ctx.states, iface)
  const zones = zoneInfos(ctx.states)
  const port = num(scalarOption(o, 'listen_port'))
  const rule = portRuleOf(ctx.states, iface, port)
  const content = contentOf(row) ?? row.router
  const slot = content?.secrets?.private_key
  const netifd = ctx.facts.interfaces?.find((i) => i.network === iface)
  return {
    id: row.perchId,
    network: iface,
    role: roleOf(o, peers.map(optionsOf)),
    enabled: !flagOf(o, 'disabled', false),
    publicKey: await publicKeyOf(ctx, iface),
    privateKey: {
      ...secretStateOf(row, 'private_key'),
      // true: generated on the router at Perch's request; false: a key pasted here;
      // null: the router's own (imported, or generated earlier and since adopted).
      generatedOnRouter: slot?.generate ? true : slot?.ref ? false : null,
    },
    listenPort: port,
    addresses: prefixesOf(o.addresses).map((a) => a.text),
    mtu: num(scalarOption(o, 'mtu')),
    zone: zones.find((z) => z.networks.includes(iface))?.name ?? null,
    portOpen: rule
      ? { rule: rule.perchId, zones: [scalarOption(optionsOf(rule), 'src') ?? ''].filter(Boolean) }
      : null,
    management: ctx.gateway.managementPath?.network === iface,
    peers: peers.map((p) => peerView(ctx, iface, p)),
    live:
      ctx.facts.interfaces && ctx.facts.observedAt.interfaces
        ? { up: netifd?.up === true, observedAt: ctx.facts.observedAt.interfaces }
        : null,
    extra: extraOf(o, INTERFACE_MODELED),
    sync: syncOf(row),
  }
}

async function build(ctx: Ctx): Promise<WgOverview> {
  const reason = unavailable(ctx)
  const rows = interfaceRows(ctx.states)
  const names = new Set(rows.map((r) => r.name))
  const orphanPeers = ctx.states
    .filter((s) => {
      const c = contentOf(s) ?? s.router
      const iface = c ? interfaceOfPeerType(c.type) : null
      return s.config === 'network' && iface !== null && !names.has(iface)
    })
    .map((s) => ({ perchId: s.perchId, section: s.name, type: (contentOf(s) ?? s.router)!.type }))
  return {
    gatewayId: ctx.gateway.id,
    available: reason === null,
    unavailableReason: reason,
    installPackages: isInstalled(ctx) ? [] : [...WIREGUARD_PACKAGES],
    canGenerateKeys: hasFeature(ctx.gateway.capabilities, 'config.generate.wg_key'),
    secureTransport: await secretsTravelSecurely(ctx.gateway),
    interfaces: await Promise.all(rows.map((r) => interfaceView(ctx, r))),
    orphanPeers,
  }
}

/** `GET /gateways/:id/wireguard/config`. */
export async function wireguardOverview(gatewayId: number): Promise<WgOverview> {
  return build(await context(gatewayId))
}

async function interfaceViewById(gatewayId: number, perchId: string): Promise<WgInterfaceView> {
  const ctx = await context(gatewayId)
  const row = interfaceRows(ctx.states).find((r) => r.perchId === perchId)
  if (!row) throw planeError(404, 'wg_interface_not_found', 'No such WireGuard interface.')
  return interfaceView(ctx, row)
}

async function peerViewById(gatewayId: number, perchId: string): Promise<WgPeerView> {
  const ctx = await context(gatewayId)
  const row = ctx.states.find((s) => s.perchId === perchId)
  const iface = row ? interfaceOfPeerType((contentOf(row) ?? row.router)?.type ?? '') : null
  if (!row || !iface) throw planeError(404, 'wg_peer_not_found', 'No such WireGuard peer.')
  return peerView(ctx, iface, row)
}

// ── guards ──────────────────────────────────────────────────────────────

function requireWritable(ctx: Ctx) {
  requireManaged(ctx.gateway)
  const reason = unavailable(ctx)
  if (reason === 'capability_missing') {
    throw planeError(
      409,
      'gateway_capability_missing',
      'The gateway agent redacts WireGuard public keys (update perch-collector).',
      { capability: 'config.plain_public_key' }
    )
  }
  if (reason === 'not_installed') {
    throw planeError(409, 'wg_not_installed', 'WireGuard is not installed on the gateway.', {
      packages: [...WIREGUARD_PACKAGES],
    })
  }
  if (reason === 'router_access') {
    throw planeError(
      409,
      'router_access_insufficient',
      'The router does not let Perch write its network config.'
    )
  }
}

async function stepUp(ctx: Ctx, user: User, password: string | undefined) {
  if (!ctx.settings.wgStepUp) return
  const ok = password ? await hash.verify(user.password, password) : false
  if (!ok) throw planeError(403, 'invalid_password', 'Confirm with your current password.')
}

function requireGenerate(ctx: Ctx) {
  if (!hasFeature(ctx.gateway.capabilities, 'config.generate.wg_key')) {
    throw planeError(
      409,
      'gateway_capability_missing',
      'The gateway agent cannot generate WireGuard keys yet (update perch-collector).',
      { capability: 'config.generate.wg_key' }
    )
  }
}

function requireNotManagement(ctx: Ctx, iface: string) {
  if (ctx.gateway.managementPath?.network === iface) {
    throw planeError(
      409,
      'wg_management_path',
      `The controller reaches the router over ${iface}: this would cut it off.`
    )
  }
}

function checkPort(port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw planeError(422, 'wg_port_invalid', 'The listen port is 1–65535.')
  }
}

function checkAddresses(addresses: string[]) {
  for (const a of addresses) {
    if (!a.includes('/') || !parsePrefix(a)) {
      throw planeError(422, 'wg_address_invalid', `"${a}" is not an address with a prefix length.`)
    }
  }
}

function generateEdit(): SecretEdit {
  return { generate: 'wg_private_key', nonce: randomBytes(9).toString('base64url') }
}

// ── interfaces ──────────────────────────────────────────────────────────

export type WgInterfaceCreate = {
  network: string
  role: 'server' | 'client'
  listenPort?: number
  addresses: string[]
  mtu?: number
  zone?: string | null
  createZone?: boolean
  openPort?: boolean
  privateKey?: string
  currentPassword?: string
}

/** `POST /gateways/:id/wireguard/interfaces[?apply=0]`. */
export async function createWgInterface(
  gatewayId: number,
  user: User,
  input: WgInterfaceCreate,
  options: { apply: boolean }
): Promise<WriteResult<WgInterfaceView>> {
  const ctx = await context(gatewayId)
  requireWritable(ctx)
  await stepUp(ctx, user, input.currentPassword)
  if (!NETWORK_NAME.test(input.network)) {
    throw planeError(
      422,
      'network_key_invalid',
      'Network names are lowercase letters, digits and _ (1–15).'
    )
  }
  const taken = ctx.states.some(
    (s) =>
      s.config === 'network' &&
      s.name === input.network &&
      (contentOf(s) ?? s.router)?.type === 'interface'
  )
  if (taken) {
    throw planeError(409, 'network_key_taken', `The router has a network named ${input.network}.`)
  }
  checkAddresses(input.addresses)
  const used = new Set(
    interfaceRows(ctx.states)
      .map((r) => scalarOption(optionsOf(r), 'listen_port'))
      .filter((p): p is string => p !== null)
  )
  let port: number | null = null
  if (input.role === 'server' || input.listenPort !== undefined) {
    port = input.listenPort ?? DEFAULT_PORT
    while (input.listenPort === undefined && used.has(String(port))) port++
    checkPort(port)
    if (used.has(String(port))) {
      throw planeError(422, 'wg_port_in_use', `Port ${port} is another WireGuard interface's.`)
    }
  }

  const staged: StagedSecret[] = []
  let privateKey: SecretEdit
  if (input.privateKey) {
    if (!isWgKey(input.privateKey)) {
      throw planeError(
        422,
        'wg_private_key_invalid',
        'A private key is 44 characters of base64 (32 bytes).'
      )
    }
    const s = await stageSecret(
      ctx.gateway,
      { config: 'network', section: input.network, option: 'private_key' },
      input.privateKey.trim(),
      'Private keys'
    )
    privateKey = s.edit
    staged.push(s.staged)
  } else {
    requireGenerate(ctx)
    privateKey = generateEdit()
  }

  const ifaceOptions: UciOptions = { proto: 'wireguard', addresses: [...input.addresses] }
  if (port !== null) ifaceOptions.listen_port = String(port)
  if (input.mtu) ifaceOptions.mtu = String(input.mtu)
  const batches: DomainEditBatch[] = [
    {
      domain: WIREGUARD_KEY,
      edits: [
        {
          op: 'put',
          perchId: null,
          config: 'network',
          type: 'interface',
          name: input.network,
          options: ifaceOptions,
          secrets: { private_key: privateKey },
        },
      ],
    },
  ]
  const firewall = firewallEditsFor(ctx, input.network, {
    zone: input.createZone ? 'vpn' : input.zone,
    createZone: input.createZone === true,
    openPort: input.openPort === true && port !== null ? port : null,
  })
  if (firewall.length > 0) batches.push({ domain: FIREWALL_DOMAIN_KEY, edits: firewall })
  await storeStagedSecrets(ctx.gateway.id, staged)
  const outcome = await editDomainSections(ctx.gateway.id, user.id, batches)
  const touched = outcome.batches.flatMap((b) => b.perchIds)
  const id = outcome.batches[0].perchIds[0]
  const { apply, applyError } = await applyNow(ctx.gateway, user.id, touched, options.apply)
  return {
    gatewayId: ctx.gateway.id,
    object: await interfaceViewById(ctx.gateway.id, id),
    issues: outcome.issues,
    apply,
    applyError,
  }
}

/** Zone membership (an existing zone, or a new `vpn` zone forwarding to the LAN), and the port rule. */
function firewallEditsFor(
  ctx: Ctx,
  iface: string,
  want: { zone?: string | null; createZone: boolean; openPort: number | null }
): SectionEdit[] {
  const edits: SectionEdit[] = []
  if (want.zone !== undefined && want.zone !== null) {
    edits.push(
      ...networkZoneEdits(ctx.states, {
        network: iface,
        purpose: 'lan',
        zone: want.zone,
        createZone: want.createZone,
      })
    )
    if (want.createZone) {
      edits.push({
        op: 'put',
        perchId: null,
        config: 'firewall',
        type: 'forwarding',
        options: { src: want.zone, dest: 'lan' },
      })
    }
  }
  if (want.openPort !== null && !portRuleOf(ctx.states, iface, want.openPort)) {
    const src = wanZones(zoneInfos(ctx.states))[0] ?? 'wan'
    edits.push({
      op: 'put',
      perchId: null,
      config: 'firewall',
      type: 'rule',
      options: {
        name: portRuleName(iface),
        src,
        proto: 'udp',
        dest_port: String(want.openPort),
        target: 'ACCEPT',
      },
    })
  }
  return edits
}

function findInterface(ctx: Ctx, perchId: string): SectionState {
  const row = interfaceRows(ctx.states).find((r) => r.perchId === perchId)
  if (!row) throw planeError(404, 'wg_interface_not_found', 'No such WireGuard interface.')
  return row
}

export type WgInterfacePatch = {
  enabled?: boolean
  listenPort?: number | null
  addresses?: string[]
  mtu?: number | null
  openPort?: boolean
}

/** `PATCH /gateways/:id/wireguard/interfaces/:perchId[?apply=0]`. */
export async function updateWgInterface(
  gatewayId: number,
  userId: number,
  perchId: string,
  patch: WgInterfacePatch,
  options: { apply: boolean }
): Promise<WriteResult<WgInterfaceView>> {
  const ctx = await context(gatewayId)
  requireWritable(ctx)
  const row = findInterface(ctx, perchId)
  requireSynced(row, 'This WireGuard interface')
  if (patch.enabled === false) requireNotManagement(ctx, row.name)
  if (patch.addresses) checkAddresses(patch.addresses)
  if (patch.listenPort !== undefined && patch.listenPort !== null) checkPort(patch.listenPort)
  const content = contentOf(row)!
  const optionsAfter = withOptions(content.options, {
    disabled: patch.enabled === undefined ? undefined : patch.enabled ? null : '1',
    listen_port:
      patch.listenPort === undefined
        ? undefined
        : patch.listenPort === null
          ? null
          : String(patch.listenPort),
    addresses: patch.addresses,
    mtu: patch.mtu === undefined ? undefined : patch.mtu === null ? null : String(patch.mtu),
  })
  const batches: DomainEditBatch[] = [
    {
      domain: WIREGUARD_KEY,
      edits: [
        {
          op: 'put',
          perchId: row.perchId,
          config: 'network',
          type: 'interface',
          options: optionsAfter,
          secrets: keptSecrets(row),
        },
      ],
    },
  ]
  const port = num(scalarOption(optionsAfter, 'listen_port'))
  const oldPort = num(scalarOption(content.options, 'listen_port'))
  const rule = portRuleOf(ctx.states, row.name, oldPort)
  const fw: SectionEdit[] = []
  if (patch.openPort === true && port !== null && !rule) {
    fw.push(...firewallEditsFor(ctx, row.name, { createZone: false, openPort: port }))
  } else if (rule && (patch.openPort === false || port === null)) {
    fw.push({ op: 'delete', perchId: rule.perchId })
  } else if (rule && port !== null && port !== oldPort && rule.scope === 'synced') {
    fw.push({
      op: 'put',
      perchId: rule.perchId,
      config: 'firewall',
      type: 'rule',
      options: withOptions(optionsOf(rule), { dest_port: String(port) }),
    })
  }
  if (fw.length > 0) batches.push({ domain: FIREWALL_DOMAIN_KEY, edits: fw })
  const outcome = await editDomainSections(ctx.gateway.id, userId, batches)
  const touched = [
    ...new Set([row.perchId, ...outcome.batches.flatMap((b) => [...b.perchIds, ...b.deleted])]),
  ]
  const { apply, applyError } = await applyNow(ctx.gateway, userId, touched, options.apply)
  return {
    gatewayId: ctx.gateway.id,
    object: await interfaceViewById(ctx.gateway.id, row.perchId),
    issues: outcome.issues,
    apply,
    applyError,
  }
}

/** `DELETE /gateways/:id/wireguard/interfaces/:perchId[?apply=0]` `{ confirm }` = its network name. */
export async function deleteWgInterface(
  gatewayId: number,
  userId: number,
  perchId: string,
  confirm: string,
  options: { apply: boolean }
): Promise<WriteResult<null>> {
  const ctx = await context(gatewayId)
  requireWritable(ctx)
  const row = findInterface(ctx, perchId)
  requireSynced(row, 'This WireGuard interface')
  requireNotManagement(ctx, row.name)
  if (confirm.trim() !== row.name) {
    throw planeError(422, 'confirm_mismatch', `Type the network's name (${row.name}) exactly.`)
  }
  const peers = peerRows(ctx.states, row.name).filter((p) => p.scope === 'synced')
  const batches: DomainEditBatch[] = [
    {
      domain: WIREGUARD_KEY,
      edits: [row, ...peers].map((s) => ({ op: 'delete' as const, perchId: s.perchId })),
    },
  ]
  const fw: SectionEdit[] = []
  const rule = portRuleOf(ctx.states, row.name, num(scalarOption(optionsOf(row), 'listen_port')))
  if (rule && rule.scope === 'synced') fw.push({ op: 'delete', perchId: rule.perchId })
  const zone = zoneInfos(ctx.states).find((z) => z.networks.includes(row.name))
  if (zone) {
    try {
      fw.push(...networkZoneEdits(ctx.states, { network: row.name, purpose: 'lan', zone: null }))
    } catch {
      // A zone Perch does not sync keeps listing it (harmless: the network is gone).
    }
  }
  if (fw.length > 0) batches.push({ domain: FIREWALL_DOMAIN_KEY, edits: fw })
  const outcome = await editDomainSections(ctx.gateway.id, userId, batches)
  await GatewayWireguardPeer.query()
    .where('gateway_id', ctx.gateway.id)
    .where('interface', row.name)
    .delete()
  const touched = [...new Set(outcome.batches.flatMap((b) => [...b.perchIds, ...b.deleted]))]
  const { apply, applyError } = await applyNow(ctx.gateway, userId, touched, options.apply)
  return { gatewayId: ctx.gateway.id, object: null, issues: outcome.issues, apply, applyError }
}

/** `POST /gateways/:id/wireguard/interfaces/:perchId/rotate-key[?apply=0]`. */
export async function rotateWgKey(
  gatewayId: number,
  user: User,
  perchId: string,
  body: { confirm: string; currentPassword?: string },
  options: { apply: boolean }
): Promise<WriteResult<WgInterfaceView>> {
  const ctx = await context(gatewayId)
  requireWritable(ctx)
  const row = findInterface(ctx, perchId)
  requireSynced(row, 'This WireGuard interface')
  await stepUp(ctx, user, body.currentPassword)
  requireNotManagement(ctx, row.name)
  requireGenerate(ctx)
  if (body.confirm.trim() !== row.name) {
    throw planeError(422, 'confirm_mismatch', `Type the network's name (${row.name}) exactly.`)
  }
  const content = contentOf(row)!
  const outcome = await editDomainSections(ctx.gateway.id, user.id, [
    {
      domain: WIREGUARD_KEY,
      edits: [
        {
          op: 'put',
          perchId: row.perchId,
          config: 'network',
          type: 'interface',
          options: { ...content.options },
          secrets: { ...keptSecrets(row, ['private_key']), private_key: generateEdit() },
        },
      ],
    },
  ])
  await recordGatewayEvent(ctx.gateway.id, 'wg_key_rotated', {
    userId: user.id,
    detail: { interface: row.name, perchId: row.perchId },
  })
  const { apply, applyError } = await applyNow(ctx.gateway, user.id, [row.perchId], options.apply)
  return {
    gatewayId: ctx.gateway.id,
    object: await interfaceViewById(ctx.gateway.id, row.perchId),
    issues: outcome.issues,
    apply,
    applyError,
  }
}

// ── peers ───────────────────────────────────────────────────────────────

export type WgPeerCreate = {
  label: string
  publicKey?: string
  generateKeys?: boolean
  presharedKey?: 'generate' | 'none'
  allowedIps?: string[]
  endpoint?: { host: string; port: number }
  keepalive?: number
  routeAllowedIps?: boolean
  deviceMac?: string
  client?: { dns?: string[]; allowedIps?: string[]; endpointHost?: string }
  currentPassword?: string
}

/** The next free host address in each of the interface's subnets (/32 and /128). */
function nextFreeAddresses(ctx: Ctx, iface: string, ifaceOptions: UciOptions): string[] {
  const taken = new Set<string>()
  for (const p of prefixesOf(ifaceOptions.addresses)) if (p.prefix) taken.add(p.prefix.address)
  for (const peer of peerRows(ctx.states, iface)) {
    for (const p of prefixesOf(optionsOf(peer).allowed_ips))
      if (p.prefix) taken.add(p.prefix.address)
  }
  const out: string[] = []
  for (const a of prefixesOf(ifaceOptions.addresses)) {
    if (!a.prefix) continue
    if (a.prefix.family === 4) {
      const base = a.prefix.address.split('.').reduce((acc, x) => acc * 256 + Number(x), 0) >>> 0
      const size = 2 ** (32 - a.prefix.prefix)
      const start = (base & ~(size - 1)) >>> 0
      for (let i = 1; i < size - 1; i++) {
        const n = (start + i) >>> 0
        const ip = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
        if (!taken.has(ip)) {
          out.push(`${ip}/32`)
          break
        }
      }
    }
  }
  return out
}

/** Where a client dials: the setting's host, else the WAN address, with the interface's port. */
function clientEndpoint(ctx: Ctx, port: number | null, host?: string): string {
  const wan = ctx.facts.interfaces
    ?.filter((i) => i.up && i.defaultRoute)
    .sort((a, b) => (a.metric ?? 0) - (b.metric ?? 0))[0]
  const address = host ?? wan?.ipv4[0]?.split('/')[0] ?? 'YOUR-ROUTER-ADDRESS'
  return `${address}:${port ?? DEFAULT_PORT}`
}

/** LAN-side IPv4 subnets (what a client routes into the tunnel by default). */
function lanSubnets(ctx: Ctx): string[] {
  const out: string[] = []
  for (const s of sectionsOf(ctx.states, 'network', ['interface'])) {
    const o = optionsOf(s)
    const proto = scalarOption(o, 'proto')
    const ip = scalarOption(o, 'ipaddr')
    const mask = scalarOption(o, 'netmask')
    if (proto !== 'static' || !ip || s.name === 'loopback') continue
    const cidr = ip.includes('/') ? ip : mask ? `${ip}/${maskToBits(mask)}` : `${ip}/24`
    const p = parsePrefix(cidr)
    if (!p || p.family !== 4) continue
    const base = p.address.split('.').reduce((acc, x) => acc * 256 + Number(x), 0) >>> 0
    const netmask = p.prefix === 0 ? 0 : (0xffffffff << (32 - p.prefix)) >>> 0
    const n = (base & netmask) >>> 0
    out.push(`${[n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')}/${p.prefix}`)
  }
  return out
}

function maskToBits(mask: string): number {
  const n = mask.split('.').reduce((acc, x) => acc * 256 + Number(x), 0) >>> 0
  let bits = 0
  while (bits < 32 && (n & (0x80000000 >>> bits)) !== 0) bits++
  return bits
}

/** `POST /gateways/:id/wireguard/interfaces/:perchId/peers[?apply=0]`. */
export async function createWgPeer(
  gatewayId: number,
  user: User,
  interfaceId: string,
  input: WgPeerCreate,
  options: { apply: boolean }
): Promise<WriteResult<WgPeerView> & { clientConfig: WgClientConfig | null }> {
  const ctx = await context(gatewayId)
  requireWritable(ctx)
  const row = findInterface(ctx, interfaceId)
  requireSynced(row, 'This WireGuard interface')
  await stepUp(ctx, user, input.currentPassword)
  if (Boolean(input.publicKey) === Boolean(input.generateKeys)) {
    throw planeError(
      422,
      'wg_keys_choice',
      'Paste the peer’s public key or let Perch generate its keys (one of the two).'
    )
  }
  const iface = row.name
  const ifaceOptions = optionsOf(row)
  const secure = await secretsTravelSecurely(ctx.gateway)
  const psk = input.presharedKey ?? (secure ? 'generate' : 'none')
  if (psk === 'generate' && !secure) {
    throw planeError(
      409,
      'insecure_transport',
      'Preshared keys go to the router only over verified TLS.'
    )
  }
  let serverPublicKey: string | null = null
  let pair: { privateKey: string; publicKey: string } | null = null
  if (input.generateKeys) {
    serverPublicKey = await publicKeyOf(ctx, iface)
    if (!serverPublicKey) {
      throw planeError(
        409,
        'wg_public_key_unknown',
        'The router has not reported this interface’s public key yet: apply the interface first.'
      )
    }
    pair = wgKeyPair()
  }
  const publicKey = (input.publicKey ?? pair!.publicKey).trim()
  if (!isWgKey(publicKey)) {
    throw planeError(
      422,
      'wg_public_key_invalid',
      'A public key is 44 characters of base64 (32 bytes).'
    )
  }
  const exists = peerRows(ctx.states, iface).find(
    (p) => scalarOption(optionsOf(p), 'public_key')?.trim() === publicKey
  )
  if (exists)
    throw planeError(409, 'wg_peer_exists', 'That key is already a peer of this interface.', {
      id: exists.perchId,
    })
  const allowedIps = input.allowedIps ?? nextFreeAddresses(ctx, iface, ifaceOptions)
  if (allowedIps.length === 0) {
    throw planeError(
      422,
      'wg_allowed_ips_invalid',
      'No free address left in the interface’s subnet: give allowedIps.'
    )
  }
  for (const a of allowedIps) {
    if (!parsePrefix(a))
      throw planeError(422, 'wg_allowed_ips_invalid', `"${a}" is not an address or prefix.`)
  }
  const mac = input.deviceMac ? normalizeMac(input.deviceMac) : null
  if (input.deviceMac && !mac)
    throw planeError(400, 'invalid_mac', `"${input.deviceMac}" is not a MAC address.`)

  const name = `perch_wg${randomBytes(4).toString('hex')}`
  const peerOptions: UciOptions = {
    public_key: publicKey,
    description: input.label,
    allowed_ips: [...allowedIps],
    route_allowed_ips: input.routeAllowedIps === false ? '0' : '1',
  }
  if (input.endpoint) {
    peerOptions.endpoint_host = input.endpoint.host
    peerOptions.endpoint_port = String(input.endpoint.port)
  }
  if (input.keepalive) peerOptions.persistent_keepalive = String(input.keepalive)
  const staged: StagedSecret[] = []
  const secrets: Record<string, SecretEdit> = {}
  let presharedKey: string | null = null
  if (psk === 'generate') {
    presharedKey = wgPresharedKey()
    const s = await stageSecret(
      ctx.gateway,
      { config: 'network', section: name, option: 'preshared_key' },
      presharedKey,
      'Preshared keys'
    )
    secrets.preshared_key = s.edit
    staged.push(s.staged)
  }
  await storeStagedSecrets(ctx.gateway.id, staged)
  const outcome = await editDomainSections(ctx.gateway.id, user.id, [
    {
      domain: WIREGUARD_KEY,
      edits: [
        {
          op: 'put',
          perchId: null,
          config: 'network',
          type: peerTypeOf(iface),
          name,
          options: peerOptions,
          ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
        },
      ],
    },
  ])
  const id = outcome.batches[0].perchIds[0]
  const now = DateTime.utc()
  await GatewayWireguardPeer.updateOrCreate(
    { gatewayId: ctx.gateway.id, interface: iface, publicKey },
    {
      peerPerchId: id,
      deviceMac: mac,
      createdByUserId: user.id,
      clientConfigIssuedAt: pair ? now : null,
    }
  )
  let clientConfig: WgClientConfig | null = null
  if (pair) {
    const port = num(scalarOption(ifaceOptions, 'listen_port'))
    const routerAddress = prefixesOf(ifaceOptions.addresses)
      .map((a) => a.prefix)
      .find((p) => p?.family === 4)?.address
    clientConfig = {
      filename: `${iface}-${input.label.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 32) || 'peer'}.conf`,
      text: clientConfigText({
        privateKey: pair.privateKey,
        addresses: allowedIps,
        dns: input.client?.dns ?? (routerAddress ? [routerAddress] : []),
        serverPublicKey: serverPublicKey!,
        presharedKey,
        endpoint: clientEndpoint(ctx, port, input.client?.endpointHost),
        allowedIps: input.client?.allowedIps ?? [
          ...lanSubnets(ctx),
          ...prefixesOf(ifaceOptions.addresses).map((a) => a.text),
        ],
        keepalive: 25,
      }),
    }
    await recordGatewayEvent(ctx.gateway.id, 'wg_client_config_issued', {
      userId: user.id,
      detail: { interface: iface, publicKey, label: input.label },
    })
  }
  const { apply, applyError } = await applyNow(ctx.gateway, user.id, [id], options.apply)
  return {
    gatewayId: ctx.gateway.id,
    object: await peerViewById(ctx.gateway.id, id),
    issues: outcome.issues,
    apply,
    applyError,
    clientConfig,
  }
}

function findPeer(ctx: Ctx, perchId: string): { row: SectionState; iface: string } {
  const row = ctx.states.find((s) => s.perchId === perchId)
  const iface = row ? interfaceOfPeerType((contentOf(row) ?? row.router)?.type ?? '') : null
  if (!row || !iface) throw planeError(404, 'wg_peer_not_found', 'No such WireGuard peer.')
  return { row, iface }
}

export type WgPeerPatch = {
  label?: string
  allowedIps?: string[]
  endpoint?: { host: string; port: number } | null
  keepalive?: number | null
  routeAllowedIps?: boolean
  deviceMac?: string | null
}

/** `PATCH /gateways/:id/wireguard/peers/:perchId[?apply=0]`. */
export async function updateWgPeer(
  gatewayId: number,
  userId: number,
  perchId: string,
  patch: WgPeerPatch,
  options: { apply: boolean }
): Promise<WriteResult<WgPeerView>> {
  const ctx = await context(gatewayId)
  requireWritable(ctx)
  const { row, iface } = findPeer(ctx, perchId)
  requireSynced(row, 'This WireGuard peer')
  for (const a of patch.allowedIps ?? []) {
    if (!parsePrefix(a))
      throw planeError(422, 'wg_allowed_ips_invalid', `"${a}" is not an address or prefix.`)
  }
  const content = contentOf(row)!
  const optionsAfter = withOptions(content.options, {
    description: patch.label,
    allowed_ips: patch.allowedIps,
    endpoint_host: patch.endpoint === undefined ? undefined : (patch.endpoint?.host ?? null),
    endpoint_port:
      patch.endpoint === undefined
        ? undefined
        : patch.endpoint
          ? String(patch.endpoint.port)
          : null,
    persistent_keepalive:
      patch.keepalive === undefined ? undefined : patch.keepalive ? String(patch.keepalive) : null,
    route_allowed_ips:
      patch.routeAllowedIps === undefined ? undefined : patch.routeAllowedIps ? '1' : '0',
  })
  const outcome = await editDomainSections(ctx.gateway.id, userId, [
    {
      domain: WIREGUARD_KEY,
      edits: [
        {
          op: 'put',
          perchId: row.perchId,
          config: 'network',
          type: content.type,
          options: optionsAfter,
          secrets: keptSecrets(row),
        },
      ],
    },
  ])
  if (patch.deviceMac !== undefined) {
    const mac = patch.deviceMac ? normalizeMac(patch.deviceMac) : null
    if (patch.deviceMac && !mac)
      throw planeError(400, 'invalid_mac', `"${patch.deviceMac}" is not a MAC address.`)
    const publicKey = scalarOption(content.options, 'public_key')?.trim() ?? ''
    await GatewayWireguardPeer.updateOrCreate(
      { gatewayId: ctx.gateway.id, interface: iface, publicKey },
      { peerPerchId: row.perchId, deviceMac: mac }
    )
  }
  const { apply, applyError } = await applyNow(ctx.gateway, userId, [row.perchId], options.apply)
  return {
    gatewayId: ctx.gateway.id,
    object: await peerViewById(ctx.gateway.id, row.perchId),
    issues: outcome.issues,
    apply,
    applyError,
  }
}

/** `DELETE /gateways/:id/wireguard/peers/:perchId[?apply=0]`. */
export async function deleteWgPeer(
  gatewayId: number,
  userId: number,
  perchId: string,
  options: { apply: boolean }
): Promise<WriteResult<null>> {
  const ctx = await context(gatewayId)
  requireWritable(ctx)
  const { row, iface } = findPeer(ctx, perchId)
  requireSynced(row, 'This WireGuard peer')
  const publicKey = scalarOption(optionsOf(row), 'public_key')?.trim() ?? ''
  const outcome = await editDomainSections(ctx.gateway.id, userId, [
    { domain: WIREGUARD_KEY, edits: [{ op: 'delete', perchId: row.perchId }] },
  ])
  await GatewayWireguardPeer.query()
    .where('gateway_id', ctx.gateway.id)
    .where('interface', iface)
    .where('public_key', publicKey)
    .delete()
  const { apply, applyError } = await applyNow(ctx.gateway, userId, [row.perchId], options.apply)
  return { gatewayId: ctx.gateway.id, object: null, issues: outcome.issues, apply, applyError }
}
